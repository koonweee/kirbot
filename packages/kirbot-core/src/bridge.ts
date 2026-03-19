import type { AppConfig } from "./config";
import { BridgeDatabase } from "./db";
import type { SessionMode, TopicLifecycleEvent, TopicSession, UserTurnMessage } from "./domain";
import type { Model } from "@kirbot/codex-client/generated/codex/v2/Model";
import type { CollaborationMode } from "@kirbot/codex-client/generated/codex/CollaborationMode";
import type { ReasoningEffort } from "@kirbot/codex-client/generated/codex/ReasoningEffort";
import type { ServiceTier } from "@kirbot/codex-client/generated/codex/ServiceTier";
import type { ServerNotification } from "@kirbot/codex-client/generated/codex/ServerNotification";
import type { ServerRequest } from "@kirbot/codex-client/generated/codex/ServerRequest";
import type { RequestId } from "@kirbot/codex-client/generated/codex/RequestId";
import type { AskForApproval } from "@kirbot/codex-client/generated/codex/v2/AskForApproval";
import type { UserInput } from "@kirbot/codex-client/generated/codex/v2/UserInput";
import type { CommandExecutionApprovalDecision } from "@kirbot/codex-client/generated/codex/v2/CommandExecutionApprovalDecision";
import type { FileChangeApprovalDecision } from "@kirbot/codex-client/generated/codex/v2/FileChangeApprovalDecision";
import type { PermissionsRequestApprovalResponse } from "@kirbot/codex-client/generated/codex/v2/PermissionsRequestApprovalResponse";
import type { SandboxPolicy } from "@kirbot/codex-client/generated/codex/v2/SandboxPolicy";
import type { ToolRequestUserInputResponse } from "@kirbot/codex-client/generated/codex/v2/ToolRequestUserInputResponse";
import {
  classifyInterruptError,
  classifySteerError,
  formatError
} from "./bridge/error-handling";
import { RandomTopicIconPicker, type TopicIconPicker } from "./bridge/topic-icons";
import { TemporaryImageStore, type PreparedImageFiles } from "./media-store";
import { buildUserInputSignature } from "./bridge/input-signature";
import { getNotificationTurnId } from "./bridge/notifications";
import {
  CODEX_PERMISSION_PRESETS,
  applyCodexThreadSettingsOverride,
  clearPendingCodexThreadSettings,
  detectCodexPermissionPreset,
  getCodexPermissionPreset,
  getEffectiveCodexThreadSettings,
  hasPendingCodexThreadSettings,
  type CodexPermissionPresetId,
  type CodexThreadSettings,
  type CodexThreadSettingsOverride,
  type StoredCodexThreadSettings,
  withUpdatedCurrentCodexThreadSettings,
  withUpdatedPendingCodexThreadSettings
} from "./bridge/codex-thread-settings";
import {
  isAllowedSlashCommandInScope,
  isCodexSlashCommand,
  parseSlashCommand,
  type ParsedSlashCommand
} from "./bridge/slash-commands";
import {
  buildRenderedInitialPromptMessage,
  buildQueuePreviewKeyboard,
  deriveTopicTitle,
  renderQueuePreview,
  TOPIC_IMPLEMENT_CALLBACK_DATA
} from "./bridge/presentation";
import { BridgeRequestCoordinator } from "./bridge/request-coordinator";
import { TurnLifecycleCoordinator, type TurnContext } from "./bridge/turn-lifecycle";
import type { ResolvedTurnSnapshot } from "./bridge/turn-finalization";
import type { LoggerLike } from "./logging";
import { TelegramMessenger, type TelegramApi } from "./telegram-messenger";
import { BridgeTurnRuntime, type QueueStateSnapshot } from "./turn-runtime";
import type { AppServerEvent } from "@kirbot/codex-client";

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
  sendTurn(
    threadId: string,
    input: UserInput[],
    options?: {
      collaborationMode?: CollaborationMode | null;
      overrides?: CodexThreadSettingsOverride | null;
    }
  ): Promise<{ id: string }>;
  steerTurn(threadId: string, expectedTurnId: string, input: UserInput[]): Promise<{ turnId: string }>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  archiveThread(threadId: string): Promise<void>;
  readTurnSnapshot(threadId: string, turnId: string): Promise<ResolvedTurnSnapshot>;
  listModels(): Promise<Model[]>;
  respondToCommandApproval(id: RequestId, response: { decision: CommandExecutionApprovalDecision }): Promise<void>;
  respondToFileChangeApproval(id: RequestId, response: { decision: FileChangeApprovalDecision }): Promise<void>;
  respondToPermissionsApproval(id: RequestId, response: PermissionsRequestApprovalResponse): Promise<void>;
  respondToUserInputRequest(id: RequestId, response: ToolRequestUserInputResponse): Promise<void>;
  respondUnsupportedRequest(id: RequestId, message: string): Promise<void>;
  nextEvent(): Promise<AppServerEvent | null>;
}

