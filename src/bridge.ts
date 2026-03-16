import type { AppConfig } from "./config";
import { BridgeDatabase } from "./db";
import type { TopicLifecycleEvent, TopicSession, UserTurnInput, UserTurnMessage } from "./domain";
import type { ServerNotification } from "./generated/codex/ServerNotification";
import type { ServerRequest } from "./generated/codex/ServerRequest";
import type { RequestId } from "./generated/codex/RequestId";
import type { ThreadItem } from "./generated/codex/v2/ThreadItem";
import type { UserInput } from "./generated/codex/v2/UserInput";
import type { CommandExecutionApprovalDecision } from "./generated/codex/v2/CommandExecutionApprovalDecision";
import type { FileChangeApprovalDecision } from "./generated/codex/v2/FileChangeApprovalDecision";
import type { ToolRequestUserInputResponse } from "./generated/codex/v2/ToolRequestUserInputResponse";
import {
  classifyInterruptError,
  classifySteerError,
  formatError
} from "./bridge/error-handling";
import { TemporaryImageStore } from "./media-store";
import { buildUserInputSignature } from "./bridge/input-signature";
import { getNotificationTurnId } from "./bridge/notifications";
import {
  buildRenderedAssistantMessages,
  buildRenderedCommentaryMessage,
  buildStableDraftId,
  buildStatusDraft,
  buildStatusDraftForItem,
  buildQueuePreviewKeyboard,
  deriveTopicTitle,
  isSameStatusDraft,
  renderQueuePreview,
  renderTelegramAssistantDraft,
  renderTelegramCommentaryDraft,
  renderTelegramStatusDraft,
  type TurnStatusDraft,
  type TurnStatusState
} from "./bridge/presentation";
import { BridgeRequestCoordinator } from "./bridge/request-coordinator";
import {
  TelegramMessenger,
  type TelegramApi,
  type TelegramRenderedMessage,
  type TelegramStatusDraftHandle,
  type TelegramStreamMessageHandle
} from "./telegram-messenger";
import { BridgeTurnRuntime, type AssistantRenderUpdate, type QueueStateSnapshot } from "./turn-runtime";

export type CallbackQueryEvent = {
  callbackQueryId: string;
  data: string;
  chatId: number;
  topicId: number | null;
};

export interface BridgeCodexApi {
  createThread(title: string): Promise<string>;
  ensureThreadLoaded(threadId: string): Promise<void>;
  sendTurn(threadId: string, input: UserInput[]): Promise<{ id: string }>;
  steerTurn(threadId: string, expectedTurnId: string, input: UserInput[]): Promise<{ turnId: string }>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  archiveThread(threadId: string): Promise<void>;
  readTurnMessages(threadId: string, turnId: string): Promise<string>;
  respondToCommandApproval(id: RequestId, response: { decision: CommandExecutionApprovalDecision }): Promise<void>;
  respondToFileChangeApproval(id: RequestId, response: { decision: FileChangeApprovalDecision }): Promise<void>;
  respondToUserInputRequest(id: RequestId, response: ToolRequestUserInputResponse): Promise<void>;
  respondUnsupportedRequest(id: RequestId, message: string): Promise<void>;
  onNotification(listener: (notification: ServerNotification) => void): void;
  onServerRequest(listener: (request: ServerRequest) => void): void;
}

type ActiveTurn = {
  chatId: number;
  topicId: number;
  threadId: string;
  turnId: string;
  statusDraft: TurnStatusDraft | null;
  lastStatusUpdateAt: number;
  lifecycle: "active" | "finalizing";
  statusHandle: TelegramStatusDraftHandle;
  finalStream: TelegramStreamMessageHandle;
  commentaryStreams: Map<string, { handle: TelegramStreamMessageHandle; text: string }>;
};

