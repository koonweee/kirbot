import type { AppConfig } from "./config";
import type { ApprovalServerRequest, UserInputServerRequest } from "./codex";
import { BridgeDatabase } from "./db";
import type { PendingServerRequest, TopicLifecycleEvent, TopicSession, UserTurnInput, UserTurnMessage } from "./domain";
import type { ServerNotification } from "./generated/codex/ServerNotification";
import type { ServerRequest } from "./generated/codex/ServerRequest";
import type { RequestId } from "./generated/codex/RequestId";
import type { ThreadItem } from "./generated/codex/v2/ThreadItem";
import type { UserInput } from "./generated/codex/v2/UserInput";
import type { CommandExecutionApprovalDecision } from "./generated/codex/v2/CommandExecutionApprovalDecision";
import type { CommandExecutionRequestApprovalParams } from "./generated/codex/v2/CommandExecutionRequestApprovalParams";
import type { FileChangeApprovalDecision } from "./generated/codex/v2/FileChangeApprovalDecision";
import type { FileChangeRequestApprovalParams } from "./generated/codex/v2/FileChangeRequestApprovalParams";
import type { ToolRequestUserInputResponse } from "./generated/codex/v2/ToolRequestUserInputResponse";
import { TemporaryImageStore } from "./media-store";
import { JsonRpcMethodError } from "./rpc";
import {
  TelegramMessenger,
  type InlineKeyboardMarkup,
  type TelegramApi,
  type TelegramParseMode,
  type TelegramRenderedMessage,
  type TelegramStatusDraftHandle,
  type TelegramStreamMessageHandle
} from "./telegram-messenger";
import { BridgeTurnRuntime, type AssistantRenderUpdate, type QueueStateSnapshot } from "./turn-runtime";

type TurnStatusState =
  | "thinking"
  | "planning"
  | "using tool"
  | "running"
  | "editing"
  | "searching"
  | "streaming"
  | "waiting"
  | "done"
  | "failed"
  | "interrupted";

type TurnStatusDraft = {
  state: TurnStatusState;
  emoji: string;
  details: string | null;
};

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

const TELEGRAM_MESSAGE_CHAR_LIMIT = 4000;
const TELEGRAM_DRAFT_PREVIEW_CHAR_LIMIT = 3500;

export class TelegramCodexBridge {
  readonly #runtime = new BridgeTurnRuntime();
  readonly #activeTurns = new Map<string, ActiveTurn>();
  readonly #queuePreviewMessageIds = new Map<string, number>();
  readonly #submitPendingSteersAfterInterrupt = new Set<string>();
  readonly #notificationChains = new Map<string, Promise<void>>();
  readonly #messenger: TelegramMessenger;