type PreparedCodexInput = {
  input: UserInput[];
  images: PreparedImageFiles;
};

type ThreadStartSettings = CodexThreadSettings;

const INVALID_COMMAND_TEXT = "This command is not valid here.";
const NO_ACTIVE_RESPONSE_TO_STOP_TEXT = "There is no active response to stop right now.";
const STOPPING_CURRENT_RESPONSE_TEXT = "Stopping the current response…";
const RESPONSE_ALREADY_FINISHING_TEXT = "This response is already finishing.";
const MODE_CHANGE_REJECTED_TEXT = "Wait for the current response to finish or stop it first before changing modes.";
const MODE_COMMAND_REQUIRES_SESSION_TEXT = "This topic does not have a Codex session yet. Send a normal message first to start one.";
const NATIVE_SETTINGS_REJECTED_TEXT =
  "Wait for the current response to finish or stop it first before changing native Codex settings.";
const FAST_USAGE_TEXT = "Usage: /fast [on|off|status]";
const PLAN_MODE_ENABLED_TEXT = "Plan mode enabled.";
const PLAN_MODE_EXITED_TEXT = "Exited plan mode.";
const DEFAULT_NEW_PLAN_SESSION_TITLE = "New Plan Session";
const STAGED_TURN_EVENT_TIMEOUT_MS = 10_000;
const MODEL_PAGE_SIZE = 6;

export class TelegramCodexBridge {
  readonly #queuePreviewMessageIds = new Map<string, number>();
  readonly #notificationChains = new Map<string, Promise<void>>();
  readonly #stagedTurnEvents = new Map<string, AppServerEvent[]>();
  readonly #stagedTurnEventTimers = new Map<string, NodeJS.Timeout>();
  readonly #turnsAwaitingActivation = new Set<string>();
  readonly #messenger: TelegramMessenger;
  readonly #lifecycle: TurnLifecycleCoordinator;
  readonly #requestCoordinator: BridgeRequestCoordinator;
  readonly #topicIconPicker: TopicIconPicker;

