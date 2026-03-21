import type { MessageEntity } from "grammy/types";

import type { AppConfig } from "./config";
import { BridgeDatabase } from "./db";
import type {
  BridgeSession,
  PersistedThreadSettings,
  PendingCustomCommandAdd,
  SessionMode,
  TopicLifecycleEvent,
  TopicSession,
  UserTurnInput,
  UserTurnMessage
} from "./domain";
import type { Model } from "@kirbot/codex-client/generated/codex/v2/Model";
import type { CollaborationMode } from "@kirbot/codex-client/generated/codex/CollaborationMode";
import type { ReasoningEffort } from "@kirbot/codex-client/generated/codex/ReasoningEffort";
import type { ServiceTier } from "@kirbot/codex-client/generated/codex/ServiceTier";
import type { ServerNotification } from "@kirbot/codex-client/generated/codex/ServerNotification";
import type { ServerRequest } from "@kirbot/codex-client/generated/codex/ServerRequest";
import type { RequestId } from "@kirbot/codex-client/generated/codex/RequestId";
import type { AppServerEvent, ResolvedTurnSnapshot } from "@kirbot/codex-client";
import type { UserInput } from "@kirbot/codex-client/generated/codex/v2/UserInput";
import type { CommandExecutionApprovalDecision } from "@kirbot/codex-client/generated/codex/v2/CommandExecutionApprovalDecision";
import type { FileChangeApprovalDecision } from "@kirbot/codex-client/generated/codex/v2/FileChangeApprovalDecision";
import type { PermissionsRequestApprovalResponse } from "@kirbot/codex-client/generated/codex/v2/PermissionsRequestApprovalResponse";
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
  detectCodexPermissionPreset,
  getCodexPermissionPreset,
  type CodexPermissionPresetId,
  type CodexThreadSettings,
  type CodexThreadSettingsOverride
} from "./bridge/codex-thread-settings";
import {
  buildCustomCommandAddedText,
  buildCustomCommandCanceledText,
  buildCustomCommandConfirmationText,
  buildCustomCommandDeletedText,
  buildCustomCommandDuplicateText,
  buildCustomCommandHelpText,
  buildCustomCommandReservedText,
  buildCustomCommandUpdatedText,
  buildMissingCustomCommandText,
  buildPendingCustomCommandCallbackData,
  expandCustomCommandPrompt,
  normalizeCustomCommandName,
  parseCustomCommandManagerRequest,
  parsePendingCustomCommandCallbackData,
  validateCustomCommandName,
  validateCustomCommandPrompt
} from "./bridge/custom-commands";
import {
  getSurfaceableTopicSlashCommands,
  isAllowedSlashCommandInScope,
  isBuiltInSlashCommand,
  isCodexSlashCommand,
  parseSlashCommand,
  parseSlashCommandToken,
  type ParsedSlashCommand
} from "./bridge/slash-commands";
import {
  buildTopicCommandKeyboard,
  buildRenderedThreadStartFooter,
  buildRenderedInitialPromptMessage,
  buildQueuePreviewKeyboard,
  deriveTopicTitle,
  renderQueuePreview,
  TOPIC_IMPLEMENT_CALLBACK_DATA
} from "./bridge/presentation";
import { BridgeRequestCoordinator } from "./bridge/request-coordinator";
import { TurnLifecycleCoordinator, type TurnContext } from "./bridge/turn-lifecycle";
import type { LoggerLike } from "./logging";
import { TelegramMessenger, type ReplyKeyboardMarkup, type TelegramApi, type TelegramReplyMarkup } from "./telegram-messenger";
import { BridgeTurnRuntime, type QueueStateSnapshot } from "./turn-runtime";

export type CallbackQueryEvent = {
  callbackQueryId: string;
  data: string;
  chatId: number;
  topicId: number | null;
  userId: number;
};

export interface BridgeCodexApi {
  createThread(
    title: string,
    options?: {
      cwd?: string | null;
      settings?: CodexThreadSettingsOverride | null;
    }
  ): Promise<{ threadId: string; branch: string | null } & ThreadStartSettings>;
  readGlobalSettings(): Promise<ThreadStartSettings>;
  updateGlobalSettings(update: CodexThreadSettingsOverride): Promise<ThreadStartSettings>;
  ensureThreadLoaded(threadId: string): Promise<ThreadStartSettings>;
  updateThreadSettings(threadId: string, update: CodexThreadSettingsOverride): Promise<ThreadStartSettings>;
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

type ThreadStartSettings = CodexThreadSettings & {
  cwd: string;
};

type SettingsSelectionScope = "thread" | "root" | "spawn";

type ThreadSettingsTarget =
  | {
      scope: "thread";
      session: TopicSession;
      settings: ThreadStartSettings;
    }
  | {
      scope: "root";
      session: BridgeSession | null;
      settings: PersistedThreadSettings;
    }
  | {
      scope: "spawn";
      settings: PersistedThreadSettings;
    };

export type TelegramCodexBridgeOptions = {
  topicIconPicker?: TopicIconPicker;
  restartKirbot?: () => Promise<void>;
};

const INVALID_COMMAND_TEXT = "This command is not valid here";
const NO_ACTIVE_RESPONSE_TO_STOP_TEXT = "There is no active response to stop right now";
const STOPPING_CURRENT_RESPONSE_TEXT = "Stopping the current response…";
const RESPONSE_ALREADY_FINISHING_TEXT = "This response is already finishing";
const MODE_CHANGE_REJECTED_TEXT = "Wait for the current response to finish or stop it first before changing modes";
const SETTINGS_CHANGE_REJECTED_TEXT = "Wait for the current response to finish or stop it first before changing settings";
const MODE_COMMAND_REQUIRES_SESSION_TEXT = "This topic does not have a Codex session yet. Send a normal message first to start one";
const FAST_USAGE_TEXT = "Usage: /fast [on|off|status]";
const THREAD_USAGE_TEXT = "Usage: /thread <initial prompt>";
const RESTART_NOT_CONFIGURED_TEXT = "Restart is not configured for this kirbot deployment";
const RESTARTING_KIRBOT_TEXT = "Rebuilding kirbot and restarting the production session…";
const PLAN_MODE_ENABLED_TEXT = "Plan mode enabled";
const PLAN_MODE_EXITED_TEXT = "Exited plan mode";
const DEFAULT_ROOT_SESSION_TITLE = "Root Chat";
const DEFAULT_NEW_PLAN_SESSION_TITLE = "New Plan Session";
const STAGED_TURN_EVENT_TIMEOUT_MS = 10_000;
const MODEL_PAGE_SIZE = 6;
const CUSTOM_COMMAND_CONFIRMATION_STALE_TEXT = "This confirmation is no longer pending";
const ROOT_SESSION_PROVISIONING_TEXT = "The root Codex session is still provisioning. Try again in a moment";

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
  readonly #restartKirbot: (() => Promise<void>) | null;

