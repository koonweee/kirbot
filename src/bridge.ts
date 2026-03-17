import type { AppConfig } from "./config";
import { BridgeDatabase } from "./db";
import type { SessionMode, TopicLifecycleEvent, TopicSession, UserTurnMessage } from "./domain";
import type { CollaborationMode } from "./generated/codex/CollaborationMode";
import type { ReasoningEffort } from "./generated/codex/ReasoningEffort";
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
  buildRenderedInitialPromptMessage,
  buildQueuePreviewKeyboard,
  deriveTopicTitle,
  renderQueuePreview
} from "./bridge/presentation";
import { BridgeRequestCoordinator } from "./bridge/request-coordinator";
import { TurnLifecycleCoordinator, type TurnContext } from "./bridge/turn-lifecycle";
import type { ResolvedTurnSnapshot } from "./bridge/turn-finalization";
import { isAllowedRootCommand, isAllowedTopicCommand } from "./telegram-commands";
import { TelegramMessenger, type TelegramApi } from "./telegram-messenger";
import { BridgeTurnRuntime, type QueueStateSnapshot } from "./turn-runtime";

export type CallbackQueryEvent = {
  callbackQueryId: string;
  data: string;
  chatId: number;
  topicId: number | null;
  userId: number;
};

export interface BridgeCodexApi {
  createThread(title: string): Promise<{ threadId: string } & ThreadStartSettings>;
  ensureThreadLoaded(threadId: string): Promise<ThreadStartSettings>;
  sendTurn(threadId: string, input: UserInput[], collaborationMode?: CollaborationMode | null): Promise<{ id: string }>;
  steerTurn(threadId: string, expectedTurnId: string, input: UserInput[]): Promise<{ turnId: string }>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  archiveThread(threadId: string): Promise<void>;
  readTurnSnapshot(threadId: string, turnId: string): Promise<ResolvedTurnSnapshot>;
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

type ParsedSlashCommand = {
  command: string;
  argsText: string;
};

type ThreadStartSettings = {
  model: string;
  reasoningEffort: ReasoningEffort | null;
};

const INVALID_COMMAND_TEXT = "This command is not valid here.";
const NO_ACTIVE_RESPONSE_TO_STOP_TEXT = "There is no active response to stop right now.";
const STOPPING_CURRENT_RESPONSE_TEXT = "Stopping the current response…";
const RESPONSE_ALREADY_FINISHING_TEXT = "This response is already finishing.";
const MODE_CHANGE_REJECTED_TEXT = "Wait for the current response to finish or stop it first before changing modes.";
const MODE_COMMAND_REQUIRES_SESSION_TEXT = "This topic does not have a Codex session yet. Send a normal message first to start one.";
const PLAN_MODE_ENABLED_TEXT = "Plan mode enabled.";
const PLAN_MODE_EXITED_TEXT = "Exited plan mode.";
const DEFAULT_NEW_PLAN_SESSION_TITLE = "New Plan Session";

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
      completePersistedTurn: (turnId, messageId, status, resolvedText) =>
        this.database.completeTurn(turnId, messageId, status, resolvedText).then(() => undefined),
      resolveTurnSnapshot: this.resolveTurnSnapshot.bind(this),
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
    if (message.userId !== this.config.telegram.userId) {
      return;
    }

    const inserted = await this.database.markUpdateProcessed(message.updateId);
    if (!inserted) {
      return;
    }

    if (message.topicId === null) {
      await this.handleRootMessage(message);
      return;
    }

    await this.handleTopicMessage(message);
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
    if (event.userId !== this.config.telegram.userId) {
      return;
    }

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

  private async handleRootMessage(message: UserTurnMessage): Promise<void> {
    const command = parseSlashCommand(message);
    if (command) {
      if (!isAllowedRootCommand(command.command)) {
        await this.sendInvalidSlashCommandMessage(message);
        return;
      }

      await this.handleRootSlashCommand(message, command);
      return;
    }

    await this.startSessionFromRootMessage(message);
  }