  constructor(
    private readonly config: AppConfig,
    private readonly database: BridgeDatabase,
    private readonly telegram: TelegramApi,
    private readonly codex: BridgeCodexApi,
    private readonly mediaStore: TemporaryImageStore,
    private readonly logger: LoggerLike = console,
    options?: {
      topicIconPicker?: TopicIconPicker;
    }
  ) {
    this.#messenger = new TelegramMessenger(telegram, logger);
    this.#topicIconPicker = options?.topicIconPicker ?? new RandomTopicIconPicker(telegram, logger);
    this.#lifecycle = new TurnLifecycleCoordinator({
      runtime: new BridgeTurnRuntime(),
      messenger: this.#messenger,
      telegram,
      planArtifactPublicUrl: config.telegram.miniApp.publicUrl,
      releaseTurnFiles: (turnId) => this.mediaStore.releaseTurnFiles(turnId),
      resolveTurnSnapshot: this.resolveTurnSnapshot.bind(this),
      syncQueuePreview: this.syncQueuePreview.bind(this),
      maybeSendNextQueuedFollowUp: this.maybeSendNextQueuedFollowUp.bind(this),
      submitQueuedFollowUp: this.submitQueuedFollowUp.bind(this)
    }, logger);
    this.#requestCoordinator = new BridgeRequestCoordinator(
      config,
      database,
      telegram,
      codex,
      (turnId, statusDraft, force) =>
        this.#lifecycle.updateStatus(turnId, statusDraft, {
          ...(force !== undefined ? { force } : {})
        })
    );
    void this.consumeCodexEvents().catch((error) => {
      this.logger.error("Failed to consume Codex app-server events", error);
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
      this.logger.error("Failed to archive Codex thread", error);
    }
  }

  getActiveTurnCount(): number {
    return this.#lifecycle.getActiveTurnCount();
  }

  getActiveTopics(): Array<{ chatId: number; topicId: number }> {
    return this.#lifecycle.getActiveTopics();
  }

  async handleCallbackQuery(event: CallbackQueryEvent): Promise<void> {
    if (event.userId !== this.config.telegram.userId) {
      return;
    }

    if (await this.#requestCoordinator.handleCallbackQuery(event)) {
      return;
    }

    if (event.data.startsWith("slash:")) {
      await this.handleSlashCallbackQuery(event);
      return;
    }

    if (event.data.startsWith("turn:")) {
      await this.handleTurnCallbackQuery(event);
      return;
    }

    if (event.data === TOPIC_IMPLEMENT_CALLBACK_DATA) {
      await this.handleTopicImplementCallbackQuery(event);
      return;
    }

    await this.telegram.answerCallbackQuery(event.callbackQueryId, {
      text: "Unsupported callback."
    });
  }

  private async handleTopicImplementCallbackQuery(event: CallbackQueryEvent): Promise<void> {
    if (event.topicId === null) {
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: "This action requires a topic."
      });
      return;
    }

    await this.telegram.answerCallbackQuery(event.callbackQueryId);
    await this.implementLatestPlan(buildSyntheticCallbackMessage(event, "/implement"), "");
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

      this.logger.error("Failed to interrupt turn", error);
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
    const command = parseSlashCommand(message.text);
    if (command) {
      if (!isAllowedSlashCommandInScope(command.command, "root")) {
        await this.sendInvalidSlashCommandMessage(message);
        return;
      }

      await this.handleRootSlashCommand(message, command);
      return;
    }

    if (looksLikeSlashCommand(message.text)) {
      await this.sendInvalidSlashCommandMessage(message);
      return;
    }

    await this.startSessionFromRootMessage(message);
  }

  private async handleTopicMessage(message: UserTurnMessage): Promise<void> {
    const command = parseSlashCommand(message.text);
    if (command) {
      if (!isAllowedSlashCommandInScope(command.command, "topic")) {
        await this.sendInvalidSlashCommandMessage(message);
        return;
      }

      await this.handleTopicSlashCommand(message, command);
      return;
    }

    if (looksLikeSlashCommand(message.text)) {
      await this.sendInvalidSlashCommandMessage(message);
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
    if (isCodexSlashCommand(command.command)) {
      await this.handleCodexTopicSlashCommand(message, command);
      return;
    }

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

  private async handleCodexTopicSlashCommand(message: UserTurnMessage, command: ParsedSlashCommand): Promise<void> {
    const session = await this.requireCodexNativeSettingsSession(message);
    if (!session) {
      return;
    }

    if (command.command === "fast") {
      await this.handleFastSlashCommand(session, message, command.argsText);
      return;
    }

    if (command.command === "model") {
      await this.openModelSelection(session, { chatId: message.chatId, topicId: message.topicId! });
      return;
    }

    if (command.command === "permissions" || command.command === "approvals") {
      await this.openPermissionsSelection(session, message);
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

  private async requireCodexNativeSettingsSession(message: UserTurnMessage): Promise<TopicSession | null> {
    const session = await this.requireModeCommandSession(message);
    if (!session) {
      return null;
    }

    if (this.findActiveTurnByTopic(message.chatId, message.topicId!)) {
      await this.#messenger.sendMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: NATIVE_SETTINGS_REJECTED_TEXT
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

      this.logger.error("Failed to interrupt turn", error);
      await this.#messenger.sendMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: `Failed to interrupt the current turn: ${formatError(error)}`
      });
    }
  }

  private async handleFastSlashCommand(
    session: TopicSession,
    message: UserTurnMessage,
    argsText: string
  ): Promise<void> {
    const syncedSession = await this.syncSessionCodexSettings(session);
    const effective = getEffectiveCodexThreadSettings(syncedSession.codexSettings);
    if (!effective) {
      await this.#messenger.sendMessage({
        chatId: message.chatId,
        topicId: message.topicId!,
        text: "Codex settings are still loading for this topic. Try again in a moment."
      });
      return;
    }

    const normalizedArgs = argsText.trim().toLowerCase();
    if (normalizedArgs === "status") {
      await this.#messenger.sendMessage({
        chatId: message.chatId,
        topicId: message.topicId!,
        text: buildFastStatusMessage(effective.serviceTier)
      });
      return;
    }

    let nextTier: ServiceTier | null;
    if (!normalizedArgs) {
      nextTier = effective.serviceTier === "fast" ? null : "fast";
    } else if (normalizedArgs === "on") {
      nextTier = "fast";
    } else if (normalizedArgs === "off") {
      nextTier = null;
    } else {
      await this.#messenger.sendMessage({
        chatId: message.chatId,
        topicId: message.topicId!,
        text: FAST_USAGE_TEXT
      });
      return;
    }

    const updatedSession = await this.updateSessionPendingCodexSettings(syncedSession, {
      serviceTier: nextTier
    });
    const nextEffective = getEffectiveCodexThreadSettings(updatedSession.codexSettings);
    await this.#messenger.sendMessage({
      chatId: message.chatId,
      topicId: message.topicId!,
      text: buildFastUpdatedMessage(nextEffective?.serviceTier ?? null)
    });
  }

  private async openPermissionsSelection(session: TopicSession, message: UserTurnMessage): Promise<void> {
    const syncedSession = await this.syncSessionCodexSettings(session);
    const effective = getEffectiveCodexThreadSettings(syncedSession.codexSettings);
    const currentPresetId = detectCodexPermissionPreset(effective);
    const currentPreset = currentPresetId ? getCodexPermissionPreset(currentPresetId) : null;

    await this.#messenger.sendMessage({
      chatId: message.chatId,
      topicId: message.topicId!,
      text: [
        "Choose Codex permissions for this topic.",
        currentPreset ? `Current: ${currentPreset.label}` : "Current: Custom",
        "Your selection will be used when you send a message."
      ].join("\n"),
      replyMarkup: {
        inline_keyboard: CODEX_PERMISSION_PRESETS.map((preset) => [
          {
            text: `${preset.id === currentPresetId ? "• " : ""}${preset.label}`,
            callback_data: `slash:permissions:apply:${preset.id}`
          }
        ])
      }
    });
  }

  private async openModelSelection(
    session: TopicSession,
    message: { chatId: number; topicId: number },
    page = 0
  ): Promise<void> {
    const syncedSession = await this.syncSessionCodexSettings(session);
    const effective = getEffectiveCodexThreadSettings(syncedSession.codexSettings);
    const models = await this.codex.listModels();
    if (models.length === 0) {
      await this.#messenger.sendMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: "No visible Codex models are available right now."
      });
      return;
    }

    const totalPages = Math.max(1, Math.ceil(models.length / MODEL_PAGE_SIZE));
    const boundedPage = Math.min(Math.max(page, 0), totalPages - 1);
    const startIndex = boundedPage * MODEL_PAGE_SIZE;
    const pageModels = models.slice(startIndex, startIndex + MODEL_PAGE_SIZE);
    const currentModel = effective?.model ?? null;

    await this.#messenger.sendMessage({
      chatId: message.chatId,
      topicId: message.topicId,
      text: [
        "Choose the model for this topic.",
        currentModel ? `Current: ${currentModel}` : "Current: unknown-model",
        "Then choose a reasoning effort."
      ].join("\n"),
      replyMarkup: {
        inline_keyboard: [
          ...pageModels.map((model, index) => [
            {
              text: `${model.model === currentModel ? "• " : ""}${model.displayName}`,
              callback_data: `slash:model:pick:${startIndex + index}`
            }
          ]),
          ...(totalPages > 1
            ? [
                [
                  ...(boundedPage > 0
                    ? [{ text: "Previous", callback_data: `slash:model:page:${boundedPage - 1}` }]
                    : []),
                  ...(boundedPage < totalPages - 1
                    ? [{ text: "Next", callback_data: `slash:model:page:${boundedPage + 1}` }]
                    : [])
                ]
              ]
            : [])
        ]
      }
    });
  }

  private async openModelReasoningSelection(
    session: TopicSession,
    message: { chatId: number; topicId: number },
    modelIndex: number
  ): Promise<void> {
    const syncedSession = await this.syncSessionCodexSettings(session);
    const effective = getEffectiveCodexThreadSettings(syncedSession.codexSettings);
    const models = await this.codex.listModels();
    const model = models[modelIndex];
    if (!model) {
      await this.#messenger.sendMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: "That model is no longer available."
      });
      return;
    }

    const currentEffort =
      effective?.model === model.model ? effective.reasoningEffort ?? model.defaultReasoningEffort : model.defaultReasoningEffort;

    await this.#messenger.sendMessage({
      chatId: message.chatId,
      topicId: message.topicId,
      text: `Choose the reasoning effort for ${model.displayName}.`,
      replyMarkup: {
        inline_keyboard: model.supportedReasoningEfforts.map((option) => [
          {
            text: `${option.reasoningEffort === currentEffort ? "• " : ""}${option.reasoningEffort}`,
            callback_data: `slash:model:apply:${modelIndex}:${option.reasoningEffort}`
          }
        ])
      }
    });
  }

  private async applyModelSelection(
    session: TopicSession,
    message: { chatId: number; topicId: number },
    modelIndex: number,
    reasoningEffort: ReasoningEffort
  ): Promise<void> {
    const models = await this.codex.listModels();
    const model = models[modelIndex];
    if (!model) {
      await this.#messenger.sendMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: "That model is no longer available."
      });
      return;
    }

    await this.updateSessionPendingCodexSettings(session, {
      model: model.model,
      reasoningEffort
    });
    await this.#messenger.sendMessage({
      chatId: message.chatId,
      topicId: message.topicId,
      text: `Model set to ${model.model} ${reasoningEffort}.`
    });
  }

  private async applyPermissionsSelection(
    session: TopicSession,
    message: { chatId: number; topicId: number },
    presetId: CodexPermissionPresetId
  ): Promise<void> {
    const preset = getCodexPermissionPreset(presetId);
    await this.updateSessionPendingCodexSettings(session, {
      approvalPolicy: preset.approvalPolicy,
      sandboxPolicy: preset.sandboxPolicy
    });
    await this.#messenger.sendMessage({
      chatId: message.chatId,
      topicId: message.topicId,
      text: `Permissions set to ${preset.label}.`
    });
  }

  private async handleSlashCallbackQuery(event: CallbackQueryEvent): Promise<void> {
    if (event.topicId === null) {
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: "This action requires a topic."
      });
      return;
    }

    const session = await this.database.getSessionByTopic(event.chatId, event.topicId);
    if (!session?.codexThreadId) {
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: MODE_COMMAND_REQUIRES_SESSION_TEXT
      });
      return;
    }

    if (this.findActiveTurnByTopic(event.chatId, event.topicId)) {
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: NATIVE_SETTINGS_REJECTED_TEXT
      });
      return;
    }

    const [, area, action, value, extra] = event.data.split(":");
    if (area === "permissions" && action === "apply" && isCodexPermissionPresetId(value)) {
      await this.applyPermissionsSelection(session, { chatId: event.chatId, topicId: event.topicId }, value);
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: "Permissions updated."
      });
      return;
    }

    if (area === "model" && action === "page") {
      const page = Number.parseInt(value ?? "", 10);
      if (Number.isNaN(page)) {
        await this.telegram.answerCallbackQuery(event.callbackQueryId, {
          text: "Invalid model page."
        });
        return;
      }

      await this.openModelSelection(session, { chatId: event.chatId, topicId: event.topicId }, page);
      await this.telegram.answerCallbackQuery(event.callbackQueryId);
      return;
    }

    if (area === "model" && action === "pick") {
      const modelIndex = Number.parseInt(value ?? "", 10);
      if (Number.isNaN(modelIndex)) {
        await this.telegram.answerCallbackQuery(event.callbackQueryId, {
          text: "Invalid model selection."
        });
        return;
      }

      await this.openModelReasoningSelection(session, { chatId: event.chatId, topicId: event.topicId }, modelIndex);
      await this.telegram.answerCallbackQuery(event.callbackQueryId);
      return;
    }

    if (area === "model" && action === "apply") {
      const modelIndex = Number.parseInt(value ?? "", 10);
      if (Number.isNaN(modelIndex) || !isReasoningEffort(extra)) {
        await this.telegram.answerCallbackQuery(event.callbackQueryId, {
          text: "Invalid reasoning selection."
        });
        return;
      }

      await this.applyModelSelection(session, { chatId: event.chatId, topicId: event.topicId }, modelIndex, extra);
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: "Model updated."
      });
      return;
    }

    await this.telegram.answerCallbackQuery(event.callbackQueryId, {
      text: "Unsupported callback."
    });
  }

  private async startSessionFromRootMessage(message: UserTurnMessage): Promise<void> {
    const title = deriveTopicTitle(message.text);
    const forumTopic = await this.telegram.createForumTopic(
      message.chatId,
      title,
      await this.#topicIconPicker.pickCreateForumTopicOptions()
    );
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
    const forumTopic = await this.telegram.createForumTopic(
      message.chatId,
      title,
      await this.#topicIconPicker.pickCreateForumTopicOptions()
    );
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
      telegramTopicId: message.topicId
    });

    try {
      const thread = await this.codex.createThread(title);
      let session = await this.database.activateSession(pending.id, thread.threadId, {
        current: thread,
        pending: null
      });

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
      this.logger.error("Failed to send initial prompt mirror into Telegram topic", error);
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

    const syncedSession = await this.syncSessionCodexSettings(session);
    const effectiveSettings = getEffectiveCodexThreadSettings(syncedSession.codexSettings);
    if (!effectiveSettings) {
      throw new Error(`Session ${syncedSession.id} has no loaded Codex settings`);
    }

    const pendingOverrides = hasPendingCodexThreadSettings(syncedSession.codexSettings)
      ? syncedSession.codexSettings.pending
      : null;
    const turn = await this.submitPreparedInput(message, {
      submit: (input) =>
        this.codex.sendTurn(
          syncedSession.codexThreadId!,
          input,
          {
            collaborationMode: buildTurnCollaborationMode(
              options?.forceMode ?? syncedSession.preferredMode,
              effectiveSettings,
              this.config.codex.developerInstructions ?? null,
              options?.forceMode === "default"
            ),
            overrides: pendingOverrides
          }
        )
    });
    this.#turnsAwaitingActivation.add(turn.id);

    try {
      if (pendingOverrides) {
        const appliedSettings = applyCodexThreadSettingsOverride(
          syncedSession.codexSettings.current ?? effectiveSettings,
          pendingOverrides
        );
        await this.database.updateSessionCodexSettings(syncedSession.id, {
          current: appliedSettings,
          pending: null
        });
      }
      const activeTurn = this.#lifecycle.activateTurn(
        message,
        syncedSession.codexThreadId!,
        turn.id,
        effectiveSettings.model,
        effectiveSettings.reasoningEffort,
        effectiveSettings.serviceTier,
        options?.forceMode ?? syncedSession.preferredMode
      );
      await this.flushStagedTurnEvents(turn.id);
      if (activeTurn.statusDraft) {
        await this.#lifecycle.publishCurrentStatus(turn.id, true);
      }
    } finally {
      this.#turnsAwaitingActivation.delete(turn.id);
    }
  }

  private async syncSessionCodexSettings(session: TopicSession): Promise<TopicSession> {
    if (!session.codexThreadId) {
      return session;
    }

    const current = await this.codex.ensureThreadLoaded(session.codexThreadId);
    const nextSettings = withUpdatedCurrentCodexThreadSettings(session.codexSettings, current);
    return this.database.updateSessionCodexSettings(session.id, nextSettings);
  }

  private async updateSessionPendingCodexSettings(
    session: TopicSession,
    override: CodexThreadSettingsOverride
  ): Promise<TopicSession> {
    const nextPending = {
      ...(session.codexSettings.pending ?? {}),
      ...override
    };
    return this.database.updateSessionCodexSettings(
      session.id,
      withUpdatedPendingCodexThreadSettings(session.codexSettings, nextPending)
    );
  }

  private async consumeCodexEvents(): Promise<void> {
    while (true) {
      const event = await this.codex.nextEvent();
      if (!event) {
        return;
      }

      await this.enqueueCodexEvent(event);
    }
  }

  private async enqueueCodexEvent(event: AppServerEvent): Promise<void> {
    const turnId = getAppEventTurnId(event);
    if (!turnId) {
      await this.handleCodexEvent(event);
      return;
    }

    const previous = this.#notificationChains.get(turnId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const mode = this.getTurnEventHandlingMode(turnId);
      if (mode === "stage") {
        this.stageTurnEvent(turnId, event);
        return;
      }
      if (mode === "drop") {
        if (event.kind === "serverRequest") {
          await this.handleCodexEvent(event);
          return;
        }
        this.logger.warn(`Dropped Codex event for unknown turn ${turnId}`);
        return;
      }

      await this.handleCodexEvent(event);
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

  private getTurnEventHandlingMode(turnId: string): "handle" | "stage" | "drop" {
    if (this.#lifecycle.getTurn(turnId)) {
      return "handle";
    }

    if (this.#turnsAwaitingActivation.has(turnId)) {
      return "stage";
    }

    return "drop";
  }

  private stageTurnEvent(turnId: string, event: AppServerEvent): void {
    const staged = this.#stagedTurnEvents.get(turnId);
    if (staged) {
      staged.push(event);
      return;
    }

    this.#stagedTurnEvents.set(turnId, [event]);
    const timer = setTimeout(() => {
      const dropped = this.#stagedTurnEvents.get(turnId);
      this.#stagedTurnEvents.delete(turnId);
      this.#stagedTurnEventTimers.delete(turnId);
      if (dropped && dropped.length > 0) {
        this.logger.warn(`Dropped ${dropped.length} staged Codex event(s) for unknown turn ${turnId}`);
      }
    }, STAGED_TURN_EVENT_TIMEOUT_MS);
    timer.unref?.();
    this.#stagedTurnEventTimers.set(turnId, timer);
  }

  private async flushStagedTurnEvents(turnId: string): Promise<void> {
    const timer = this.#stagedTurnEventTimers.get(turnId);
    if (timer) {
      clearTimeout(timer);
      this.#stagedTurnEventTimers.delete(turnId);
    }

    const staged = this.#stagedTurnEvents.get(turnId);
    if (!staged || staged.length === 0) {
      this.#stagedTurnEvents.delete(turnId);
      return;
    }

    this.#stagedTurnEvents.delete(turnId);
    for (const event of staged) {
      await this.handleCodexEvent(event);
    }
  }

  private async handleCodexEvent(event: AppServerEvent): Promise<void> {
    if (event.kind === "notification") {
      await this.handleNotification(event.notification);
      return;
    }

    await this.handleServerRequest(event.request);
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
          await this.#lifecycle.handleReasoningDelta(
            notification.params.turnId,
            notification.params.itemId,
            notification.params.summaryIndex,
            notification.params.delta
          );
        }
      },
      "item/reasoning/textDelta": async () => {
        if (notification.method === "item/reasoning/textDelta") {
          await this.#lifecycle.handleReasoningTextDelta(
            notification.params.turnId,
            notification.params.itemId,
            notification.params.delta
          );
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
      "serverRequest/resolved": async () => {
        if (notification.method === "serverRequest/resolved") {
          await this.#requestCoordinator.handleServerRequestResolved(notification.params);
        }
      },
      "thread/compacted": async () => {
        if (notification.method === "thread/compacted") {
          await this.handleThreadCompacted(notification.params.threadId);
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

        switch (notification.params.turn.status) {
          case "completed":
            await this.#lifecycle.completeTurn(notification.params.threadId, notification.params.turn.id);
            return;
          case "interrupted":
            await this.#lifecycle.finalizeInterruptedTurnById(notification.params.threadId, notification.params.turn.id);
            return;
          case "failed":
            await this.#lifecycle.failTurn(
              notification.params.threadId,
              notification.params.turn.id,
              notification.params.turn.error?.message ?? "Turn failed"
            );
            return;
          default:
            return;
        }
      },
      error: async () => {
        if (notification.method === "error") {
          if (notification.params.willRetry) {
            return;
          }

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

  private async handleThreadCompacted(threadId: string): Promise<void> {
    if (!this.#lifecycle.markCompactionNoticeSentForThread(threadId)) {
      return;
    }

    const session = await this.database.getSessionByCodexThreadId(threadId);
    if (!session) {
      return;
    }

    await this.#messenger.sendMessage({
      chatId: Number.parseInt(session.telegramChatId, 10),
      topicId: session.telegramTopicId,
      text: "Context compacted."
    });
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

      this.logger.error("Failed to steer turn", error);
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

function getServerRequestTurnId(request: ServerRequest): string | null {
  return "turnId" in request.params && typeof request.params.turnId === "string" ? request.params.turnId : null;
}

function getAppEventTurnId(event: AppServerEvent): string | null {
  if (event.kind === "notification") {
    return getNotificationTurnId(event.notification);
  }

  return getServerRequestTurnId(event.request);
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

function buildSyntheticCallbackMessage(event: CallbackQueryEvent, text: string): UserTurnMessage {
  return {
    chatId: event.chatId,
    topicId: event.topicId,
    messageId: 0,
    updateId: 0,
    userId: event.userId,
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

function topicKey(chatId: number, topicId: number): string {
  return `${chatId}:${topicId}`;
}

function buildFastStatusMessage(serviceTier: ServiceTier | null): string {
  return `Fast mode is ${serviceTier === "fast" ? "on" : "off"} for future turns in this topic.`;
}

function buildFastUpdatedMessage(serviceTier: ServiceTier | null): string {
  return `Fast mode ${serviceTier === "fast" ? "enabled" : "disabled"}.`;
}

function looksLikeSlashCommand(text: string): boolean {
  return text.trim().startsWith("/");
}

function isReasoningEffort(value: string | undefined): value is ReasoningEffort {
  return value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function isCodexPermissionPresetId(value: string | undefined): value is CodexPermissionPresetId {
  return value === "read-only" || value === "default" || value === "full-access";
}
