import type { AppConfig } from "./config";
import { BridgeDatabase } from "./db";
import type { TopicLifecycleEvent, TopicSession, UserTurnMessage } from "./domain";
import type { ServerNotification } from "./generated/codex/ServerNotification";
import type { ServerRequest } from "./generated/codex/ServerRequest";
import type { RequestId } from "./generated/codex/RequestId";
import type { UserInput } from "./generated/codex/v2/UserInput";
import type { CommandExecutionApprovalDecision } from "./generated/codex/v2/CommandExecutionApprovalDecision";
import type { FileChangeApprovalDecision } from "./generated/codex/v2/FileChangeApprovalDecision";
import type { ToolRequestUserInputResponse } from "./generated/codex/v2/ToolRequestUserInputResponse";
import {
  classifyInterruptError,
  classifySteerError,
  formatError
} from "./bridge/error-handling";
import { TemporaryImageStore, type PreparedImageFiles } from "./media-store";
import { buildUserInputSignature } from "./bridge/input-signature";
import { getNotificationTurnId } from "./bridge/notifications";
import {
  buildTurnControlKeyboard,
  buildQueuePreviewKeyboard,
  deriveTopicTitle,
  renderQueuePreview,
  renderTurnControlMessage,
} from "./bridge/presentation";
import { BridgeRequestCoordinator } from "./bridge/request-coordinator";
import { TurnLifecycleCoordinator, type TurnContext } from "./bridge/turn-lifecycle";
import { TelegramMessenger, type TelegramApi } from "./telegram-messenger";
import { BridgeTurnRuntime, type QueueStateSnapshot } from "./turn-runtime";

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

type PreparedCodexInput = {
  input: UserInput[];
  images: PreparedImageFiles;
};
export class TelegramCodexBridge {
  readonly #queuePreviewMessageIds = new Map<string, number>();
  readonly #notificationChains = new Map<string, Promise<void>>();
  readonly #messenger: TelegramMessenger;
  readonly #lifecycle: TurnLifecycleCoordinator;
  readonly #requestCoordinator: BridgeRequestCoordinator;