  private async handleTopicMessage(message: UserTurnMessage): Promise<void> {
    const command = parseSlashCommand(message);
    if (command) {
      if (!isAllowedTopicCommand(command.command)) {
        await this.sendInvalidSlashCommandMessage(message);
        return;
      }

      await this.handleTopicSlashCommand(message, command);
      return;
    }

    const resolvedPendingInput = await this.tryResolveUserInput(message);
    if (resolvedPendingInput) {
      return;
    }

    if (message.topicId === null) {
      await this.#messenger.sendMessage({
        chatId: message.chatId,
        text: "Could not determine a Telegram topic for this message, so no Codex session was started."
      });
      return;
    }

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
  }

  private async handleRootSlashCommand(message: UserTurnMessage, command: ParsedSlashCommand): Promise<void> {
    if (command.command === "plan") {
      await this.startPlanSessionFromRootMessage(message, command.argsText);
      return;
    }

    await this.sendInvalidSlashCommandMessage(message);
  }

  private async handleTopicSlashCommand(message: UserTurnMessage, command: ParsedSlashCommand): Promise<void> {
    if (command.command === "stop") {
      await this.stopActiveTurn(message);
      return;
    }

    if (command.command === "plan") {
      await this.enterPlanMode(message, command.argsText);
      return;
    }

    if (command.command === "implement") {
      await this.implementLatestPlan(message, command.argsText);
      return;
    }

    await this.sendInvalidSlashCommandMessage(message);
  }

  private async enterPlanMode(message: UserTurnMessage, promptText: string): Promise<void> {
    const session = await this.requireModeCommandSession(message);
    if (!session) {
      return;
    }

    if (this.findActiveTurnByTopic(message.chatId, message.topicId!)) {
      await this.#messenger.sendMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: MODE_CHANGE_REJECTED_TEXT
      });
      return;
    }

    const updatedSession = await this.database.updateSessionPreferredMode(message.chatId, message.topicId!, "plan");
    if (!updatedSession) {
      await this.#messenger.sendMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: MODE_COMMAND_REQUIRES_SESSION_TEXT
      });
      return;
    }

    if (!promptText.trim()) {
      await this.#messenger.sendMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: PLAN_MODE_ENABLED_TEXT
      });
      return;
    }

    await this.#messenger.sendMessage({
      chatId: message.chatId,
      topicId: message.topicId,
      text: PLAN_MODE_ENABLED_TEXT
    });
    await this.sendTurnForSession(updatedSession, replaceMessageText(message, promptText));
  }

  private async implementLatestPlan(message: UserTurnMessage, extraInstructions: string): Promise<void> {
    const session = await this.requireModeCommandSession(message);
    if (!session) {
      return;
    }

    if (this.findActiveTurnByTopic(message.chatId, message.topicId!)) {
      await this.#messenger.sendMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: MODE_CHANGE_REJECTED_TEXT
      });
      return;
    }

    const updatedSession = await this.database.updateSessionPreferredMode(message.chatId, message.topicId!, "default");
    if (!updatedSession) {
      await this.#messenger.sendMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: MODE_COMMAND_REQUIRES_SESSION_TEXT
      });
      return;
    }

    await this.#messenger.sendMessage({
      chatId: message.chatId,
      topicId: message.topicId,
      text: PLAN_MODE_EXITED_TEXT
    });
    await this.sendTurnForSession(
      updatedSession,
      replaceMessageText(message, buildImplementationPrompt(extraInstructions)),
      {
        forceMode: "default"
      }
    );
  }

  private async requireModeCommandSession(message: UserTurnMessage): Promise<TopicSession | null> {
    if (message.topicId === null) {
      await this.sendInvalidSlashCommandMessage(message);
      return null;
    }

    const session = await this.database.getSessionByTopic(message.chatId, message.topicId);
    if (!session) {
      await this.#messenger.sendMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: MODE_COMMAND_REQUIRES_SESSION_TEXT
      });
      return null;
    }

    if (!session.codexThreadId) {
      await this.#messenger.sendMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: "This topic is still provisioning a Codex session. Try again in a moment."
      });
      return null;
    }

    return session;
  }

  private async stopActiveTurn(message: UserTurnMessage): Promise<void> {
    if (message.topicId === null) {
      await this.sendInvalidSlashCommandMessage(message);
      return;
    }

    const activeTurn = this.findActiveTurnByTopic(message.chatId, message.topicId);
    if (!activeTurn) {
      await this.#messenger.sendMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: NO_ACTIVE_RESPONSE_TO_STOP_TEXT
      });
      return;
    }

    if (activeTurn.stopRequested) {
      await this.#messenger.sendMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: "Interrupt already requested."
      });
      return;
    }

    this.#lifecycle.markStopRequested(activeTurn.turnId);
    await this.syncQueuePreview(this.#lifecycle.getQueueState(activeTurn.chatId, activeTurn.topicId));

    try {
      await this.codex.interruptTurn(activeTurn.threadId, activeTurn.turnId);
      await this.#messenger.sendMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: STOPPING_CURRENT_RESPONSE_TEXT
      });
    } catch (error) {
      const classification = classifyInterruptError(error);
      if (classification.kind === "stale_or_missing_active_turn") {
        await this.#lifecycle.finalizeInterruptedTurnById(activeTurn.threadId, activeTurn.turnId);
        await this.#messenger.sendMessage({
          chatId: message.chatId,
          topicId: message.topicId,
          text: RESPONSE_ALREADY_FINISHING_TEXT
        });
        return;
      }

      this.#lifecycle.clearStopRequested(activeTurn.turnId);
      await this.syncQueuePreview(this.#lifecycle.getQueueState(activeTurn.chatId, activeTurn.topicId));

      console.error("Failed to interrupt turn", error);
      await this.#messenger.sendMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: `Failed to interrupt the current turn: ${formatError(error)}`
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
      {
        initialPromptText: message.text
      }
    );
  }

  private async startPlanSessionFromRootMessage(message: UserTurnMessage, promptText: string): Promise<void> {
    const trimmedPrompt = promptText.trim();
    const title = trimmedPrompt ? deriveTopicTitle(trimmedPrompt) : DEFAULT_NEW_PLAN_SESSION_TITLE;
    const forumTopic = await this.telegram.createForumTopic(message.chatId, title);
    const topicMessage = {
      ...message,
      topicId: forumTopic.message_thread_id
    };

    await this.startSessionInTopic(
      topicMessage,
      title,
      {
        initialPromptText: trimmedPrompt,
        initialPreferredMode: "plan",
        postActivationTopicMessage: PLAN_MODE_ENABLED_TEXT,
        startInitialTurn: trimmedPrompt.length > 0,
        ...(trimmedPrompt ? {
          firstTurnMessage: replaceMessageText(topicMessage, trimmedPrompt)
        } : {})
      }
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
    options?: {
      initialPromptText?: string;
      initialPreferredMode?: SessionMode;
      startInitialTurn?: boolean;
      firstTurnMessage?: UserTurnMessage;
      postActivationTopicMessage?: string;
    }
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
      const thread = await this.codex.createThread(title);
      let session = await this.database.activateSession(pending.id, thread.threadId);

      if (options?.initialPreferredMode && session.preferredMode !== options.initialPreferredMode) {
        session = await this.database.updateSessionPreferredMode(
          Number(session.telegramChatId),
          session.telegramTopicId,
          options.initialPreferredMode
        ) ?? session;
      }

      await this.maybeSendInitialPromptMessage(message.chatId, message.topicId, options?.initialPromptText);

      if (options?.postActivationTopicMessage) {
        await this.#messenger.sendMessage({
          chatId: message.chatId,
          topicId: message.topicId,
          text: options.postActivationTopicMessage
        });
      }

      if (options?.startInitialTurn ?? true) {
        await this.sendTurnForSession(session, options?.firstTurnMessage ?? message);
      }
    } catch (error) {
      await this.database.markSessionErrored(pending.id);
      await this.#messenger.sendMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: `Failed to create Codex session for "${title}": ${formatError(error)}`
      });
    }
  }

  private async maybeSendInitialPromptMessage(
    chatId: number,
    topicId: number,
    promptText: string | null | undefined
  ): Promise<void> {
    if (!promptText) {
      return;
    }

    try {
      const rendered = buildRenderedInitialPromptMessage(promptText);
      await this.#messenger.sendMessage({
        chatId,
        topicId,
        text: rendered.text,
        ...(rendered.entities ? { entities: rendered.entities } : {})
      });
    } catch (error) {
      console.error("Failed to send initial prompt mirror into Telegram topic", error);
    }
  }

  private async sendTurnForSession(
    session: TopicSession,
    message: UserTurnMessage,
    options?: {
      forceMode?: SessionMode;
    }
  ): Promise<void> {
    if (!session.codexThreadId) {
      throw new Error(`Session ${session.id} has no Codex thread id`);
    }

    if (message.topicId === null) {
      throw new Error("Cannot send a Codex turn without a Telegram topic id");
    }

    const thread = await this.codex.ensureThreadLoaded(session.codexThreadId);
    const turn = await this.submitPreparedInput(message, {
      submit: (input) =>
        this.codex.sendTurn(
          session.codexThreadId!,
          input,
          buildTurnCollaborationMode(
            options?.forceMode ?? session.preferredMode,
            thread,
            this.config.codex.developerInstructions ?? null,
            options?.forceMode === "default"
          )
        )
    });

    await this.database.recordTurnStart({
      telegramUpdateId: message.updateId,
      telegramChatId: String(message.chatId),
      telegramTopicId: message.topicId,
      codexThreadId: session.codexThreadId,
      codexTurnId: turn.id,
      draftId: message.updateId
    });

    const activeTurn = this.#lifecycle.activateTurn(
      message,
      session.codexThreadId,
      turn.id,
      thread.model,
      thread.reasoningEffort
    );
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
          await this.#lifecycle.handlePlanUpdated(
            notification.params.turnId,
            buildPlanStatusDetails(notification.params.explanation, notification.params.plan)
          );
        }
      },
      "thread/tokenUsage/updated": async () => {
        if (notification.method === "thread/tokenUsage/updated") {
          this.#lifecycle.handleThreadTokenUsageUpdated(notification.params.turnId, notification.params.tokenUsage);
        }
      },
      "item/reasoning/summaryTextDelta": async () => {
        if (notification.method === "item/reasoning/summaryTextDelta") {
          await this.#lifecycle.handleReasoningDelta(notification.params.turnId);
        }
      },
      "model/rerouted": async () => {
        if (notification.method === "model/rerouted") {
          this.#lifecycle.handleModelRerouted(notification.params.turnId, notification.params.toModel);
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
      "item/plan/delta": async () => {
        if (notification.method === "item/plan/delta") {
          await this.#lifecycle.handlePlanDelta(notification.params.turnId, notification.params.itemId, notification.params.delta);
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

  private async sendInvalidSlashCommandMessage(message: UserTurnMessage): Promise<void> {
    await this.#messenger.sendMessage({
      chatId: message.chatId,
      ...(message.topicId !== null ? { topicId: message.topicId } : {}),
      text: INVALID_COMMAND_TEXT
    });
  }

  private async resolveTurnSnapshot(threadId: string, turnId: string): Promise<ResolvedTurnSnapshot> {
    const streamedAssistantText = this.#lifecycle.renderAssistantItems(turnId);
    const streamedPlanText = this.#lifecycle.renderPlanItems(turnId);
    const snapshot = await this.codex.readTurnSnapshot(threadId, turnId);
    return {
      ...snapshot,
      assistantText: snapshot.assistantText.trim().length > 0 ? snapshot.assistantText : streamedAssistantText,
      planText: snapshot.planText.trim().length > 0 ? snapshot.planText : streamedPlanText,
      text:
        snapshot.text.trim().length > 0
          ? snapshot.text
          : streamedAssistantText.trim().length > 0
            ? streamedAssistantText
            : streamedPlanText
    };
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

function parseSlashCommand(message: UserTurnMessage): ParsedSlashCommand | null {
  if (message.input.length !== 1) {
    return null;
  }

  const [input] = message.input;
  if (!input || input.type !== "text") {
    return null;
  }

  const trimmed = input.text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const [token, ...rest] = trimmed.split(/\s+/);
  if (!token || token === "/") {
    return null;
  }

  return {
    command: token.slice(1),
    argsText: rest.join(" ").trim()
  };
}

function buildTurnCollaborationMode(
  preferredMode: SessionMode,
  settings: ThreadStartSettings,
  developerInstructions: string | null,
  explicitDefault = false
): CollaborationMode | null {
  if (preferredMode === "plan") {
    return {
      mode: "plan",
      settings: {
        model: settings.model,
        reasoning_effort: settings.reasoningEffort,
        developer_instructions: null
      }
    };
  }

  if (!explicitDefault) {
    return null;
  }

  return {
    mode: "default",
    settings: {
      model: settings.model,
      reasoning_effort: settings.reasoningEffort,
      developer_instructions: developerInstructions
    }
  };
}

function replaceMessageText(message: UserTurnMessage, text: string): UserTurnMessage {
  return {
    ...message,
    text,
    input: [
      {
        type: "text",
        text,
        text_elements: []
      }
    ]
  };
}

function buildImplementationPrompt(extraInstructions: string): string {
  const parts = ["Implement the plan."];
  const trimmedInstructions = extraInstructions.trim();
  if (trimmedInstructions) {
    parts.push("", "Additional instructions:", trimmedInstructions);
  }

  return parts.join("\n");
}

function buildPlanStatusDetails(
  explanation: string | null,
  plan: Array<{ step: string; status: "pending" | "inProgress" | "completed" }>
): string | null {
  const trimmedExplanation = explanation?.trim();
  if (trimmedExplanation) {
    return trimmedExplanation;
  }

  const activeStep = plan.find((step) => step.status === "inProgress");
  return activeStep?.step ?? null;
}

function topicKey(chatId: number, topicId: number): string {
  return `${chatId}:${topicId}`;
}