  constructor(
    private readonly config: AppConfig,
    private readonly database: BridgeDatabase,
    private readonly telegram: TelegramApi,
    private readonly codex: BridgeCodexApi,
    private readonly mediaStore: TemporaryImageStore,
    private readonly logger: LoggerLike = console,
    options?: TelegramCodexBridgeOptions
  ) {
    this.#messenger = new TelegramMessenger(telegram, logger);
    this.#topicIconPicker = options?.topicIconPicker ?? new RandomTopicIconPicker(telegram, logger);
    this.#restartKirbot = options?.restartKirbot ?? null;
    this.#lifecycle = new TurnLifecycleCoordinator({
      runtime: new BridgeTurnRuntime(),
      messenger: this.#messenger,
      telegram,
      planArtifactPublicUrl: config.telegram.miniApp.publicUrl,
      buildTopicCommandReplyMarkup: this.buildTopicCommandReplyMarkup.bind(this),
      releaseTurnFiles: (turnId) => this.mediaStore.releaseTurnFiles(turnId),
      resolveTurnSnapshot: this.resolveTurnSnapshot.bind(this),
      syncQueuePreview: this.syncQueuePreview.bind(this),
      maybeSendNextQueuedFollowUp: this.maybeSendNextQueuedFollowUp.bind(this),
      submitQueuedFollowUp: this.submitQueuedFollowUp.bind(this)
    }, logger);
    this.#requestCoordinator = new BridgeRequestCoordinator(
      database,
      telegram,
      this.#messenger,
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

  getActiveTopics(): Array<{ chatId: number; topicId: number | null }> {
    return this.#lifecycle.getActiveTopics();
  }

  async handleCallbackQuery(event: CallbackQueryEvent): Promise<void> {
    if (event.userId !== this.config.telegram.userId) {
      return;
    }

    if (await this.#requestCoordinator.handleCallbackQuery(event)) {
      return;
    }

    if (event.data.startsWith("customcmd:")) {
      await this.handleCustomCommandCallbackQuery(event);
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
      text: "Unsupported callback"
    });
  }

  private async handleTopicImplementCallbackQuery(event: CallbackQueryEvent): Promise<void> {
    if (event.topicId === null) {
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: "This action requires a topic"
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
        text: "Unsupported callback"
      });
      return;
    }

    if (event.topicId === null) {
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: "This action requires a topic"
      });
      return;
    }

    const activeTurn = this.findActiveTurnByTopic(event.chatId, event.topicId);
    if (!activeTurn || activeTurn.turnId !== turnId) {
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: "This turn is no longer active"
      });
      return;
    }

    if (activeTurn.stopRequested) {
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: "Interrupt already requested"
      });
      return;
    }

    const queueState = this.#lifecycle.getQueueState(event.chatId, event.topicId);
    if (queueState.pendingSteers.length === 0) {
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: "No pending steer instructions to send"
      });
      return;
    }

    this.#lifecycle.requestPendingSteerSubmissionAfterInterrupt(turnId);

    try {
      await this.codex.interruptTurn(activeTurn.threadId, activeTurn.turnId);
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: "Submitting queued steer instructions"
      });
    } catch (error) {
      const classification = classifyInterruptError(error);
      if (classification.kind === "stale_or_missing_active_turn") {
        this.#lifecycle.requestPendingSteerSubmissionAfterInterrupt(turnId);
        await this.#lifecycle.finalizeInterruptedTurnById(activeTurn.threadId, activeTurn.turnId);
        await this.telegram.answerCallbackQuery(event.callbackQueryId, {
          text: "Previous turn already ended. Submitting queued steer instructions"
        });
        return;
      }

      this.#lifecycle.clearPendingSteerSubmissionAfterInterrupt(turnId);

      this.logger.error("Failed to interrupt turn", error);
      await this.sendScopedBridgeMessage({
        chatId: event.chatId,
        topicId: event.topicId,
        text: `Failed to interrupt the current turn: ${formatError(error)}`
      });
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: "Failed to interrupt turn"
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

    const resolvedPendingInput = await this.tryResolveUserInput(message);
    if (resolvedPendingInput) {
      return;
    }

    const parsedCustomCommand = parseSlashCommandToken(message.text);
    if (parsedCustomCommand) {
      const handled = await this.tryHandleCustomCommandInvocation(message, parsedCustomCommand.command, parsedCustomCommand.argsText);
      if (handled) {
        return;
      }
    }

    if (looksLikeSlashCommand(message.text)) {
      await this.sendInvalidSlashCommandMessage(message);
      return;
    }

    const session = await this.database.getRootSessionByChat(message.chatId);
    if (!session) {
      await this.startSessionFromRootMessage(message);
      return;
    }

    if (!session.codexThreadId) {
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        text: ROOT_SESSION_PROVISIONING_TEXT
      });
      return;
    }

    const activeTurn = this.findActiveTurnByTopic(message.chatId, null);
    if (activeTurn) {
      await this.trySteerTurn(activeTurn, message);
      return;
    }

    await this.sendTurnForSession(session, message);
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

    const parsedCustomCommand = parseSlashCommandToken(message.text);
    if (parsedCustomCommand) {
      const handled = await this.tryHandleCustomCommandInvocation(message, parsedCustomCommand.command, parsedCustomCommand.argsText);
      if (handled) {
        return;
      }

      await this.sendInvalidSlashCommandMessage(message);
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
        text: "Could not determine a Telegram topic for this message, so no Codex session was started"
      });
      return;
    }

    const session = await this.database.getSessionByTopic(message.chatId, message.topicId);
    if (!session) {
      await this.startSessionInExistingTopic(message);
      return;
    }

    if (!session.codexThreadId) {
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: "This topic is still provisioning a Codex session. Try again in a moment"
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
    if (isCodexSlashCommand(command.command)) {
      await this.handleRootCodexSlashCommand(message, command);
      return;
    }

    if (command.command === "plan") {
      await this.startPlanSessionFromRootMessage(message, command.argsText);
      return;
    }

    if (command.command === "thread") {
      await this.startThreadSessionFromRootMessage(message, command.argsText);
      return;
    }

    if (command.command === "restart") {
      await this.restartKirbot(message);
      return;
    }

    if (command.command === "cmd") {
      await this.handleCustomCommandManager(message, command.argsText);
      return;
    }

    await this.sendInvalidSlashCommandMessage(message);
  }

  private async handleTopicSlashCommand(message: UserTurnMessage, command: ParsedSlashCommand): Promise<void> {
    if (isCodexSlashCommand(command.command)) {
      await this.handleTopicCodexSlashCommand(message, command);
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

  private async handleRootCodexSlashCommand(message: UserTurnMessage, command: ParsedSlashCommand): Promise<void> {
    if (command.command === "fast") {
      await this.openRootFastSelection(message.chatId, command.argsText);
      return;
    }

    if (command.command === "model") {
      await this.openRootSettingsScopeSelection(message.chatId, "model");
      return;
    }

    if (command.command === "permissions" || command.command === "approvals") {
      await this.openRootSettingsScopeSelection(message.chatId, "permissions");
      return;
    }

    await this.sendInvalidSlashCommandMessage(message);
  }

  private async handleTopicCodexSlashCommand(message: UserTurnMessage, command: ParsedSlashCommand): Promise<void> {
    if (command.command === "fast") {
      await this.handleFastSlashCommand(
        {
          chatId: message.chatId,
          topicId: message.topicId
        },
        command.argsText
      );
      return;
    }

    if (command.command === "model") {
      await this.openModelSelection({ chatId: message.chatId, topicId: message.topicId });
      return;
    }

    if (command.command === "permissions" || command.command === "approvals") {
      await this.openPermissionsSelection({
        chatId: message.chatId,
        topicId: message.topicId
      });
      return;
    }

    await this.sendInvalidSlashCommandMessage(message);
  }

  private async handleCustomCommandManager(message: UserTurnMessage, argsText: string): Promise<void> {
    const parsed = parseCustomCommandManagerRequest(argsText);
    if (parsed.kind === "help") {
      await this.#messenger.sendMessage({
        chatId: message.chatId,
        text: buildCustomCommandHelpText()
      });
      return;
    }

    if (parsed.kind === "invalid") {
      await this.#messenger.sendMessage({
        chatId: message.chatId,
        text: parsed.message
      });
      return;
    }

    const commandName = normalizeCustomCommandName(parsed.commandName);
    const commandValidationError = validateCustomCommandName(commandName);
    if (commandValidationError) {
      await this.#messenger.sendMessage({
        chatId: message.chatId,
        text: commandValidationError
      });
      return;
    }

    if (parsed.action === "add" || parsed.action === "update") {
      const promptValidationError = validateCustomCommandPrompt(parsed.prompt);
      if (promptValidationError) {
        await this.#messenger.sendMessage({
          chatId: message.chatId,
          text: promptValidationError
        });
        return;
      }
    }

    if (parsed.action === "add") {
      const conflict = await this.getCustomCommandConflictText(commandName);
      if (conflict) {
        await this.#messenger.sendMessage({
          chatId: message.chatId,
          text: conflict
        });
        return;
      }

      const pending = await this.database.createPendingCustomCommandAdd({
        command: commandName,
        prompt: parsed.prompt.trim(),
        telegramChatId: String(message.chatId)
      });
      const confirmation = await this.#messenger.sendMessage({
        chatId: message.chatId,
        text: buildCustomCommandConfirmationText(commandName, parsed.prompt.trim()),
        replyMarkup: {
          inline_keyboard: [[
            {
              text: "Add",
              callback_data: buildPendingCustomCommandCallbackData(pending.id, "confirm")
            },
            {
              text: "Cancel",
              callback_data: buildPendingCustomCommandCallbackData(pending.id, "cancel")
            }
          ]]
        }
      });
      await this.database.updatePendingCustomCommandAddMessageId(pending.id, confirmation.messageId);
      return;
    }

    if (parsed.action === "update") {
      const updated = await this.database.updateCustomCommandPrompt(commandName, parsed.prompt.trim());
      await this.#messenger.sendMessage({
        chatId: message.chatId,
        text: updated ? buildCustomCommandUpdatedText(commandName) : buildMissingCustomCommandText(commandName)
      });
      return;
    }

    const deleted = await this.database.deleteCustomCommand(commandName);
    await this.#messenger.sendMessage({
      chatId: message.chatId,
      text: deleted ? buildCustomCommandDeletedText(commandName) : buildMissingCustomCommandText(commandName)
    });
  }

  private async tryHandleCustomCommandInvocation(
    message: UserTurnMessage,
    commandName: string,
    argsText: string
  ): Promise<boolean> {
    if (isBuiltInSlashCommand(commandName)) {
      return false;
    }

    const customCommand = await this.database.getCustomCommandByName(commandName);
    if (!customCommand) {
      return false;
    }

    const expandedPrompt = expandCustomCommandPrompt(customCommand.prompt, argsText);
    const expandedMessage = replaceMessageText(message, expandedPrompt);
    const session = await this.getSessionByLocation(message.chatId, message.topicId);
    if (!session) {
      if (message.topicId === null) {
        await this.startSessionFromRootMessage(expandedMessage);
      } else {
        await this.startSessionInExistingTopic(expandedMessage);
      }
      return true;
    }

    if (!session.codexThreadId) {
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        ...(message.topicId !== null ? { topicId: message.topicId } : {}),
        text: message.topicId === null
          ? ROOT_SESSION_PROVISIONING_TEXT
          : "This topic is still provisioning a Codex session. Try again in a moment"
      });
      return true;
    }

    const activeTurn = this.findActiveTurnByTopic(message.chatId, message.topicId);
    if (activeTurn) {
      await this.trySteerTurn(activeTurn, expandedMessage);
      return true;
    }

    await this.sendTurnForSession(session, expandedMessage);
    return true;
  }

  private async handleCustomCommandCallbackQuery(event: CallbackQueryEvent): Promise<void> {
    const parsed = parsePendingCustomCommandCallbackData(event.data);
    if (!parsed) {
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: "Unsupported callback"
      });
      return;
    }

    const pending = await this.database.getPendingCustomCommandAddById(parsed.pendingId);
    if (!pending || pending.status !== "pending") {
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: CUSTOM_COMMAND_CONFIRMATION_STALE_TEXT
      });
      return;
    }

    if (parsed.action === "cancel") {
      await this.database.updatePendingCustomCommandAddStatus(pending.id, "canceled");
      await this.maybeEditPendingCustomCommandMessage(pending, buildCustomCommandCanceledText(pending.command));
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: "Canceled"
      });
      return;
    }

    const conflict = await this.getCustomCommandConflictText(pending.command, pending.id);
    if (conflict) {
      await this.database.updatePendingCustomCommandAddStatus(pending.id, "canceled");
      await this.maybeEditPendingCustomCommandMessage(pending, conflict);
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: "Could not add command"
      });
      return;
    }

    try {
      await this.database.createCustomCommand({
        command: pending.command,
        prompt: pending.prompt
      });
    } catch (error) {
      const duplicateConflict = await this.getCustomCommandConflictText(pending.command, pending.id);
      if (duplicateConflict) {
        await this.database.updatePendingCustomCommandAddStatus(pending.id, "canceled");
        await this.maybeEditPendingCustomCommandMessage(pending, duplicateConflict);
        await this.telegram.answerCallbackQuery(event.callbackQueryId, {
          text: "Could not add command"
        });
        return;
      }

      this.logger.error("Failed to add custom command", error);
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: "Failed to add command"
      });
      return;
    }

    await this.database.updatePendingCustomCommandAddStatus(pending.id, "confirmed");
    await this.maybeEditPendingCustomCommandMessage(pending, buildCustomCommandAddedText(pending.command));
    await this.telegram.answerCallbackQuery(event.callbackQueryId, {
      text: "Command added"
    });
  }

  private async getCustomCommandConflictText(commandName: string, ignoredPendingId?: number): Promise<string | null> {
    if (isBuiltInSlashCommand(commandName)) {
      return buildCustomCommandReservedText(commandName);
    }

    const existing = await this.database.getCustomCommandByName(commandName);
    if (existing) {
      return buildCustomCommandDuplicateText(commandName);
    }

    const pending = await this.database.getPendingCustomCommandAddByCommand(commandName);
    if (pending && pending.id !== ignoredPendingId) {
      return buildCustomCommandDuplicateText(commandName);
    }

    return null;
  }

  private async maybeEditPendingCustomCommandMessage(pending: PendingCustomCommandAdd, text: string): Promise<void> {
    if (!pending.telegramMessageId) {
      return;
    }

    await this.telegram.editMessageText(
      Number.parseInt(pending.telegramChatId, 10),
      pending.telegramMessageId,
      text
    );
  }

  private async enterPlanMode(message: UserTurnMessage, promptText: string): Promise<void> {
    const session = await this.requireModeCommandSession(message);
    if (!session) {
      return;
    }

    if (this.findActiveTurnByTopic(message.chatId, message.topicId!)) {
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: MODE_CHANGE_REJECTED_TEXT
      });
      return;
    }

    const updatedSession = await this.database.updateSessionPreferredMode(message.chatId, message.topicId!, "plan");
    if (!updatedSession) {
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: MODE_COMMAND_REQUIRES_SESSION_TEXT
      });
      return;
    }

    if (!promptText.trim()) {
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: PLAN_MODE_ENABLED_TEXT
      });
      return;
    }

    await this.sendScopedBridgeMessage({
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
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: MODE_CHANGE_REJECTED_TEXT
      });
      return;
    }

    const updatedSession = await this.database.updateSessionPreferredMode(message.chatId, message.topicId!, "default");
    if (!updatedSession) {
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: MODE_COMMAND_REQUIRES_SESSION_TEXT
      });
      return;
    }

    await this.sendScopedBridgeMessage({
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
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: MODE_COMMAND_REQUIRES_SESSION_TEXT
      });
      return null;
    }

    if (!session.codexThreadId) {
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: "This topic is still provisioning a Codex session. Try again in a moment"
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
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: NO_ACTIVE_RESPONSE_TO_STOP_TEXT
      });
      return;
    }

    if (activeTurn.stopRequested) {
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: "Interrupt already requested"
      });
      return;
    }

    this.#lifecycle.markStopRequested(activeTurn.turnId);
    await this.syncQueuePreview(this.#lifecycle.getQueueState(activeTurn.chatId, activeTurn.topicId));

    try {
      await this.codex.interruptTurn(activeTurn.threadId, activeTurn.turnId);
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: STOPPING_CURRENT_RESPONSE_TEXT
      });
    } catch (error) {
      const classification = classifyInterruptError(error);
      if (classification.kind === "stale_or_missing_active_turn") {
        await this.#lifecycle.finalizeInterruptedTurnById(activeTurn.threadId, activeTurn.turnId);
        await this.sendScopedBridgeMessage({
          chatId: message.chatId,
          topicId: message.topicId,
          text: RESPONSE_ALREADY_FINISHING_TEXT
        });
        return;
      }

      this.#lifecycle.clearStopRequested(activeTurn.turnId);
      await this.syncQueuePreview(this.#lifecycle.getQueueState(activeTurn.chatId, activeTurn.topicId));

      this.logger.error("Failed to interrupt turn", error);
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: `Failed to interrupt the current turn: ${formatError(error)}`
      });
    }
  }

  private async openRootFastSelection(chatId: number, argsText: string): Promise<void> {
    const normalizedArgs = argsText.trim().toLowerCase();
    const fastAction =
      !normalizedArgs
        ? "toggle"
        : normalizedArgs === "on" || normalizedArgs === "off" || normalizedArgs === "status"
          ? normalizedArgs
          : null;
    if (!fastAction) {
      await this.sendScopedBridgeMessage({
        chatId,
        text: FAST_USAGE_TEXT
      });
      return;
    }

    await this.#messenger.sendMessage({
      chatId,
      text: "Apply fast mode to:",
      replyMarkup: {
        inline_keyboard: [[
          {
            text: "Root Thread",
            callback_data: `slash:fast:apply:root:${fastAction}`
          }
        ], [
          {
            text: "New /thread Topics",
            callback_data: `slash:fast:apply:spawn:${fastAction}`
          }
        ]]
      }
    });
  }

  private async openRootSettingsScopeSelection(chatId: number, area: "model" | "permissions"): Promise<void> {
    await this.#messenger.sendMessage({
      chatId,
      text: "Choose which settings to update",
      replyMarkup: {
        inline_keyboard: [[
          {
            text: "Root Thread",
            callback_data: `slash:scope:${area}:root`
          }
        ], [
          {
            text: "New /thread Topics",
            callback_data: `slash:scope:${area}:spawn`
          }
        ]]
      }
    });
  }

  private async handleFastSlashCommand(
    location: {
      chatId: number;
      topicId: number | null;
    },
    argsText: string
  ): Promise<void> {
    const normalizedArgs = argsText.trim().toLowerCase();
    const target = await this.resolveCodexSettingsCommandTarget(location);
    if (!target) {
      return;
    }

    if (normalizedArgs === "status") {
      await this.sendScopedBridgeMessage({
        chatId: location.chatId,
        ...(location.topicId !== null ? { topicId: location.topicId } : {}),
        text: buildFastStatusMessage(target.scope, target.settings.serviceTier)
      });
      return;
    }

    let nextTier: ServiceTier | null;
    if (!normalizedArgs) {
      nextTier = target.settings.serviceTier === "fast" ? null : "fast";
    } else if (normalizedArgs === "on") {
      nextTier = "fast";
    } else if (normalizedArgs === "off") {
      nextTier = null;
    } else {
      await this.sendScopedBridgeMessage({
        chatId: location.chatId,
        ...(location.topicId !== null ? { topicId: location.topicId } : {}),
        text: FAST_USAGE_TEXT
      });
      return;
    }

    if (target.scope === "thread" && this.findActiveTurnByTopic(location.chatId, location.topicId!)) {
      await this.sendScopedBridgeMessage({
        chatId: location.chatId,
        topicId: location.topicId!,
        text: SETTINGS_CHANGE_REJECTED_TEXT
      });
      return;
    }

    const nextEffective =
      target.scope === "global"
        ? await this.codex.updateGlobalSettings({
            serviceTier: nextTier
          })
        : await this.codex.updateThreadSettings(target.session.codexThreadId!, {
            serviceTier: nextTier
          });
    await this.sendScopedBridgeMessage({
      chatId: location.chatId,
      ...(location.topicId !== null ? { topicId: location.topicId } : {}),
      text: buildFastUpdatedMessage(target.scope, nextEffective.serviceTier)
    });
  }

  private async applyRootFastSelection(
    chatId: number,
    scope: Exclude<SettingsSelectionScope, "thread">,
    action: FastSelectionAction
  ): Promise<boolean> {
    const target = await this.resolveThreadSettingsTarget(
      {
        chatId,
        topicId: null
      },
      scope,
      {
        rejectIfActiveTurn: action !== "status"
      }
    );
    if (!target || (target.scope !== "root" && target.scope !== "spawn")) {
      return false;
    }

    if (action === "status") {
      await this.sendScopedBridgeMessage({
        chatId,
        text: buildScopedFastStatusMessage(target.scope, target.settings.serviceTier)
      });
      return true;
    }

    const nextTier =
      action === "toggle"
        ? target.settings.serviceTier === "fast" ? null : "fast"
        : action === "on"
          ? "fast"
          : null;

    await this.updateChatThreadSettingsDefaults(chatId, target.scope, {
      serviceTier: nextTier
    });
    if (target.scope === "root" && target.session?.codexThreadId) {
      await this.codex.updateThreadSettings(target.session.codexThreadId, {
        serviceTier: nextTier
      });
    }

    await this.sendScopedBridgeMessage({
      chatId,
      text: buildScopedFastUpdatedMessage(target.scope, nextTier)
    });
    return true;
  }

  private async openPermissionsSelection(message: { chatId: number; topicId: number | null }): Promise<boolean> {
    return this.openScopedPermissionsSelection(message, "thread");
  }

  private async openScopedPermissionsSelection(
    message: { chatId: number; topicId: number | null },
    scope: SettingsSelectionScope
  ): Promise<boolean> {
    const target = await this.resolveThreadSettingsTarget(message, scope);
    if (!target) {
      return false;
    }

    const currentPresetId = detectCodexPermissionPreset(toPermissionDetectionSettings(target.settings));
    const currentPreset = currentPresetId ? getCodexPermissionPreset(currentPresetId) : null;

    await this.#messenger.sendMessage({
      chatId: message.chatId,
      ...(message.topicId !== null ? { topicId: message.topicId } : {}),
      text: [
        describePermissionsSelectionTitle(target.scope),
        currentPreset ? `Current: ${currentPreset.label}` : "Current: Custom",
        describePermissionsSelectionScope(target.scope)
      ].join("\n"),
      replyMarkup: {
        inline_keyboard: CODEX_PERMISSION_PRESETS.map((preset) => [
          {
            text: `${preset.id === currentPresetId ? "• " : ""}${preset.label}`,
            callback_data:
              target.scope === "thread"
                ? `slash:permissions:apply:${preset.id}`
                : `slash:permissions:apply:${target.scope}:${preset.id}`
          }
        ])
      }
    });
    return true;
  }

  private async openModelSelection(
    message: { chatId: number; topicId: number | null },
    page = 0,
    scope: SettingsSelectionScope = "thread"
  ): Promise<boolean> {
    const target = await this.resolveThreadSettingsTarget(message, scope);
    if (!target) {
      return false;
    }

    const models = await this.codex.listModels();
    if (models.length === 0) {
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        ...(message.topicId !== null ? { topicId: message.topicId } : {}),
        text: "No visible Codex models are available right now"
      });
      return false;
    }

    const totalPages = Math.max(1, Math.ceil(models.length / MODEL_PAGE_SIZE));
    const boundedPage = Math.min(Math.max(page, 0), totalPages - 1);
    const startIndex = boundedPage * MODEL_PAGE_SIZE;
    const pageModels = models.slice(startIndex, startIndex + MODEL_PAGE_SIZE);
    const currentModel = target.settings.model;

    await this.#messenger.sendMessage({
      chatId: message.chatId,
      ...(message.topicId !== null ? { topicId: message.topicId } : {}),
      text: [
        describeModelSelectionTitle(target.scope),
        currentModel ? `Current: ${currentModel}` : "Current: unknown-model",
        "Then choose a reasoning effort"
      ].join("\n"),
      replyMarkup: {
        inline_keyboard: [
          ...pageModels.map((model, index) => [
            {
              text: `${model.model === currentModel ? "• " : ""}${model.displayName}`,
              callback_data:
                target.scope === "thread"
                  ? `slash:model:pick:${startIndex + index}`
                  : `slash:model:pick:${target.scope}:${startIndex + index}`
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
    return true;
  }

  private async openModelReasoningSelection(
    message: { chatId: number; topicId: number | null },
    modelIndex: number,
    scope: SettingsSelectionScope = "thread"
  ): Promise<boolean> {
    const target = await this.resolveThreadSettingsTarget(message, scope);
    if (!target) {
      return false;
    }

    const models = await this.codex.listModels();
    const model = models[modelIndex];
    if (!model) {
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        ...(message.topicId !== null ? { topicId: message.topicId } : {}),
        text: "That model is no longer available"
      });
      return false;
    }

    const currentEffort =
      target.settings.model === model.model ? target.settings.reasoningEffort ?? model.defaultReasoningEffort : model.defaultReasoningEffort;

    await this.#messenger.sendMessage({
      chatId: message.chatId,
      ...(message.topicId !== null ? { topicId: message.topicId } : {}),
      text: `Choose the reasoning effort for ${model.displayName}`,
      replyMarkup: {
        inline_keyboard: model.supportedReasoningEfforts.map((option) => [
          {
            text: `${option.reasoningEffort === currentEffort ? "• " : ""}${option.reasoningEffort}`,
            callback_data:
              target.scope === "thread"
                ? `slash:model:apply:${modelIndex}:${option.reasoningEffort}`
                : `slash:model:apply:${target.scope}:${modelIndex}:${option.reasoningEffort}`
          }
        ])
      }
    });
    return true;
  }

  private async applyModelSelection(
    message: { chatId: number; topicId: number | null },
    modelIndex: number,
    reasoningEffort: ReasoningEffort,
    scope: SettingsSelectionScope = "thread"
  ): Promise<boolean> {
    const models = await this.codex.listModels();
    const model = models[modelIndex];
    if (!model) {
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        ...(message.topicId !== null ? { topicId: message.topicId } : {}),
        text: "That model is no longer available"
      });
      return false;
    }

    const target = await this.resolveThreadSettingsTarget(message, scope, {
      rejectIfActiveTurn: true
    });
    if (!target) {
      return false;
    }

    if (target.scope === "thread") {
      await this.codex.updateThreadSettings(target.session.codexThreadId!, {
        model: model.model,
        reasoningEffort
      });
    } else {
      await this.updateChatThreadSettingsDefaults(message.chatId, target.scope, {
        model: model.model,
        reasoningEffort
      });
      if (target.scope === "root" && target.session?.codexThreadId) {
        await this.codex.updateThreadSettings(target.session.codexThreadId, {
          model: model.model,
          reasoningEffort
        });
      }
    }
    await this.sendScopedBridgeMessage({
      chatId: message.chatId,
      ...(message.topicId !== null ? { topicId: message.topicId } : {}),
      text: buildModelUpdatedMessage(target.scope, model.model, reasoningEffort)
    });
    return true;
  }

  private async applyPermissionsSelection(
    message: { chatId: number; topicId: number | null },
    presetId: CodexPermissionPresetId,
    scope: SettingsSelectionScope = "thread"
  ): Promise<boolean> {
    const preset = getCodexPermissionPreset(presetId);
    const target = await this.resolveThreadSettingsTarget(message, scope, {
      rejectIfActiveTurn: true
    });
    if (!target) {
      return false;
    }

    if (target.scope === "thread") {
      await this.codex.updateThreadSettings(target.session.codexThreadId!, {
        approvalPolicy: preset.approvalPolicy,
        sandboxPolicy: preset.sandboxPolicy
      });
    } else {
      await this.updateChatThreadSettingsDefaults(message.chatId, target.scope, {
        approvalPolicy: preset.approvalPolicy,
        sandboxPolicy: preset.sandboxPolicy
      });
      if (target.scope === "root" && target.session?.codexThreadId) {
        await this.codex.updateThreadSettings(target.session.codexThreadId, {
          approvalPolicy: preset.approvalPolicy,
          sandboxPolicy: preset.sandboxPolicy
        });
      }
    }
    await this.sendScopedBridgeMessage({
      chatId: message.chatId,
      ...(message.topicId !== null ? { topicId: message.topicId } : {}),
      text: buildPermissionsUpdatedMessage(target.scope, preset.label)
    });
    return true;
  }

  private async handleSlashCallbackQuery(event: CallbackQueryEvent): Promise<void> {
    const [, area, action, ...rest] = event.data.split(":");
    if (area === "scope" && (action === "model" || action === "permissions")) {
      const scope = rest[0];
      if (scope !== "root" && scope !== "spawn") {
        await this.telegram.answerCallbackQuery(event.callbackQueryId, {
          text: "Unsupported callback"
        });
        return;
      }

      const opened =
        action === "model"
          ? await this.openModelSelection({ chatId: event.chatId, topicId: event.topicId }, 0, scope)
          : await this.openScopedPermissionsSelection({ chatId: event.chatId, topicId: event.topicId }, scope);
      await this.telegram.answerCallbackQuery(
        event.callbackQueryId,
        opened ? undefined : {
          text: `${action === "model" ? "Model" : "Permissions"} picker unavailable`
        }
      );
      return;
    }

    if (area === "fast" && action === "apply") {
      const [scope, fastAction] = rest;
      if ((scope !== "root" && scope !== "spawn") || !isFastSelectionAction(fastAction)) {
        await this.telegram.answerCallbackQuery(event.callbackQueryId, {
          text: "Unsupported callback"
        });
        return;
      }

      const updated = await this.applyRootFastSelection(event.chatId, scope, fastAction);
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: updated ? "Fast mode updated" : "Fast mode not updated"
      });
      return;
    }

    if (area === "permissions" && action === "apply") {
      const [maybeScope, maybePreset] = rest;
      const scope = maybePreset ? maybeScope : "thread";
      const presetId = maybePreset ?? maybeScope;
      if ((scope !== "thread" && scope !== "root" && scope !== "spawn") || !isCodexPermissionPresetId(presetId)) {
        await this.telegram.answerCallbackQuery(event.callbackQueryId, {
          text: "Unsupported callback"
        });
        return;
      }

      const updated = await this.applyPermissionsSelection(
        { chatId: event.chatId, topicId: event.topicId },
        presetId,
        scope
      );
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: updated ? "Permissions updated" : "Permissions not updated"
      });
      return;
    }

    if (area === "model" && action === "page") {
      const page = Number.parseInt(rest[0] ?? "", 10);
      if (Number.isNaN(page)) {
        await this.telegram.answerCallbackQuery(event.callbackQueryId, {
          text: "Invalid model page"
        });
        return;
      }

      const opened = await this.openModelSelection({ chatId: event.chatId, topicId: event.topicId }, page);
      await this.telegram.answerCallbackQuery(
        event.callbackQueryId,
        opened ? undefined : {
          text: "Model picker unavailable"
        }
      );
      return;
    }

    if (area === "model" && action === "pick") {
      const [maybeScope, maybeModelIndex] = rest;
      const scope = maybeModelIndex ? maybeScope : "thread";
      const modelIndexText = maybeModelIndex ?? maybeScope;
      const modelIndex = Number.parseInt(modelIndexText ?? "", 10);
      if (Number.isNaN(modelIndex)) {
        await this.telegram.answerCallbackQuery(event.callbackQueryId, {
          text: "Invalid model selection"
        });
        return;
      }

      if (scope !== "thread" && scope !== "root" && scope !== "spawn") {
        await this.telegram.answerCallbackQuery(event.callbackQueryId, {
          text: "Invalid model selection"
        });
        return;
      }

      const opened = await this.openModelReasoningSelection(
        { chatId: event.chatId, topicId: event.topicId },
        modelIndex,
        scope
      );
      await this.telegram.answerCallbackQuery(
        event.callbackQueryId,
        opened ? undefined : {
          text: "Model picker unavailable"
        }
      );
      return;
    }

    if (area === "model" && action === "apply") {
      const [first, second, third] = rest;
      const scope = third ? first : "thread";
      const modelIndexText = third ? second : first;
      const reasoningEffort = third ?? second;
      const modelIndex = Number.parseInt(modelIndexText ?? "", 10);
      if (scope !== "thread" && scope !== "root" && scope !== "spawn") {
        await this.telegram.answerCallbackQuery(event.callbackQueryId, {
          text: "Invalid reasoning selection"
        });
        return;
      }

      if (Number.isNaN(modelIndex) || !isReasoningEffort(reasoningEffort)) {
        await this.telegram.answerCallbackQuery(event.callbackQueryId, {
          text: "Invalid reasoning selection"
        });
        return;
      }

      const updated = await this.applyModelSelection(
        { chatId: event.chatId, topicId: event.topicId },
        modelIndex,
        reasoningEffort,
        scope
      );
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: updated ? "Model updated" : "Model not updated"
      });
      return;
    }

    await this.telegram.answerCallbackQuery(event.callbackQueryId, {
      text: "Unsupported callback"
    });
  }

  private async startSessionFromRootMessage(message: UserTurnMessage): Promise<void> {
    const pending = await this.database.createProvisioningSession({
      telegramChatId: String(message.chatId),
      surface: { kind: "root" }
    });

    try {
      const rootSettings = await this.getChatThreadSettingsDefaults(message.chatId).then((defaults) => defaults.root);
      const thread = await this.codex.createThread(DEFAULT_ROOT_SESSION_TITLE, {
        settings: toCodexThreadSettingsOverride(rootSettings)
      });
      await this.database.activateSession(pending.id, thread.threadId);
      const session = await this.database.getRootSessionByChat(message.chatId);
      if (!session) {
        throw new Error("Failed to load root session after activation");
      }

      await this.sendTurnForSession(session, message);
    } catch (error) {
      await this.database.markSessionErrored(pending.id);
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        text: `Failed to create Codex session for "${DEFAULT_ROOT_SESSION_TITLE}": ${formatError(error)}`
      });
    }
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

  private async startThreadSessionFromRootMessage(message: UserTurnMessage, promptText: string): Promise<void> {
    const trimmedPrompt = promptText.trim();
    if (!trimmedPrompt) {
      await this.#messenger.sendMessage({
        chatId: message.chatId,
        text: THREAD_USAGE_TEXT
      });
      return;
    }

    const title = deriveTopicTitle(trimmedPrompt);
    const forumTopic = await this.telegram.createForumTopic(
      message.chatId,
      title,
      await this.#topicIconPicker.pickCreateForumTopicOptions()
    );

    const topicMessage = {
      ...message,
      topicId: forumTopic.message_thread_id
    };

    await this.startSessionInTopic(topicMessage, title, {
      initialPromptText: trimmedPrompt,
      firstTurnMessage: replaceMessageText(topicMessage, trimmedPrompt)
    });
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
      threadCwd?: string;
    }
  ): Promise<void> {
    if (message.topicId === null) {
      throw new Error("Cannot start a session without a Telegram topic id");
    }
    const topicId = message.topicId;

    const pending = await this.database.createProvisioningSession({
      telegramChatId: String(message.chatId),
      telegramTopicId: topicId
    });

    try {
      const spawnSettings = await this.getChatThreadSettingsDefaults(message.chatId).then((defaults) => defaults.spawn);
      const thread = await this.codex.createThread(title, {
        ...(options?.threadCwd ? { cwd: options.threadCwd } : {}),
        settings: toCodexThreadSettingsOverride(spawnSettings)
      });
      await this.database.activateSession(pending.id, thread.threadId);
      let session = await this.database.getSessionByTopic(message.chatId, topicId);
      if (!session) {
        throw new Error(`Failed to load topic session ${topicId} after activation`);
      }

      if (options?.initialPreferredMode && session.preferredMode !== options.initialPreferredMode) {
        session = await this.database.updateSessionPreferredMode(
          Number(session.telegramChatId),
          session.telegramTopicId,
          options.initialPreferredMode
        ) ?? session;
      }

      await this.maybeSendThreadStartFooterMessage(message.chatId, message.topicId, session.preferredMode, thread);
      await this.maybeSendInitialPromptMessage(message.chatId, message.topicId, options?.initialPromptText);

      if (options?.postActivationTopicMessage) {
        await this.sendScopedBridgeMessage({
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
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: `Failed to create Codex session for "${title}": ${formatError(error)}`
      });
    }
  }

  private async maybeSendThreadStartFooterMessage(
    chatId: number,
    topicId: number,
    mode: SessionMode,
    thread: {
      model: string;
      reasoningEffort: ReasoningEffort | null;
      serviceTier: ServiceTier | null;
      cwd: string;
      branch: string | null;
    }
  ): Promise<void> {
    try {
      const rendered = buildRenderedThreadStartFooter({
        mode,
        model: thread.model,
        reasoningEffort: thread.reasoningEffort,
        serviceTier: thread.serviceTier,
        cwd: thread.cwd,
        branch: thread.branch
      });
      await this.sendScopedBridgeMessage({
        chatId,
        topicId,
        text: rendered.text,
        ...(rendered.entities ? { entities: rendered.entities } : {})
      });
    } catch (error) {
      this.logger.error("Failed to send startup footer into Telegram topic", error);
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

  private async getChatThreadSettingsDefaults(
    chatId: number
  ): Promise<{
    root: PersistedThreadSettings;
    spawn: PersistedThreadSettings;
  }> {
    const existing = await this.database.getChatThreadDefaults(String(chatId));
    if (existing) {
      return {
        root: existing.root,
        spawn: existing.spawn
      };
    }

    const globalSettings = await this.codex.readGlobalSettings();
    const defaults = toPersistedThreadSettings(globalSettings);
    await this.database.upsertChatThreadDefaults(String(chatId), {
      root: defaults,
      spawn: defaults
    });
    return {
      root: defaults,
      spawn: defaults
    };
  }

  private async updateChatThreadSettingsDefaults(
    chatId: number,
    scope: Exclude<SettingsSelectionScope, "thread">,
    update: CodexThreadSettingsOverride
  ): Promise<PersistedThreadSettings> {
    const defaults = await this.getChatThreadSettingsDefaults(chatId);
    const nextScopeSettings = mergePersistedThreadSettings(defaults[scope], update);
    await this.database.upsertChatThreadDefaults(String(chatId), {
      ...defaults,
      [scope]: nextScopeSettings
    });
    return nextScopeSettings;
  }

  private async resolveThreadSettingsTarget(
    message: { chatId: number; topicId: number | null },
    scope: SettingsSelectionScope,
    options?: {
      rejectIfActiveTurn?: boolean;
    }
  ): Promise<ThreadSettingsTarget | null> {
    if (scope === "thread") {
      if (message.topicId === null) {
        return null;
      }

      const resolved = await this.resolveCodexSettingsCommandTarget(message, options);
      if (!resolved || resolved.scope !== "thread") {
        return null;
      }

      return {
        scope: "thread",
        session: resolved.session,
        settings: resolved.settings
      };
    }

    const defaults = await this.getChatThreadSettingsDefaults(message.chatId);
    if (scope === "root") {
      const session = await this.database.getRootSessionByChat(message.chatId);
      if (options?.rejectIfActiveTurn && this.findActiveTurnByTopic(message.chatId, null)) {
        await this.sendScopedBridgeMessage({
          chatId: message.chatId,
          text: SETTINGS_CHANGE_REJECTED_TEXT
        });
        return null;
      }

      return {
        scope: "root",
        session: session ?? null,
        settings: defaults.root
      };
    }

    return {
      scope: "spawn",
      settings: defaults.spawn
    };
  }

  private async resolveCodexSettingsCommandTarget(
    location: {
      chatId: number;
      topicId: number | null;
    },
    options?: {
      rejectIfActiveTurn?: boolean;
    }
  ): Promise<
    | {
        scope: "global";
        settings: ThreadStartSettings;
      }
    | {
        scope: "thread";
        session: TopicSession;
        settings: ThreadStartSettings;
      }
    | null
  > {
    if (location.topicId === null) {
      return {
        scope: "global",
        settings: await this.codex.readGlobalSettings()
      };
    }

    const session = await this.database.getSessionByTopic(location.chatId, location.topicId);
    if (!session?.codexThreadId) {
      await this.sendScopedBridgeMessage({
        chatId: location.chatId,
        topicId: location.topicId,
        text: MODE_COMMAND_REQUIRES_SESSION_TEXT
      });
      return null;
    }

    if (options?.rejectIfActiveTurn && this.findActiveTurnByTopic(location.chatId, location.topicId)) {
      await this.sendScopedBridgeMessage({
        chatId: location.chatId,
        topicId: location.topicId,
        text: SETTINGS_CHANGE_REJECTED_TEXT
      });
      return null;
    }

    return {
      scope: "thread",
      session,
      settings: await this.codex.ensureThreadLoaded(session.codexThreadId)
    };
  }

  private async sendTurnForSession(
    session: TopicSession | BridgeSession,
    message: UserTurnMessage,
    options?: {
      forceMode?: SessionMode;
    }
  ): Promise<void> {
    if (!session.codexThreadId) {
      throw new Error(`Session ${session.id} has no Codex thread id`);
    }

    const effectiveSettings = await this.codex.ensureThreadLoaded(session.codexThreadId);
    const turn = await this.submitPreparedInput(message, {
      submit: (input) =>
        this.codex.sendTurn(
          session.codexThreadId!,
          input,
          {
            collaborationMode: buildTurnCollaborationMode(
              options?.forceMode ?? session.preferredMode,
              effectiveSettings,
              this.config.codex.developerInstructions ?? null,
              options?.forceMode === "default"
            )
          }
        )
    });
    this.#turnsAwaitingActivation.add(turn.id);

    try {
      const activeTurn = this.#lifecycle.activateTurn(
        message,
        session.codexThreadId!,
        turn.id,
        effectiveSettings.model,
        effectiveSettings.reasoningEffort,
        effectiveSettings.serviceTier,
        options?.forceMode ?? session.preferredMode
      );
      await this.flushStagedTurnEvents(turn.id);
      if (activeTurn.statusDraft) {
        await this.#lifecycle.publishCurrentStatus(turn.id, true);
      }
    } finally {
      this.#turnsAwaitingActivation.delete(turn.id);
    }
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
          await this.#lifecycle.handlePlanUpdated(notification.params.turnId, notification.params.explanation);
        }
      },
      "thread/tokenUsage/updated": async () => {
        if (notification.method === "thread/tokenUsage/updated") {
          this.#lifecycle.handleThreadTokenUsageUpdated(notification.params.turnId, notification.params.tokenUsage);
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

    await this.sendScopedBridgeMessage({
      chatId: Number.parseInt(session.telegramChatId, 10),
      topicId: session.surface.kind === "topic" ? session.surface.topicId : null,
      text: "Context compacted"
    });
  }

  private async tryResolveUserInput(message: UserTurnMessage): Promise<boolean> {
    return this.#requestCoordinator.tryResolveUserInput(message);
  }

  private async restartKirbot(message: UserTurnMessage): Promise<void> {
    if (!this.#restartKirbot) {
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        text: RESTART_NOT_CONFIGURED_TEXT
      });
      return;
    }

    await this.sendScopedBridgeMessage({
      chatId: message.chatId,
      text: RESTARTING_KIRBOT_TEXT
    });

    try {
      await this.#restartKirbot();
    } catch (error) {
      this.logger.error("Failed to restart kirbot", error);
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        text: `Failed to rebuild or restart kirbot: ${formatError(error)}`
      });
    }
  }

  private findActiveTurnByTopic(chatId: number, topicId: number | null): TurnContext | undefined {
    return this.#lifecycle.getActiveTurnByTopic(chatId, topicId);
  }

  private async sendInvalidSlashCommandMessage(message: UserTurnMessage): Promise<void> {
    await this.sendScopedBridgeMessage({
      chatId: message.chatId,
      ...(message.topicId !== null ? { topicId: message.topicId } : {}),
      text: INVALID_COMMAND_TEXT
    });
  }

  private async buildTopicCommandReplyMarkup(): Promise<ReplyKeyboardMarkup | undefined> {
    return buildTopicCommandKeyboard(
      getSurfaceableTopicSlashCommands(),
      await this.database.listCustomCommands()
    );
  }

  private async sendScopedBridgeMessage(input: {
    chatId: number;
    topicId?: number | null;
    text: string;
    entities?: MessageEntity[];
    replyToMessageId?: number;
    replyMarkup?: TelegramReplyMarkup;
    disableNotification?: boolean;
  }): Promise<{ messageId: number }> {
    const replyMarkup =
      input.replyMarkup ?? (
        input.topicId !== null && input.topicId !== undefined
          ? await this.buildTopicCommandReplyMarkup()
          : undefined
      );

    return this.#messenger.sendMessage({
      ...input,
      ...(replyMarkup ? { replyMarkup } : {})
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
        await this.sendScopedBridgeMessage({
          chatId: message.chatId,
          topicId: message.topicId,
          text: classification.userMessage ?? `Codex rejected the follow-up: ${formatError(error)}`
        });
        return;
      }

      this.logger.error("Failed to steer turn", error);
      await this.sendScopedBridgeMessage({
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

  private async submitQueuedFollowUp(chatId: number, topicId: number | null, message: UserTurnMessage): Promise<void> {
    const session = await this.getSessionByLocation(chatId, topicId);
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
              reply_markup: replyMarkup
            }
          : undefined;
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

  private async maybeSendNextQueuedFollowUp(chatId: number, topicId: number | null): Promise<void> {
    if (this.findActiveTurnByTopic(chatId, topicId)) {
      return;
    }

    const nextMessage = this.#lifecycle.peekNextQueuedFollowUp(chatId, topicId);
    if (!nextMessage) {
      return;
    }

    const session = await this.getSessionByLocation(chatId, topicId);
    if (!session?.codexThreadId) {
      return;
    }

    await this.sendTurnForSession(session, nextMessage);
    this.#lifecycle.shiftNextQueuedFollowUp(chatId, topicId);
    await this.syncQueuePreview(this.#lifecycle.getQueueState(chatId, topicId));
  }

  private async getSessionByLocation(chatId: number, topicId: number | null): Promise<BridgeSession | undefined> {
    return topicId === null
      ? this.database.getRootSessionByChat(chatId)
      : this.database.getSessionBySurface(chatId, { kind: "topic", topicId });
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
  const preservedInput = message.input.filter((item): item is Exclude<UserTurnInput, Extract<UserTurnInput, { type: "text" }>> => item.type !== "text");
  const input: UserTurnInput[] = [];
  if (text.length > 0) {
    input.push({
      type: "text",
      text,
      text_elements: []
    });
  }
  input.push(...preservedInput);

  return {
    ...message,
    text,
    input
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

function topicKey(chatId: number, topicId: number | null): string {
  return topicId === null ? `${chatId}:root` : `${chatId}:${topicId}`;
}

function buildFastStatusMessage(scope: "global" | "thread", serviceTier: ServiceTier | null): string {
  return scope === "global"
    ? `Global default fast mode is ${serviceTier === "fast" ? "on" : "off"}`
    : `Fast mode is ${serviceTier === "fast" ? "on" : "off"} for this thread`;
}

function buildFastUpdatedMessage(scope: "global" | "thread", serviceTier: ServiceTier | null): string {
  return scope === "global"
    ? `Global default fast mode ${serviceTier === "fast" ? "enabled" : "disabled"}`
    : `Thread fast mode ${serviceTier === "fast" ? "enabled" : "disabled"}`;
}

type FastSelectionAction = "toggle" | "on" | "off" | "status";

function isFastSelectionAction(value: string | undefined): value is FastSelectionAction {
  return value === "toggle" || value === "on" || value === "off" || value === "status";
}

function buildScopedFastStatusMessage(scope: Exclude<SettingsSelectionScope, "thread">, serviceTier: ServiceTier | null): string {
  return scope === "root"
    ? `Root thread fast mode is ${serviceTier === "fast" ? "on" : "off"}`
    : `New thread default fast mode is ${serviceTier === "fast" ? "on" : "off"}`;
}

function buildScopedFastUpdatedMessage(scope: Exclude<SettingsSelectionScope, "thread">, serviceTier: ServiceTier | null): string {
  return scope === "root"
    ? `Root thread fast mode ${serviceTier === "fast" ? "enabled" : "disabled"}`
    : `New thread default fast mode ${serviceTier === "fast" ? "enabled" : "disabled"}`;
}

function describeModelSelectionTitle(scope: SettingsSelectionScope): string {
  switch (scope) {
    case "thread":
      return "Choose the model for this thread";
    case "root":
      return "Choose the model for the root thread";
    case "spawn":
      return "Choose the default model for new /thread topics";
  }
}

function describePermissionsSelectionTitle(scope: SettingsSelectionScope): string {
  switch (scope) {
    case "thread":
      return "Choose Codex permissions for this thread";
    case "root":
      return "Choose Codex permissions for the root thread";
    case "spawn":
      return "Choose default Codex permissions for new /thread topics";
  }
}

function describePermissionsSelectionScope(scope: SettingsSelectionScope): string {
  switch (scope) {
    case "thread":
      return "Your selection will apply only to this topic";
    case "root":
      return "Your selection will apply to the root thread";
    case "spawn":
      return "Your selection will apply to future /thread topics";
  }
}

function buildModelUpdatedMessage(scope: SettingsSelectionScope, model: string, reasoningEffort: ReasoningEffort): string {
  switch (scope) {
    case "thread":
      return `Thread model set to ${model} ${reasoningEffort}`;
    case "root":
      return `Root thread model set to ${model} ${reasoningEffort}`;
    case "spawn":
      return `New thread default model set to ${model} ${reasoningEffort}`;
  }
}

function buildPermissionsUpdatedMessage(scope: SettingsSelectionScope, label: string): string {
  switch (scope) {
    case "thread":
      return `Thread permissions set to ${label}`;
    case "root":
      return `Root thread permissions set to ${label}`;
    case "spawn":
      return `New thread default permissions set to ${label}`;
  }
}

function toPersistedThreadSettings(settings: Pick<CodexThreadSettings, "model" | "reasoningEffort" | "serviceTier" | "approvalPolicy" | "sandboxPolicy">): PersistedThreadSettings {
  return {
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    serviceTier: settings.serviceTier,
    approvalPolicy: settings.approvalPolicy,
    sandboxPolicy: settings.sandboxPolicy
  };
}

function mergePersistedThreadSettings(
  current: PersistedThreadSettings,
  update: CodexThreadSettingsOverride
): PersistedThreadSettings {
  return {
    model: update.model ?? current.model,
    reasoningEffort: "reasoningEffort" in update ? update.reasoningEffort ?? null : current.reasoningEffort,
    serviceTier: "serviceTier" in update ? update.serviceTier ?? null : current.serviceTier,
    approvalPolicy: update.approvalPolicy ?? current.approvalPolicy,
    sandboxPolicy: update.sandboxPolicy ?? current.sandboxPolicy
  };
}

function toCodexThreadSettingsOverride(settings: PersistedThreadSettings): CodexThreadSettingsOverride {
  return {
    ...(settings.model ? { model: settings.model } : {}),
    reasoningEffort: settings.reasoningEffort,
    serviceTier: settings.serviceTier,
    ...(settings.approvalPolicy ? { approvalPolicy: settings.approvalPolicy } : {}),
    ...(settings.sandboxPolicy ? { sandboxPolicy: settings.sandboxPolicy } : {})
  };
}

function toPermissionDetectionSettings(
  settings: PersistedThreadSettings | ThreadStartSettings
): Pick<CodexThreadSettings, "approvalPolicy" | "sandboxPolicy"> | null {
  if (!settings.approvalPolicy || !settings.sandboxPolicy) {
    return null;
  }

  return {
    approvalPolicy: settings.approvalPolicy,
    sandboxPolicy: settings.sandboxPolicy
  };
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