  constructor(
    private readonly config: AppConfig,
    private readonly database: BridgeDatabase,
    private readonly telegram: TelegramApi,
    private readonly codex: BridgeCodexApi,
    private readonly mediaStore: TemporaryImageStore
  ) {
    this.#messenger = new TelegramMessenger(telegram);
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
    if (event.data.startsWith("req:")) {
      await this.handleRequestCallbackQuery(event);
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

  private async handleRequestCallbackQuery(event: CallbackQueryEvent): Promise<void> {
    const [, requestIdText, action] = event.data.split(":");
    const requestId = Number.parseInt(requestIdText ?? "", 10);
    if (Number.isNaN(requestId)) {
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: "Invalid callback payload."
      });
      return;
    }

    const request = await this.database.getServerRequestById(requestId);
    if (!request || request.status !== "pending") {
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: "This request is no longer pending."
      });
      return;
    }

    await this.resolveApprovalAction(request, action ?? "cancel");
    await this.telegram.answerCallbackQuery(event.callbackQueryId, {
      text: "Request updated."
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

    const pending = await this.database.createProvisioningSession({
      telegramChatId: String(message.chatId),
      telegramTopicId: forumTopic.message_thread_id,
      rootMessageId: message.messageId,
      createdByUserId: message.userId,
      title
    });

    try {
      const threadId = await this.codex.createThread(title);
      const session = await this.database.activateSession(pending.id, threadId);

      await this.#messenger.sendMessage({
        chatId: message.chatId,
        text: `Created session topic "${title}". Continue in the new topic.`
      });

      await this.sendTurnForSession(session, {
        ...message,
        topicId: forumTopic.message_thread_id
      });
    } catch (error) {
      await this.database.markSessionErrored(pending.id);
      await this.#messenger.sendMessage({
        chatId: message.chatId,
        topicId: forumTopic.message_thread_id,
        text: `Failed to create Codex session for "${title}": ${formatError(error)}`
      });
    }
  }

  private async startSessionInExistingTopic(message: UserTurnMessage): Promise<void> {
    if (message.topicId === null) {
      throw new Error("Cannot start an in-topic session without a Telegram topic id");
    }

    const title = deriveTopicTitle(message.text);
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

    const activeTurn: ActiveTurn = {
      chatId: message.chatId,
      topicId: message.topicId,
      threadId: session.codexThreadId,
      turnId: turn.id,
      statusDraft: buildStatusDraft("thinking"),
      lastStatusUpdateAt: Date.now(),
      lifecycle: "active",
      statusHandle: this.#messenger.statusDraft({
        chatId: message.chatId,
        topicId: message.topicId,
        draftId: buildStableDraftId(`${turn.id}:status`)
      }),
      finalStream: this.#messenger.streamMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        draftId: buildStableDraftId(`${turn.id}:final`)
      }),
      commentaryStreams: new Map()
    };
    this.#activeTurns.set(turn.id, activeTurn);
    this.#runtime.registerTurn({
      chatId: message.chatId,
      topicId: message.topicId,
      threadId: session.codexThreadId,
      turnId: turn.id,
      draftId: message.updateId
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
    const streamedText = this.#runtime.renderAssistantItems(turnId);
    const readbackText = await this.codex.readTurnMessages(threadId, turnId);
    const finalText = readbackText.trim().length > 0 ? readbackText : streamedText;
    const finalBody = finalText || "(no assistant output)";
    const messageId = await this.publishFinalTurnText(activeTurn, finalBody);

    await this.database.appendTurnStream(turnId, finalBody);
    await this.database.completeTurn(turnId, messageId, "completed");
    const queueState = this.#runtime.finalizeTurn(turnId);
    this.removeActiveTurn(turnId);
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
    const streamedText = this.#runtime.renderAssistantItems(turnId);
    const readbackText = await this.codex.readTurnMessages(threadId, turnId);
    const fallbackOutput = readbackText.trim().length > 0 ? readbackText : streamedText;
    const text = [fallbackOutput, `\n\nCodex error: ${errorMessage}`].filter(Boolean).join("");
    const messageId = await this.publishFinalTurnText(activeTurn, text);

    await this.database.appendTurnStream(turnId, text);
    await this.database.completeTurn(turnId, messageId, "failed");
    const queueState = this.#runtime.finalizeTurn(turnId);
    this.removeActiveTurn(turnId);
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
    const streamedText = this.#runtime.renderAssistantItems(activeTurn.turnId);
    const readbackText = await this.codex.readTurnMessages(threadId, activeTurn.turnId);
    const finalText = readbackText.trim().length > 0 ? readbackText : streamedText;
    let messageId: number | null = null;

    if (finalText.trim().length > 0) {
      messageId = await this.publishFinalTurnText(activeTurn, finalText);
    }

    await this.database.appendTurnStream(activeTurn.turnId, finalText);
    await this.database.completeTurn(activeTurn.turnId, messageId, "interrupted");
    const queueState = this.#runtime.finalizeTurn(activeTurn.turnId);
    this.removeActiveTurn(activeTurn.turnId);
    this.#submitPendingSteersAfterInterrupt.delete(activeTurn.turnId);

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
    const session = await this.findSessionForRequest(request);
    if (!session || !session.codexThreadId) {
      await this.codex.respondUnsupportedRequest(request.id, "No Telegram topic mapping exists for this request.");
      return;
    }

    if (
      request.method === "item/commandExecution/requestApproval" ||
      request.method === "item/fileChange/requestApproval"
    ) {
      await this.handleApprovalRequest(session, request);
      return;
    }

    if (request.method === "item/tool/requestUserInput") {
      await this.handleUserInputRequest(session, request);
      return;
    }

    await this.codex.respondUnsupportedRequest(request.id, `Unsupported server request method: ${request.method}`);
  }

  private async handleApprovalRequest(session: TopicSession, request: ApprovalServerRequest): Promise<void> {
    await this.updateTurnStatus(
      request.params.turnId,
      buildStatusDraft("waiting", request.method === "item/commandExecution/requestApproval" ? "approval" : "file approval"),
      true
    );

    const promptText =
      request.method === "item/commandExecution/requestApproval"
        ? formatCommandApprovalPrompt(request.params)
        : formatFileChangeApprovalPrompt(request.params);

    const pending = await this.database.createPendingRequest({
      requestIdJson: JSON.stringify(request.id),
      method: request.method,
      telegramChatId: session.telegramChatId,
      telegramTopicId: session.telegramTopicId,
      telegramMessageId: null,
      codexThreadId: session.codexThreadId!,
      turnId: request.params.turnId,
      itemId: request.params.itemId,
      payloadJson: JSON.stringify(request.params)
    });

    const message = await this.#messenger.sendMessage({
      chatId: Number.parseInt(session.telegramChatId, 10),
      topicId: session.telegramTopicId,
      text: promptText,
      replyMarkup: buildApprovalKeyboard(
        pending.id,
        request.method === "item/commandExecution/requestApproval" ? request.params.availableDecisions ?? null : null
      )
    });

    await this.database.updateServerRequestMessageId(pending.id, message.messageId);
  }

  private async handleUserInputRequest(session: TopicSession, request: UserInputServerRequest): Promise<void> {
    await this.updateTurnStatus(request.params.turnId, buildStatusDraft("waiting", "input"), true);

    const promptText = [
      "Codex is asking for user input.",
      ...request.params.questions.map((question) =>
        question.options?.length
          ? `- ${question.id}: ${question.question} Options: ${question.options.map((option) => option.label).join(", ")}`
          : `- ${question.id}: ${question.question}`
      ),
      "",
      "Reply in this topic. For one question, send plain text. For multiple questions, send JSON like {\"question_id\": \"answer\"}."
    ].join("\n");

    const message = await this.#messenger.sendMessage({
      chatId: Number.parseInt(session.telegramChatId, 10),
      topicId: session.telegramTopicId,
      text: promptText
    });

    await this.database.createPendingRequest({
      requestIdJson: JSON.stringify(request.id),
      method: request.method,
      telegramChatId: session.telegramChatId,
      telegramTopicId: session.telegramTopicId,
      telegramMessageId: message.messageId,
      codexThreadId: session.codexThreadId!,
      turnId: request.params.turnId,
      itemId: request.params.itemId,
      payloadJson: JSON.stringify(request.params)
    });
  }

  private async tryResolveUserInput(message: UserTurnMessage): Promise<boolean> {
    if (message.topicId === null) {
      return false;
    }

    const pending = await this.database.getPendingRequestByTopic(message.chatId, message.topicId, "item/tool/requestUserInput");
    if (!pending) {
      return false;
    }

    const payload = JSON.parse(pending.payloadJson) as UserInputServerRequest["params"];
    const response = parseUserInputResponse(message.text, payload.questions);

    await this.codex.respondToUserInputRequest(parseRequestId(pending.requestIdJson), response);
    await this.database.resolveRequest(pending.requestIdJson, JSON.stringify(response));
    await this.#messenger.sendMessage({
      chatId: message.chatId,
      topicId: message.topicId,
      text: "Sent your answer to Codex."
    });
    return true;
  }

  private async resolveApprovalAction(request: PendingServerRequest, action: string): Promise<void> {
    const requestId = parseRequestId(request.requestIdJson);
    const chatId = Number.parseInt(request.telegramChatId, 10);

    if (request.method === "item/commandExecution/requestApproval") {
      const response = {
        decision: normalizeCommandApprovalDecision(action)
      };
      await this.codex.respondToCommandApproval(requestId, response);
      await this.database.resolveRequest(request.requestIdJson, JSON.stringify(response));
    } else if (request.method === "item/fileChange/requestApproval") {
      const response = {
        decision: normalizeFileApprovalDecision(action)
      };
      await this.codex.respondToFileChangeApproval(requestId, response);
      await this.database.resolveRequest(request.requestIdJson, JSON.stringify(response));
    } else {
      await this.codex.respondUnsupportedRequest(requestId, `Unsupported approval action for ${request.method}`);
      return;
    }

    if (request.telegramMessageId) {
      await this.telegram.editMessageText(
        chatId,
        request.telegramMessageId,
        `Resolved ${request.method} with "${action}".`,
        {
          message_thread_id: request.telegramTopicId
        }
      );
    }
  }

  private async findSessionForRequest(request: ServerRequest): Promise<TopicSession | undefined> {
    const threadId = "threadId" in request.params && typeof request.params.threadId === "string" ? request.params.threadId : null;
    if (!threadId) {
      return undefined;
    }

    return this.database.getSessionByCodexThreadId(threadId);
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
        parseMode: rendered.parseMode
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

  private removeActiveTurn(turnId: string): void {
    this.#activeTurns.delete(turnId);
    this.#submitPendingSteersAfterInterrupt.delete(turnId);
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

function deriveTopicTitle(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 60) || "New Codex Session";
}

function buildStableDraftId(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 1) || 1;
}