export class TelegramCodexBridge {
  readonly #runtime = new BridgeTurnRuntime();
  readonly #activeTurns = new Map<string, ActiveTurn>();
  readonly #queuePreviewMessageIds = new Map<string, number>();
  readonly #submitPendingSteersAfterInterrupt = new Set<string>();
  readonly #notificationChains = new Map<string, Promise<void>>();
  readonly #messenger: TelegramMessenger;
  readonly #requestCoordinator: BridgeRequestCoordinator;

  constructor(
    private readonly config: AppConfig,
    private readonly database: BridgeDatabase,
    private readonly telegram: TelegramApi,
    private readonly codex: BridgeCodexApi,
    private readonly mediaStore: TemporaryImageStore
  ) {
    this.#messenger = new TelegramMessenger(telegram);
    this.#requestCoordinator = new BridgeRequestCoordinator(
      config,
      database,
      telegram,
      codex,
      this.updateTurnStatus.bind(this)
    );
    this.codex.onNotification((notification) => {
      void this.enqueueNotification(notification).catch((error) => {
        console.error("Failed to process Codex notification", error);
      });
    });
    this.codex.onServerRequest((request) => {
      void this.handleServerRequest(request).catch((error) => {
        console.error("Failed to process Codex server request", error);
      });
    });
  }

  async handleUserTextMessage(
    message: Omit<UserTurnMessage, "input" | "submittedInputSignature">
  ): Promise<void> {
    await this.handleUserMessage({
      ...message,
      input: [
        {
          type: "text",
          text: message.text,
          text_elements: []
        }
      ]
    });
  }

  async handleUserMessage(message: UserTurnMessage): Promise<void> {
    if (message.chatId !== this.config.telegram.chatId) {
      return;
    }

    if (!this.config.telegram.allowedUserIds.has(message.userId)) {
      return;
    }

    const inserted = await this.database.markUpdateProcessed(message.updateId);
    if (!inserted) {
      return;
    }

    if (message.topicId === null) {
      await this.startSessionFromRootMessage(message);
      return;
    }

    const resolvedPendingInput = await this.tryResolveUserInput(message);
    if (resolvedPendingInput) {
      return;
    }

    if (message.topicId !== null) {
      const session = await this.database.getSessionByTopic(message.chatId, message.topicId);
      if (!session) {
        await this.startSessionInExistingTopic(message);
        return;
      }

      if (!session.codexThreadId) {
        await this.#messenger.sendMessage({
          chatId: message.chatId,
          topicId: message.topicId,
          text: "This topic is still provisioning a Codex session. Try again in a moment."
        });
        return;
      }

      const activeTurn = this.findActiveTurnByTopic(message.chatId, message.topicId);
      if (activeTurn) {
        await this.trySteerTurn(activeTurn, message);
        return;
      }

      await this.sendTurnForSession(session, message);
      return;
    }

    await this.#messenger.sendMessage({
      chatId: message.chatId,
      text: "Could not determine a Telegram topic for this message, so no Codex session was started."
    });
  }

  async handleTopicClosed(event: TopicLifecycleEvent): Promise<void> {
    const session = await this.database.archiveSessionByTopic(event.chatId, event.topicId);
    if (!session?.codexThreadId) {
      return;
    }

    try {
      await this.codex.archiveThread(session.codexThreadId);
    } catch (error) {
      console.error("Failed to archive Codex thread", error);
    }
  }

  async handleCallbackQuery(event: CallbackQueryEvent): Promise<void> {
    if (await this.#requestCoordinator.handleCallbackQuery(event)) {
      return;
    }

    if (event.data.startsWith("turn:")) {
      await this.handleTurnCallbackQuery(event);
      return;
    }

    await this.telegram.answerCallbackQuery(event.callbackQueryId, {
      text: "Unsupported callback."
    });
  }

  private async handleTurnCallbackQuery(event: CallbackQueryEvent): Promise<void> {
    const [, turnId, action] = event.data.split(":");
    if (action !== "sendNow" || !turnId) {
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: "Unsupported callback."
      });
      return;
    }

    if (event.topicId === null) {
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: "This action requires a topic."
      });
      return;
    }

    const activeTurn = this.findActiveTurnByTopic(event.chatId, event.topicId);
    if (!activeTurn || activeTurn.turnId !== turnId) {
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: "This turn is no longer active."
      });
      return;
    }

    const queueState = this.#runtime.getQueueState(event.chatId, event.topicId);
    if (queueState.pendingSteers.length === 0) {
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: "No pending steer instructions to send."
      });
      return;
    }

    this.#submitPendingSteersAfterInterrupt.add(turnId);

    try {
      await this.codex.interruptTurn(activeTurn.threadId, activeTurn.turnId);
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: "Submitting queued steer instructions."
      });
    } catch (error) {
      this.#submitPendingSteersAfterInterrupt.delete(turnId);

      const classification = classifyInterruptError(error);
      if (classification.kind === "stale_or_missing_active_turn") {
        await this.finalizeInterruptedTurn(activeTurn, true);
        await this.telegram.answerCallbackQuery(event.callbackQueryId, {
          text: "Previous turn already ended. Submitting queued steer instructions."
        });
        return;
      }

      console.error("Failed to interrupt turn", error);
      await this.#messenger.sendMessage({
        chatId: event.chatId,
        topicId: event.topicId,
        text: `Failed to interrupt the current turn: ${formatError(error)}`
      });
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: "Failed to interrupt turn."
      });
    }
  }

  private async startSessionFromRootMessage(message: UserTurnMessage): Promise<void> {
    const title = deriveTopicTitle(message.text);
    const forumTopic = await this.telegram.createForumTopic(message.chatId, title);
    await this.startSessionInTopic(
      {
        ...message,
        topicId: forumTopic.message_thread_id
      },
      title,
      `Created session topic "${title}". Continue in the new topic.`
    );
  }

  private async startSessionInExistingTopic(message: UserTurnMessage): Promise<void> {
    if (message.topicId === null) {
      throw new Error("Cannot start an in-topic session without a Telegram topic id");
    }

    const title = deriveTopicTitle(message.text);
    await this.startSessionInTopic(message, title);
  }

  private async startSessionInTopic(
    message: UserTurnMessage,
    title: string,
    lobbyAnnouncement?: string
  ): Promise<void> {
    if (message.topicId === null) {
      throw new Error("Cannot start a session without a Telegram topic id");
    }

    const pending = await this.database.createProvisioningSession({
      telegramChatId: String(message.chatId),
      telegramTopicId: message.topicId,
      rootMessageId: message.messageId,
      createdByUserId: message.userId,
      title
    });

    try {
      const threadId = await this.codex.createThread(title);
      const session = await this.database.activateSession(pending.id, threadId);

      if (lobbyAnnouncement) {
        await this.#messenger.sendMessage({
          chatId: message.chatId,
          text: lobbyAnnouncement
        });
      }

      await this.sendTurnForSession(session, message);
    } catch (error) {
      await this.database.markSessionErrored(pending.id);
      await this.#messenger.sendMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: `Failed to create Codex session for "${title}": ${formatError(error)}`
      });
    }
  }

  private async sendTurnForSession(session: TopicSession, message: UserTurnMessage): Promise<void> {
    if (!session.codexThreadId) {
      throw new Error(`Session ${session.id} has no Codex thread id`);
    }

    if (message.topicId === null) {
      throw new Error("Cannot send a Codex turn without a Telegram topic id");
    }

    await this.codex.ensureThreadLoaded(session.codexThreadId);

    const preparedInput = await this.materializeCodexInput(message);
    let turn: { id: string };
    try {
      turn = await this.codex.sendTurn(session.codexThreadId, preparedInput.input);
    } finally {
      await this.cleanupPreparedCodexInput(preparedInput);
    }

    await this.database.recordTurnStart({
      telegramUpdateId: message.updateId,
      telegramChatId: String(message.chatId),
      telegramTopicId: message.topicId,
      codexThreadId: session.codexThreadId,
      codexTurnId: turn.id,
      draftId: message.updateId
    });

    const activeTurn = this.createActiveTurn(message, session.codexThreadId, turn.id);
    this.#activeTurns.set(turn.id, activeTurn);
    this.#runtime.registerTurn({
      chatId: message.chatId,
      topicId: message.topicId,
      threadId: session.codexThreadId,
      turnId: turn.id
    });
    await activeTurn.statusHandle.set(renderTelegramStatusDraft(activeTurn.statusDraft), true);
  }

  private async enqueueNotification(notification: ServerNotification): Promise<void> {
    const turnId = getNotificationTurnId(notification);
    if (!turnId) {
      await this.handleNotification(notification);
      return;
    }

    const previous = this.#notificationChains.get(turnId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      await this.handleNotification(notification);
    });
    this.#notificationChains.set(turnId, next);

    try {
      await next;
    } finally {
      if (this.#notificationChains.get(turnId) === next) {
        this.#notificationChains.delete(turnId);
      }
    }
  }

  private async handleNotification(notification: ServerNotification): Promise<void> {
    switch (notification.method) {
      case "turn/started": {
        await this.updateTurnStatus(notification.params.turn.id, buildStatusDraft("thinking"));
        return;
      }
      case "item/started": {
        if (notification.params.item.type === "agentMessage") {
          this.#runtime.registerAssistantItem(
            notification.params.turnId,
            notification.params.item.id,
            notification.params.item.phase
          );
        }
        await this.updateTurnStatus(notification.params.turnId, buildStatusDraftForItem(notification.params.item));
        return;
      }
      case "turn/plan/updated": {
        await this.updateTurnStatus(notification.params.turnId, buildStatusDraft("planning"));
        return;
      }
      case "item/reasoning/summaryTextDelta": {
        await this.updateTurnStatus(notification.params.turnId, buildStatusDraft("thinking"));
        return;
      }
      case "item/mcpToolCall/progress": {
        await this.updateTurnStatus(notification.params.turnId, buildStatusDraft("using tool"));
        return;
      }
      case "item/commandExecution/outputDelta": {
        await this.updateTurnStatus(notification.params.turnId, buildStatusDraft("running"), false, true);
        return;
      }
      case "item/fileChange/outputDelta": {
        await this.updateTurnStatus(notification.params.turnId, buildStatusDraft("editing"), false, true);
        return;
      }
      case "item/agentMessage/delta": {
        const activeTurn = this.#activeTurns.get(notification.params.turnId);
        const update = this.#runtime.appendAssistantDelta(
          notification.params.turnId,
          notification.params.itemId,
          notification.params.delta
        );
        if (!activeTurn || !update) {
          return;
        }

        await this.database.appendTurnStream(activeTurn.turnId, update.finalText);
        await this.handleAssistantRenderUpdate(activeTurn, update, "delta", update.startedAssistantText);
        return;
      }
      case "item/completed": {
        if (notification.params.item.type === "userMessage") {
          const queueState = this.#runtime.acknowledgeCommittedUserItem(notification.params.turnId, notification.params.item);
          if (queueState) {
            await this.syncQueuePreview(queueState);
          }
          return;
        }

        if (notification.params.item.type !== "agentMessage") {
          return;
        }

        const activeTurn = this.#activeTurns.get(notification.params.turnId);
        const update = this.#runtime.commitAssistantItem(
          notification.params.turnId,
          notification.params.item.id,
          notification.params.item.text,
          notification.params.item.phase
        );
        if (!activeTurn || !update) {
          return;
        }

        await this.database.appendTurnStream(activeTurn.turnId, update.finalText);
        await this.handleAssistantRenderUpdate(activeTurn, update, "completed", true);
        return;
      }
      case "turn/completed": {
        if (notification.params.turn.status === "interrupted") {
          await this.finalizeInterruptedTurnById(notification.params.threadId, notification.params.turn.id);
          return;
        }

        await this.completeTurn(notification.params.threadId, notification.params.turn.id);
        return;
      }
      case "error": {
        await this.failTurn(notification.params.threadId, notification.params.turnId, notification.params.error.message);
        return;
      }
      default:
        return;
    }
  }

  private async completeTurn(threadId: string, turnId: string): Promise<void> {
    const activeTurn = this.#activeTurns.get(turnId);
    if (!activeTurn) {
      return;
    }

    await this.beginTurnFinalization(activeTurn);
    const finalText = await this.resolveTurnText(threadId, turnId);
    const queueState = await this.finishTurn(activeTurn, "completed", finalText || "(no assistant output)");
    if (queueState) {
      await this.syncQueuePreview(queueState);
      await this.maybeSendNextQueuedFollowUp(queueState.chatId, queueState.topicId);
    }
  }

  private async failTurn(threadId: string, turnId: string, errorMessage: string): Promise<void> {
    const activeTurn = this.#activeTurns.get(turnId);
    if (!activeTurn) {
      return;
    }

    await this.beginTurnFinalization(activeTurn);
    const fallbackOutput = await this.resolveTurnText(threadId, turnId);
    const text = [fallbackOutput, `\n\nCodex error: ${errorMessage}`].filter(Boolean).join("");
    const queueState = await this.finishTurn(activeTurn, "failed", text);
    if (queueState) {
      await this.syncQueuePreview(queueState);
      await this.maybeSendNextQueuedFollowUp(queueState.chatId, queueState.topicId);
    }
  }

  private async finalizeInterruptedTurnById(threadId: string, turnId: string): Promise<void> {
    const activeTurn = this.#activeTurns.get(turnId);
    if (!activeTurn) {
      this.#submitPendingSteersAfterInterrupt.delete(turnId);
      return;
    }

    await this.finalizeInterruptedTurn(activeTurn, this.#submitPendingSteersAfterInterrupt.has(turnId), threadId);
  }

  private async finalizeInterruptedTurn(
    activeTurn: ActiveTurn,
    submitPendingSteers: boolean,
    threadId = activeTurn.threadId
  ): Promise<void> {
    const pendingSteers = submitPendingSteers ? this.#runtime.drainPendingSteers(activeTurn.chatId, activeTurn.topicId) : null;
    if (!submitPendingSteers) {
      this.#runtime.movePendingSteersToQueued(activeTurn.chatId, activeTurn.topicId);
    }

    await this.beginTurnFinalization(activeTurn);
    const finalText = await this.resolveTurnText(threadId, activeTurn.turnId);
    const queueState = await this.finishTurn(activeTurn, "interrupted", finalText, false);

    if (!queueState) {
      return;
    }

    await this.syncQueuePreview(queueState);

    if (!submitPendingSteers || !pendingSteers?.mergedMessage) {
      return;
    }

    const session = await this.database.getSessionByTopic(activeTurn.chatId, activeTurn.topicId);
    if (!session?.codexThreadId) {
      return;
    }

    try {
      await this.sendTurnForSession(session, pendingSteers.mergedMessage);
    } catch (error) {
      const restoredQueue = this.#runtime.prependQueuedFollowUp(
        activeTurn.chatId,
        activeTurn.topicId,
        pendingSteers.mergedMessage
      );
      await this.syncQueuePreview(restoredQueue);
      await this.#messenger.sendMessage({
        chatId: activeTurn.chatId,
        topicId: activeTurn.topicId,
        text: `Interrupted the current turn, but failed to submit queued steer instructions: ${formatError(error)}`
      });
      return;
    }

    await this.syncQueuePreview(this.#runtime.getQueueState(activeTurn.chatId, activeTurn.topicId));
  }

  private async handleServerRequest(request: ServerRequest): Promise<void> {
    await this.#requestCoordinator.handleServerRequest(request);
  }

  private async tryResolveUserInput(message: UserTurnMessage): Promise<boolean> {
    return this.#requestCoordinator.tryResolveUserInput(message);
  }

  private async updateTurnStatus(
    turnId: string,
    statusDraft: TurnStatusDraft,
    force = false,
    preserveDetails = false
  ): Promise<void> {
    const activeTurn = this.#activeTurns.get(turnId);
    if (!activeTurn) {
      return;
    }

    const now = Date.now();
    const nextStatus =
      preserveDetails && activeTurn.statusDraft?.state === statusDraft.state && activeTurn.statusDraft.details
        ? { ...statusDraft, details: activeTurn.statusDraft.details }
        : statusDraft;
    if (isSameStatusDraft(activeTurn.statusDraft, nextStatus)) {
      return;
    }

    if (!force && now - activeTurn.lastStatusUpdateAt < 500) {
      return;
    }

    activeTurn.statusDraft = nextStatus;
    activeTurn.lastStatusUpdateAt = now;
    await activeTurn.statusHandle.set(renderTelegramStatusDraft(nextStatus), force);
  }

  private async handleAssistantRenderUpdate(
    activeTurn: ActiveTurn,
    update: AssistantRenderUpdate,
    stage: "delta" | "completed",
    forceDraft = false
  ): Promise<void> {
    if (update.itemPhase === "commentary") {
      const commentary = this.getOrCreateCommentaryStream(activeTurn, update.itemId);
      commentary.text = update.itemText;
      if (stage === "completed") {
        await commentary.handle.finalize(buildRenderedCommentaryMessage(update.itemText));
        activeTurn.commentaryStreams.delete(update.itemId);
        return;
      }

      await commentary.handle.update(renderTelegramCommentaryDraft(update.itemText), forceDraft);
      return;
    }

    if (update.draftKind === "assistant") {
      await activeTurn.finalStream.update(renderTelegramAssistantDraft(update.draftText || "…"), forceDraft);
      return;
    }
  }

  private getOrCreateCommentaryStream(
    activeTurn: ActiveTurn,
    itemId: string
  ): { handle: TelegramStreamMessageHandle; text: string } {
    const existing = activeTurn.commentaryStreams.get(itemId);
    if (existing) {
      return existing;
    }

    const created = {
      handle: this.#messenger.streamMessage({
        chatId: activeTurn.chatId,
        topicId: activeTurn.topicId,
        draftId: buildStableDraftId(`${activeTurn.turnId}:commentary:${itemId}`)
      }),
      text: ""
    };
    activeTurn.commentaryStreams.set(itemId, created);
    return created;
  }

  private async publishFinalTurnText(activeTurn: ActiveTurn, text: string): Promise<number> {
    const outputs = buildRenderedAssistantMessages(text);
    if (this.#runtime.getTurn(activeTurn.turnId)?.hasAssistantText) {
      const messageId = await activeTurn.finalStream.finalize(outputs);
      if (messageId !== null) {
        return messageId;
      }
    }

    return this.sendRenderedMessages(activeTurn.chatId, activeTurn.topicId, outputs);
  }

  private async sendRenderedMessages(
    chatId: number,
    topicId: number,
    renderedMessages: TelegramRenderedMessage[]
  ): Promise<number> {
    let firstMessageId: number | null = null;

    for (const rendered of renderedMessages) {
      const message = await this.#messenger.sendMessage({
        chatId,
        topicId,
        text: rendered.text,
        ...(rendered.parseMode ? { parseMode: rendered.parseMode } : {})
      });
      if (firstMessageId === null) {
        firstMessageId = message.messageId;
      }
    }

    if (firstMessageId === null) {
      throw new Error("Failed to publish Telegram message chunks");
    }

    return firstMessageId;
  }

  private findActiveTurnByTopic(chatId: number, topicId: number): ActiveTurn | undefined {
    const activeTurn = this.#runtime.getActiveTurnByTopic(chatId, topicId);
    return activeTurn ? this.#activeTurns.get(activeTurn.turnId) : undefined;
  }

  private createActiveTurn(message: UserTurnMessage, threadId: string, turnId: string): ActiveTurn {
    if (message.topicId === null) {
      throw new Error("Cannot create an active turn without a Telegram topic id");
    }

    return {
      chatId: message.chatId,
      topicId: message.topicId,
      threadId,
      turnId,
      statusDraft: buildStatusDraft("thinking"),
      lastStatusUpdateAt: Date.now(),
      lifecycle: "active",
      statusHandle: this.#messenger.statusDraft({
        chatId: message.chatId,
        topicId: message.topicId,
        draftId: buildStableDraftId(`${turnId}:status`)
      }),
      finalStream: this.#messenger.streamMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        draftId: buildStableDraftId(`${turnId}:final`)
      }),
      commentaryStreams: new Map()
    };
  }

  private removeActiveTurn(turnId: string): void {
    this.#activeTurns.delete(turnId);
    this.#submitPendingSteersAfterInterrupt.delete(turnId);
  }

  private async resolveTurnText(threadId: string, turnId: string): Promise<string> {
    const streamedText = this.#runtime.renderAssistantItems(turnId);
    const readbackText = await this.codex.readTurnMessages(threadId, turnId);
    return readbackText.trim().length > 0 ? readbackText : streamedText;
  }

  private async finishTurn(
    activeTurn: ActiveTurn,
    status: "completed" | "failed" | "interrupted",
    text: string,
    publishWhenEmpty = true
  ): Promise<QueueStateSnapshot | null> {
    let messageId: number | null = null;
    if (text.trim().length > 0 || publishWhenEmpty) {
      messageId = await this.publishFinalTurnText(activeTurn, text);
    }

    await this.database.appendTurnStream(activeTurn.turnId, text);
    await this.database.completeTurn(activeTurn.turnId, messageId, status);
    const queueState = this.#runtime.finalizeTurn(activeTurn.turnId);
    this.removeActiveTurn(activeTurn.turnId);
    return queueState;
  }

  private async beginTurnFinalization(activeTurn: ActiveTurn): Promise<void> {
    if (activeTurn.lifecycle === "finalizing") {
      return;
    }

    activeTurn.lifecycle = "finalizing";
    await activeTurn.statusHandle.clear();

    for (const [itemId, commentary] of activeTurn.commentaryStreams) {
      if (commentary.text.trim().length > 0) {
        await commentary.handle.finalize(buildRenderedCommentaryMessage(commentary.text));
      } else {
        await commentary.handle.clear();
      }
      activeTurn.commentaryStreams.delete(itemId);
    }
  }

  private async trySteerTurn(activeTurn: ActiveTurn, message: UserTurnMessage): Promise<void> {
    if (message.topicId === null) {
      return;
    }

    const runtimeTurn = this.#runtime.getTurn(activeTurn.turnId);
    if (!runtimeTurn) {
      return;
    }

    const pending = this.#runtime.queuePendingSteer(runtimeTurn, message);
    await this.syncQueuePreview(pending.queueState);

    let preparedInput: { input: UserInput[]; tempPaths: string[] } | null = null;
    try {
      preparedInput = await this.materializeCodexInput(message);
      await this.codex.steerTurn(activeTurn.threadId, activeTurn.turnId, preparedInput.input);
    } catch (error) {
      const classification = classifySteerError(error);
      if (classification.kind === "stale_or_missing_active_turn") {
        const queueState = this.#runtime.movePendingSteerToQueued(message.chatId, message.topicId, pending.localId);
        await this.syncQueuePreview(queueState);
        return;
      }

      const queueState = this.#runtime.dropPendingSteer(message.chatId, message.topicId, pending.localId);
      await this.syncQueuePreview(queueState);

      if (classification.kind === "invalid_input") {
        await this.#messenger.sendMessage({
          chatId: message.chatId,
          topicId: message.topicId,
          text: classification.userMessage ?? `Codex rejected the follow-up: ${formatError(error)}`
        });
        return;
      }

      console.error("Failed to steer turn", error);
      await this.#messenger.sendMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: `Failed to add the follow-up to the current turn: ${formatError(error)}`
      });
      return;
    } finally {
      if (preparedInput) {
        await this.cleanupPreparedCodexInput(preparedInput);
      }
    }
  }

  private async materializeCodexInput(message: UserTurnMessage): Promise<{ input: UserInput[]; tempPaths: string[] }> {
    const input: UserInput[] = [];
    const tempPaths: string[] = [];

    for (const item of message.input) {
      if (item.type === "text") {
        input.push(item);
        continue;
      }

      const download = await this.telegram.downloadFile(item.fileId);
      const filenameHint = item.fileName ?? item.mimeType ?? download.filePath ?? null;
      const path = await this.mediaStore.writeImage(download.bytes, filenameHint);
      tempPaths.push(path);
      input.push({
        type: "localImage",
        path
      });
    }

    message.submittedInputSignature = buildUserInputSignature(input);
    return { input, tempPaths };
  }

  private async cleanupPreparedCodexInput(preparedInput: { input: UserInput[]; tempPaths: string[] }): Promise<void> {
    await Promise.all(preparedInput.tempPaths.map((path) => this.mediaStore.deleteFile(path)));
  }

  private async syncQueuePreview(queueState: QueueStateSnapshot): Promise<void> {
    const previewText = renderQueuePreview(queueState);
    const key = topicKey(queueState.chatId, queueState.topicId);
    const existingMessageId = this.#queuePreviewMessageIds.get(key) ?? null;
    const activeTurn = this.findActiveTurnByTopic(queueState.chatId, queueState.topicId);
    const replyMarkup = buildQueuePreviewKeyboard(queueState, activeTurn?.turnId ?? null);

    if (!previewText) {
      if (existingMessageId !== null) {
        try {
          await this.telegram.deleteMessage(queueState.chatId, existingMessageId);
        } catch {
          // Ignore preview cleanup failures.
        }
        this.#queuePreviewMessageIds.delete(key);
      }
      return;
    }

    if (existingMessageId !== null) {
      try {
        const options = replyMarkup
          ? {
              message_thread_id: queueState.topicId,
              reply_markup: replyMarkup
            }
          : {
              message_thread_id: queueState.topicId
            };
        await this.telegram.editMessageText(queueState.chatId, existingMessageId, previewText, options);
        return;
      } catch {
        this.#queuePreviewMessageIds.delete(key);
      }
    }

    const options = replyMarkup
      ? {
          message_thread_id: queueState.topicId,
          reply_markup: replyMarkup
        }
      : {
          message_thread_id: queueState.topicId
        };
    const message = await this.#messenger.sendMessage({
      chatId: queueState.chatId,
      topicId: queueState.topicId,
      text: previewText,
      ...(replyMarkup ? { replyMarkup } : {})
    });
    this.#queuePreviewMessageIds.set(key, message.messageId);
  }

  private async maybeSendNextQueuedFollowUp(chatId: number, topicId: number): Promise<void> {
    if (this.findActiveTurnByTopic(chatId, topicId)) {
      return;
    }

    const nextMessage = this.#runtime.peekNextQueuedFollowUp(chatId, topicId);
    if (!nextMessage) {
      return;
    }

    const session = await this.database.getSessionByTopic(chatId, topicId);
    if (!session?.codexThreadId) {
      return;
    }

    await this.sendTurnForSession(session, nextMessage);
    this.#runtime.shiftNextQueuedFollowUp(chatId, topicId);
    await this.syncQueuePreview(this.#runtime.getQueueState(chatId, topicId));
  }

}

function topicKey(chatId: number, topicId: number): string {
  return `${chatId}:${topicId}`;
}