  constructor(
    private readonly config: AppConfig,
    private readonly database: BridgeDatabase,
    private readonly telegram: TelegramApi,
    private readonly codex: BridgeCodexApi,
    private readonly mediaStore: TemporaryImageStore
  ) {
    this.#messenger = new TelegramMessenger(telegram);
    this.#lifecycle = new TurnLifecycleCoordinator({
      runtime: new BridgeTurnRuntime(),
      messenger: this.#messenger,
      telegram,
      releaseTurnFiles: (turnId) => this.mediaStore.releaseTurnFiles(turnId),
      appendTurnStream: (turnId, streamText) => this.database.appendTurnStream(turnId, streamText).then(() => undefined),
      completePersistedTurn: (turnId, messageId, status) =>
        this.database.completeTurn(turnId, messageId, status).then(() => undefined),
      resolveTurnText: this.resolveTurnText.bind(this),
      syncQueuePreview: this.syncQueuePreview.bind(this),
      maybeSendNextQueuedFollowUp: this.maybeSendNextQueuedFollowUp.bind(this),
      submitQueuedFollowUp: this.submitQueuedFollowUp.bind(this)
    });
    this.#requestCoordinator = new BridgeRequestCoordinator(
      config,
      database,
      telegram,
      codex,
      (turnId, statusDraft, force, preserveDetails) =>
        this.#lifecycle.updateStatus(turnId, statusDraft, {
          ...(force !== undefined ? { force } : {}),
          ...(preserveDetails !== undefined ? { preserveDetails } : {})
        })
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
    if ((action !== "sendNow" && action !== "stop") || !turnId) {
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

    if (action === "stop") {
      await this.stopActiveTurn(activeTurn, event);
      return;
    }

    if (activeTurn.stopRequested) {
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: "Interrupt already requested."
      });
      return;
    }

    const queueState = this.#lifecycle.getQueueState(event.chatId, event.topicId);
    if (queueState.pendingSteers.length === 0) {
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: "No pending steer instructions to send."
      });
      return;
    }

    this.#lifecycle.requestPendingSteerSubmissionAfterInterrupt(turnId);

    try {
      await this.codex.interruptTurn(activeTurn.threadId, activeTurn.turnId);
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: "Submitting queued steer instructions."
      });
    } catch (error) {
      const classification = classifyInterruptError(error);
      if (classification.kind === "stale_or_missing_active_turn") {
        this.#lifecycle.requestPendingSteerSubmissionAfterInterrupt(turnId);
        await this.#lifecycle.finalizeInterruptedTurnById(activeTurn.threadId, activeTurn.turnId);
        await this.telegram.answerCallbackQuery(event.callbackQueryId, {
          text: "Previous turn already ended. Submitting queued steer instructions."
        });
        return;
      }

      this.#lifecycle.clearPendingSteerSubmissionAfterInterrupt(turnId);

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

  private async stopActiveTurn(activeTurn: TurnContext, event: CallbackQueryEvent): Promise<void> {
    if (activeTurn.stopRequested) {
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: "Interrupt already requested."
      });
      return;
    }

    this.#lifecycle.markStopRequested(activeTurn.turnId);
    await this.#lifecycle.updateTurnControlMessage(activeTurn.turnId, renderTurnControlMessage("stopping"));
    await this.syncQueuePreview(this.#lifecycle.getQueueState(activeTurn.chatId, activeTurn.topicId));

    try {
      await this.codex.interruptTurn(activeTurn.threadId, activeTurn.turnId);
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: "Stopping current turn."
      });
    } catch (error) {
      const classification = classifyInterruptError(error);
      if (classification.kind === "stale_or_missing_active_turn") {
        await this.#lifecycle.updateTurnControlMessage(activeTurn.turnId, renderTurnControlMessage("finishing"));
        await this.telegram.answerCallbackQuery(event.callbackQueryId, {
          text: "This turn is already finishing."
        });
        return;
      }

      this.#lifecycle.clearStopRequested(activeTurn.turnId);
      await this.#lifecycle.updateTurnControlMessage(
        activeTurn.turnId,
        renderTurnControlMessage("active"),
        buildTurnControlKeyboard(activeTurn.turnId)
      );
      await this.syncQueuePreview(this.#lifecycle.getQueueState(activeTurn.chatId, activeTurn.topicId));

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
    const turn = await this.submitPreparedInput(message, {
      submit: (input) => this.codex.sendTurn(session.codexThreadId!, input)
    });

    await this.database.recordTurnStart({
      telegramUpdateId: message.updateId,
      telegramChatId: String(message.chatId),
      telegramTopicId: message.topicId,
      codexThreadId: session.codexThreadId,
      codexTurnId: turn.id,
      draftId: message.updateId
    });

    const activeTurn = this.#lifecycle.activateTurn(message, session.codexThreadId, turn.id);
    await this.#lifecycle.sendTurnControlMessage(turn.id, message.messageId);
    if (activeTurn.statusDraft) {
      await this.#lifecycle.publishCurrentStatus(turn.id, true);
    }
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
    const handlers: Partial<Record<ServerNotification["method"], () => Promise<void>>> = {
      "turn/started": async () => {
        if (notification.method === "turn/started") {
          await this.#lifecycle.handleTurnStarted(notification.params.turn.id);
        }
      },
      "item/started": async () => {
        if (notification.method === "item/started") {
          await this.#lifecycle.handleItemStarted(notification.params.turnId, notification.params.item);
        }
      },
      "turn/plan/updated": async () => {
        if (notification.method === "turn/plan/updated") {
          await this.#lifecycle.handlePlanUpdated(notification.params.turnId);
        }
      },
      "item/reasoning/summaryTextDelta": async () => {
        if (notification.method === "item/reasoning/summaryTextDelta") {
          await this.#lifecycle.handleReasoningDelta(notification.params.turnId);
        }
      },
      "item/mcpToolCall/progress": async () => {
        if (notification.method === "item/mcpToolCall/progress") {
          await this.#lifecycle.handleToolProgress(notification.params.turnId);
        }
      },
      "item/commandExecution/outputDelta": async () => {
        if (notification.method === "item/commandExecution/outputDelta") {
          await this.#lifecycle.handleCommandOutput(notification.params.turnId);
        }
      },
      "item/fileChange/outputDelta": async () => {
        if (notification.method === "item/fileChange/outputDelta") {
          await this.#lifecycle.handleFileChangeOutput(notification.params.turnId);
        }
      },
      "item/agentMessage/delta": async () => {
        if (notification.method === "item/agentMessage/delta") {
          await this.#lifecycle.handleAssistantDelta(
            notification.params.turnId,
            notification.params.itemId,
            notification.params.delta
          );
        }
      },
      "item/completed": async () => {
        if (notification.method === "item/completed") {
          await this.#lifecycle.handleItemCompleted(notification.params.turnId, notification.params.item);
        }
      },
      "turn/completed": async () => {
        if (notification.method !== "turn/completed") {
          return;
        }

        if (notification.params.turn.status === "interrupted") {
          await this.#lifecycle.finalizeInterruptedTurnById(notification.params.threadId, notification.params.turn.id);
          return;
        }

        await this.#lifecycle.completeTurn(notification.params.threadId, notification.params.turn.id);
      },
      error: async () => {
        if (notification.method === "error") {
          await this.#lifecycle.failTurn(
            notification.params.threadId,
            notification.params.turnId,
            notification.params.error.message
          );
        }
      }
    };

    await handlers[notification.method]?.();
  }

  private async handleServerRequest(request: ServerRequest): Promise<void> {
    await this.#requestCoordinator.handleServerRequest(request);
  }

  private async tryResolveUserInput(message: UserTurnMessage): Promise<boolean> {
    return this.#requestCoordinator.tryResolveUserInput(message);
  }

  private findActiveTurnByTopic(chatId: number, topicId: number): TurnContext | undefined {
    return this.#lifecycle.getActiveTurnByTopic(chatId, topicId);
  }

  private async resolveTurnText(threadId: string, turnId: string): Promise<string> {
    const streamedText = this.#lifecycle.renderAssistantItems(turnId);
    const readbackText = await this.codex.readTurnMessages(threadId, turnId);
    return readbackText.trim().length > 0 ? readbackText : streamedText;
  }

  private async trySteerTurn(activeTurn: TurnContext, message: UserTurnMessage): Promise<void> {
    if (message.topicId === null) {
      return;
    }

    const pending = this.#lifecycle.queuePendingSteer(activeTurn.turnId, message);
    if (!pending) {
      return;
    }
    await this.syncQueuePreview(pending.queueState);

    try {
      await this.submitPreparedInput(message, {
        attachTurnId: activeTurn.turnId,
        submit: (input) => this.codex.steerTurn(activeTurn.threadId, activeTurn.turnId, input)
      });
    } catch (error) {
      const classification = classifySteerError(error);
      if (classification.kind === "stale_or_missing_active_turn") {
        const queueState = this.#lifecycle.movePendingSteerToQueued(message.chatId, message.topicId, pending.localId);
        await this.syncQueuePreview(queueState);
        return;
      }

      const queueState = this.#lifecycle.dropPendingSteer(message.chatId, message.topicId, pending.localId);
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
    }
  }

  private async submitPreparedInput(
    message: UserTurnMessage,
    options: {
      attachTurnId?: string;
      submit(input: UserInput[]): Promise<{ id?: string; turnId?: string }>;
    }
  ): Promise<{ id: string }> {
    const preparedInput = await this.materializeCodexInput(message);
    try {
      const result = await options.submit(preparedInput.input);
      const resolvedTurnId = options.attachTurnId ?? result.id ?? result.turnId;
      if (!resolvedTurnId) {
        throw new Error("Codex submission did not return a turn id");
      }
      preparedInput.images.attachToTurn(resolvedTurnId);
      return { id: resolvedTurnId };
    } catch (error) {
      await preparedInput.images.discard();
      throw error;
    }
  }

  private async submitQueuedFollowUp(chatId: number, topicId: number, message: UserTurnMessage): Promise<void> {
    const session = await this.database.getSessionByTopic(chatId, topicId);
    if (!session?.codexThreadId) {
      return;
    }

    await this.sendTurnForSession(session, message);
  }

  private async materializeCodexInput(message: UserTurnMessage): Promise<PreparedCodexInput> {
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
    return {
      input,
      images: this.mediaStore.prepareImageFiles(tempPaths)
    };
  }

  private async syncQueuePreview(queueState: QueueStateSnapshot): Promise<void> {
    const previewText = renderQueuePreview(queueState);
    const key = topicKey(queueState.chatId, queueState.topicId);
    const existingMessageId = this.#queuePreviewMessageIds.get(key) ?? null;
    const activeTurn = this.findActiveTurnByTopic(queueState.chatId, queueState.topicId);
    const replyMarkup = buildQueuePreviewKeyboard(
      queueState,
      activeTurn?.turnId ?? null,
      activeTurn?.stopRequested ?? false
    );

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

    const nextMessage = this.#lifecycle.peekNextQueuedFollowUp(chatId, topicId);
    if (!nextMessage) {
      return;
    }

    const session = await this.database.getSessionByTopic(chatId, topicId);
    if (!session?.codexThreadId) {
      return;
    }

    await this.sendTurnForSession(session, nextMessage);
    this.#lifecycle.shiftNextQueuedFollowUp(chatId, topicId);
    await this.syncQueuePreview(this.#lifecycle.getQueueState(chatId, topicId));
  }

}

function topicKey(chatId: number, topicId: number): string {
  return `${chatId}:${topicId}`;
}