function topicKey(chatId: number, topicId: number): string {
  return `${chatId}:${topicId}`;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function truncateStatus(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function buildStatusDraft(state: TurnStatusState, details: string | null = null): TurnStatusDraft {
  switch (state) {
    case "thinking":
      return { state, emoji: "🤔", details };
    case "planning":
      return { state, emoji: "🗺️", details };
    case "using tool":
      return { state, emoji: "🛠️", details };
    case "running":
      return { state, emoji: "💻", details };
    case "editing":
      return { state, emoji: "✏️", details };
    case "searching":
      return { state, emoji: "🔎", details };
    case "streaming":
      return { state, emoji: "✍️", details };
    case "waiting":
      return { state, emoji: "⏸️", details };
    case "done":
      return { state, emoji: "✅", details };
    case "failed":
      return { state, emoji: "❌", details };
    case "interrupted":
      return { state, emoji: "⏹️", details };
  }
}

function buildStatusDraftForItem(item: ThreadItem): TurnStatusDraft {
  switch (item.type) {
    case "reasoning":
      return buildStatusDraft("thinking");
    case "commandExecution":
      return buildStatusDraft("running", item.command);
    case "fileChange":
      return buildStatusDraft("editing", summarizeFileChanges(item.changes));
    case "plan":
      return buildStatusDraft("planning");
    case "mcpToolCall":
      return buildStatusDraft("using tool", `${item.server}.${item.tool}`);
    case "dynamicToolCall":
      return buildStatusDraft("using tool", item.tool);
    case "collabAgentToolCall":
      return buildStatusDraft("using tool", item.tool);
    case "webSearch":
      return buildStatusDraft("searching", item.query);
    default:
      return buildStatusDraft("thinking");
  }
}

function isSameStatusDraft(left: TurnStatusDraft | null, right: TurnStatusDraft | null): boolean {
  return left?.state === right?.state && left?.emoji === right?.emoji && left?.details === right?.details;
}

function summarizeFileChanges(changes: Array<{ path: string }>): string | null {
  if (changes.length === 0) {
    return null;
  }

  if (changes.length === 1) {
    return changes[0]?.path ?? null;
  }

  const [first, second] = changes;
  if (changes.length === 2 && first && second) {
    return `${first.path}, ${second.path}`;
  }

  return `${first?.path ?? changes.length} (+${changes.length - 1} more)`;
}

function renderQueuePreview(queueState: QueueStateSnapshot): string | null {
  const lines: string[] = [];

  if (queueState.pendingSteers.length > 0) {
    lines.push("Queued for current turn:");
    for (const text of queueState.pendingSteers.slice(0, 3)) {
      lines.push(`- ${truncateStatus(text)}`);
    }
    if (queueState.pendingSteers.length > 3) {
      lines.push(`- …and ${queueState.pendingSteers.length - 3} more`);
    }
  }

  if (queueState.queuedFollowUps.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push("Queued for next turn:");
    for (const text of queueState.queuedFollowUps.slice(0, 3)) {
      lines.push(`- ${truncateStatus(text)}`);
    }
    if (queueState.queuedFollowUps.length > 3) {
      lines.push(`- …and ${queueState.queuedFollowUps.length - 3} more`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

function buildQueuePreviewKeyboard(queueState: QueueStateSnapshot, activeTurnId: string | null): InlineKeyboardMarkup | undefined {
  if (queueState.pendingSteers.length === 0 || !activeTurnId) {
    return undefined;
  }

  return {
    inline_keyboard: [[{ text: "Send now", callback_data: `turn:${activeTurnId}:sendNow` }]]
  };
}

function buildDraftPreview(text: string): string {
  return buildTruncatedPreview(text, TELEGRAM_DRAFT_PREVIEW_CHAR_LIMIT, "…\n", "\n\n[preview truncated]");
}

function buildDraftPreviewWithLimit(text: string, limit: number): string {
  return buildTruncatedPreview(text, limit, "…\n", "\n\n[preview truncated]");
}

function buildCommentaryDraftPreviewWithLimit(text: string, limit: number): string {
  return buildTruncatedPreview(text, limit, "...\n", "\n\n[commentary truncated]");
}

function buildTruncatedPreview(text: string, limit: number, prefix: string, suffix: string): string {
  if (text.length <= limit) {
    return text;
  }

  const budget = Math.max(0, limit - prefix.length - suffix.length);
  return `${prefix}${text.slice(-budget)}${suffix}`;
}

function buildStatusText(statusDraft: TurnStatusDraft): string {
  if (!statusDraft.details) {
    return statusDraft.state;
  }

  return `${statusDraft.state}\n\`\`\`kirbot\n${statusDraft.details.replaceAll("```", "'''")}\n\`\`\``;
}

function buildCommentaryText(text: string): string {
  return `\`\`\`kirbot\n${text}\n\`\`\``;
}

function chunkTelegramMessage(text: string): string[] {
  const reservedHeaderChars = 32;
  const rawChunks = splitTextForTelegram(text, TELEGRAM_MESSAGE_CHAR_LIMIT - reservedHeaderChars);
  if (rawChunks.length === 1) {
    return rawChunks;
  }

  return rawChunks.map((chunk, index) => `Part ${index + 1}/${rawChunks.length}\n\n${chunk}`);
}

function splitTextForTelegram(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    const splitIndex = findChunkBoundary(remaining, maxChars);
    chunks.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).replace(/^\s+/, "");
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks.length > 0 ? chunks : [text];
}

function findChunkBoundary(text: string, maxChars: number): number {
  const minPreferredIndex = Math.floor(maxChars * 0.6);
  const window = text.slice(0, maxChars + 1);
  const candidates = [window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" ")];

  for (const index of candidates) {
    if (index >= minPreferredIndex) {
      return index;
    }
  }

  return maxChars;
}

function renderTelegramAssistantText(text: string): { text: string; parse_mode?: TelegramParseMode } {
  const rendered = markdownToTelegramHtml(text);
  if (rendered === text) {
    return { text };
  }

  return {
    text: rendered,
    parse_mode: "HTML"
  };
}

function renderTelegramStatusDraft(statusDraft: TurnStatusDraft | null): TelegramRenderedMessage | null {
  return statusDraft ? renderTelegramAssistantText(buildStatusText(statusDraft)) : null;
}

function renderTelegramAssistantDraft(text: string): TelegramRenderedMessage {
  let budget = TELEGRAM_DRAFT_PREVIEW_CHAR_LIMIT;
  let rendered = renderTelegramAssistantText(buildDraftPreviewWithLimit(text, budget));

  for (let attempt = 0; attempt < 3 && rendered.text.length > TELEGRAM_DRAFT_PREVIEW_CHAR_LIMIT; attempt += 1) {
    const overflow = rendered.text.length - TELEGRAM_DRAFT_PREVIEW_CHAR_LIMIT;
    budget = Math.max(0, budget - overflow - 16);
    rendered = renderTelegramAssistantText(buildDraftPreviewWithLimit(text, budget));
  }

  return toRenderedMessage(rendered);
}

function renderTelegramCommentaryDraft(text: string): TelegramRenderedMessage {
  const budget = Math.max(0, TELEGRAM_DRAFT_PREVIEW_CHAR_LIMIT - "```kirbot\n\n```".length);
  return toRenderedMessage(renderTelegramAssistantText(buildCommentaryText(buildCommentaryDraftPreviewWithLimit(text, budget))));
}

function buildRenderedCommentaryMessage(text: string): TelegramRenderedMessage {
  const budget = Math.max(0, TELEGRAM_MESSAGE_CHAR_LIMIT - "```kirbot\n\n```".length);
  return toRenderedMessage(renderTelegramAssistantText(buildCommentaryText(buildCommentaryDraftPreviewWithLimit(text, budget))));
}

function buildRenderedAssistantMessages(text: string): TelegramRenderedMessage[] {
  return chunkTelegramMessage(text).map((chunk) => toRenderedMessage(renderTelegramAssistantText(chunk)));
}

function toRenderedMessage(rendered: { text: string; parse_mode?: TelegramParseMode }): TelegramRenderedMessage {
  return rendered.parse_mode ? { text: rendered.text, parseMode: rendered.parse_mode } : { text: rendered.text };
}

function markdownToTelegramHtml(text: string): string {
  const segments = splitMarkdownByFences(text);
  const rendered = segments
    .map((segment) =>
      segment.type === "fence" ? renderTelegramCodeFence(segment.language, segment.content) : renderTelegramInlineMarkdown(segment.content)
    )
    .join("");

  return rendered === escapeHtml(text) ? text : rendered;
}

function splitMarkdownByFences(
  text: string
): Array<{ type: "text"; content: string } | { type: "fence"; language: string; content: string }> {
  const segments: Array<{ type: "text"; content: string } | { type: "fence"; language: string; content: string }> = [];
  const pattern = /```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g;
  let lastIndex = 0;

  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      segments.push({
        type: "text",
        content: text.slice(lastIndex, index)
      });
    }

    segments.push({
      type: "fence",
      language: (match[1] ?? "").trim(),
      content: match[2] ?? ""
    });
    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({
      type: "text",
      content: text.slice(lastIndex)
    });
  }

  return segments.length > 0 ? segments : [{ type: "text", content: text }];
}

function renderTelegramCodeFence(language: string, content: string): string {
  const escapedCode = escapeHtml(content.replace(/\n$/, ""));
  if (!language) {
    return `<pre><code>${escapedCode}</code></pre>`;
  }

  return `<pre><code class="language-${escapeHtmlAttribute(language)}">${escapedCode}</code></pre>`;
}

function renderTelegramInlineMarkdown(text: string): string {
  let html = "";
  let index = 0;

  while (index < text.length) {
    if (text.startsWith("`", index)) {
      const closingIndex = text.indexOf("`", index + 1);
      if (closingIndex > index + 1 && !text.slice(index + 1, closingIndex).includes("\n")) {
        html += `<code>${escapeHtml(text.slice(index + 1, closingIndex))}</code>`;
        index = closingIndex + 1;
        continue;
      }
    }

    const strongDelimiter = text.startsWith("**", index) ? "**" : text.startsWith("__", index) ? "__" : null;
    if (strongDelimiter) {
      const closingIndex = text.indexOf(strongDelimiter, index + strongDelimiter.length);
      if (closingIndex > index + strongDelimiter.length) {
        html += `<b>${renderTelegramInlineMarkdown(text.slice(index + strongDelimiter.length, closingIndex))}</b>`;
        index = closingIndex + strongDelimiter.length;
        continue;
      }
    }

    html += escapeHtml(text[index] ?? "");
    index += 1;
  }

  return html;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeHtmlAttribute(text: string): string {
  return escapeHtml(text).replaceAll("\"", "&quot;");
}

function buildUserInputSignature(input: UserInput[]): string {
  return JSON.stringify(
    input.map((item) => {
      if (item.type === "text") {
        return {
          type: "text",
          text: item.text
        };
      }

      if (item.type === "localImage") {
        return {
          type: "localImage",
          path: item.path
        };
      }

      if (item.type === "image") {
        return {
          type: "image",
          url: item.url
        };
      }

      return item;
    })
  );
}

function getNotificationTurnId(notification: ServerNotification): string | null {
  switch (notification.method) {
    case "turn/started":
    case "turn/completed":
      return notification.params.turn.id;
    case "item/started":
    case "turn/plan/updated":
    case "item/reasoning/summaryTextDelta":
    case "item/mcpToolCall/progress":
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
    case "item/agentMessage/delta":
    case "item/completed":
    case "error":
      return notification.params.turnId;
    default:
      return null;
  }
}

type SteerErrorClassification =
  | {
      kind: "stale_or_missing_active_turn";
    }
  | {
      kind: "invalid_input";
      userMessage: string;
    }
  | {
      kind: "fatal";
    };

function classifySteerError(error: unknown): SteerErrorClassification {
  if (error instanceof JsonRpcMethodError && error.method === "turn/steer") {
    const structured = isRecord(error.data) ? error.data : null;
    if (structured && "input_error_code" in structured) {
      const maxChars = typeof structured.max_chars === "number" ? structured.max_chars : null;
      const actualChars = typeof structured.actual_chars === "number" ? structured.actual_chars : null;
      const limitMessage =
        maxChars !== null && actualChars !== null
          ? `Codex rejected the follow-up because it exceeds the maximum input length (${actualChars}/${maxChars} characters).`
          : `Codex rejected the follow-up: ${error.message}`;
      return {
        kind: "invalid_input",
        userMessage: limitMessage
      };
    }

    if (error.code === -32600 && isSteerRaceMessage(error.message, structured)) {
      return {
        kind: "stale_or_missing_active_turn"
      };
    }
  }

  if (isSteerRaceMessage(error instanceof Error ? error.message : String(error))) {
    return {
      kind: "stale_or_missing_active_turn"
    };
  }

  return {
    kind: "fatal"
  };
}

type InterruptErrorClassification =
  | {
      kind: "stale_or_missing_active_turn";
    }
  | {
      kind: "fatal";
    };

function classifyInterruptError(error: unknown): InterruptErrorClassification {
  if (error instanceof JsonRpcMethodError && error.method === "turn/interrupt") {
    const structured = isRecord(error.data) ? error.data : null;
    if (error.code === -32600 && isInterruptRaceMessage(error.message, structured)) {
      return {
        kind: "stale_or_missing_active_turn"
      };
    }
  }

  if (isInterruptRaceMessage(error instanceof Error ? error.message : String(error))) {
    return {
      kind: "stale_or_missing_active_turn"
    };
  }

  return {
    kind: "fatal"
  };
}

function isTelegramMessageMissingError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }

  const errorCode = error.error_code;
  const description = error.description;
  return (
    errorCode === 400 &&
    typeof description === "string" &&
    (description.toLowerCase().includes("message to edit not found") ||
      description.toLowerCase().includes("message to delete not found") ||
      description.toLowerCase().includes("not found"))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isInterruptRaceMessage(message: string, structured?: Record<string, unknown> | null): boolean {
  if (structured?.kind === "invalid_active_turn") {
    return true;
  }

  const normalized = message.toLowerCase();
  return (
    normalized.includes("no active turn") ||
    normalized.includes("not the active turn") ||
    normalized.includes("already ended") ||
    normalized.includes("already completed")
  );
}

function buildApprovalKeyboard(
  requestId: number,
  availableDecisions: ReadonlyArray<unknown> | null
): InlineKeyboardMarkup {
  const allows = (decision: string): boolean =>
    availableDecisions ? availableDecisions.some((value) => typeof value === "string" && value === decision) : true;

  const approveRow = [
    allows("accept") ? { text: "Approve", callback_data: `req:${requestId}:accept` } : null,
    allows("acceptForSession")
      ? { text: "Approve Session", callback_data: `req:${requestId}:acceptForSession` }
      : null
  ].filter((value): value is { text: string; callback_data: string } => value !== null);

  const denyRow = [
    allows("decline") ? { text: "Deny", callback_data: `req:${requestId}:decline` } : null,
    allows("cancel") ? { text: "Interrupt", callback_data: `req:${requestId}:cancel` } : null
  ].filter((value): value is { text: string; callback_data: string } => value !== null);

  return {
    inline_keyboard: [approveRow, denyRow].filter((row) => row.length > 0)
  };
}

function formatCommandApprovalPrompt(params: CommandExecutionRequestApprovalParams): string {
  const command = params.command ?? "(unknown command)";
  const cwd = params.cwd ?? "(unknown cwd)";
  const reason = params.reason ? `Reason: ${params.reason}` : "Reason: not provided";

  return [
    "Codex requested command approval.",
    `Command: ${command}`,
    `Cwd: ${cwd}`,
    reason
  ].join("\n");
}

function formatFileChangeApprovalPrompt(params: FileChangeRequestApprovalParams): string {
  return [
    "Codex requested file-change approval.",
    `Turn: ${params.turnId}`,
    `Item: ${params.itemId}`
  ].join("\n");
}

function parseUserInputResponse(
  text: string,
  questions: UserInputServerRequest["params"]["questions"]
): ToolRequestUserInputResponse {
  if (questions.length === 1) {
    const question = questions[0];
    if (!question) {
      throw new Error("Expected a single question for user input parsing");
    }

    return {
      answers: {
        [question.id]: {
          answers: [text.trim()]
        }
      }
    };
  }

  const parsed = JSON.parse(text) as Record<string, string | Array<string>>;
  const answers = Object.fromEntries(
    questions.map((question) => {
      const value = parsed[question.id];
      const normalized = Array.isArray(value) ? value : value ? [value] : [];
      return [question.id, { answers: normalized }];
    })
  );

  return { answers };
}

function parseRequestId(value: string): RequestId {
  return JSON.parse(value) as RequestId;
}

function normalizeCommandApprovalDecision(action: string): CommandExecutionApprovalDecision {
  switch (action) {
    case "accept":
      return "accept";
    case "acceptForSession":
      return "acceptForSession";
    case "decline":
      return "decline";
    case "cancel":
    default:
      return "cancel";
  }
}

function normalizeFileApprovalDecision(action: string): FileChangeApprovalDecision {
  switch (action) {
    case "accept":
      return "accept";
    case "acceptForSession":
      return "acceptForSession";
    case "decline":
      return "decline";
    case "cancel":
    default:
      return "cancel";
  }
}

function isSteerRaceMessage(messageText: string, data?: Record<string, unknown> | null): boolean {
  const message = messageText.toLowerCase();
  const dataKind = typeof data?.kind === "string" ? data.kind.toLowerCase() : "";
  return [
    "expectedturnid",
    "active turn",
    "not active",
    "no active turn",
    "does not match",
    "mismatch",
    "precondition",
    "stale",
    "invalid_active_turn"
  ].some((needle) => message.includes(needle) || dataKind.includes(needle));
}
