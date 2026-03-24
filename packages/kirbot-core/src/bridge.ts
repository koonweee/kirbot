import type { MessageEntity } from "grammy/types";

import type { AppConfig } from "./config";
import { BridgeDatabase } from "./db";
import type {
  BridgeSession,
  PersistedThreadSettings,
  PendingCustomCommandAdd,
  SessionSurface,
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
  getVisibleSlashCommands,
  isAllowedSlashCommandInScope,
  isBuiltInSlashCommand,
  isCodexSlashCommand,
  parseSlashCommand,
  parseSlashCommandToken,
  type ParsedSlashCommand,
  type SlashCommandScope
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
import {
  TelegramMessenger,
  type InlineKeyboardMarkup,
  type ReplyKeyboardMarkup,
  type TelegramApi,
  type TelegramDeliveryClass,
  type TelegramDeliveryPolicy,
  type TelegramReplyMarkup
} from "./telegram-messenger";
import { BridgeTurnRuntime, type QueueStateSnapshot } from "./turn-runtime";

export type CallbackQueryEvent = {
  callbackQueryId: string;
  data: string;
  chatId: number;
  topicId: number | null;
  userId: number;
  telegramUsername?: string;
};

export interface BridgeCodexApi {
  createThread(
    profileId: string,
    title: string,
    options?: {
      cwd?: string | null;
      settings?: CodexThreadSettingsOverride | null;
    }
  ): Promise<{ threadId: string; branch: string | null } & ThreadStartSettings>;
  registerThreadProfile(threadId: string, profileId: string): void;
  readProfileSettings(profileId: string): Promise<ThreadStartSettings>;
  ensureThreadLoaded(threadId: string): Promise<ThreadStartSettings>;
  readThread(threadId: string): Promise<{ name: string | null; cwd: string }>;
  compactThread(threadId: string): Promise<void>;
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
  listModels(profileId: string): Promise<Model[]>;
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

type SettingsSelectionScope = "thread" | "root";

type ThreadSettingsTarget =
  | {
      scope: "thread";
      session: TopicSession;
      settings: ThreadStartSettings;
    }
  | {
      scope: "root";
      session: BridgeSession;
      settings: ThreadStartSettings;
    };

export type TelegramCodexBridgeOptions = {
  topicIconPicker?: TopicIconPicker;
  restartKirbot?: (reportStep: (command: string) => Promise<void>) => Promise<void>;
  messengerDeliveryPolicy?: Partial<TelegramDeliveryPolicy>;
};

const INVALID_COMMAND_TEXT = "This command is not valid here";
const NO_ACTIVE_RESPONSE_TO_STOP_TEXT = "There is no active response to stop right now";
const STOPPING_CURRENT_RESPONSE_TEXT = "Stopping the current response…";
const RESPONSE_ALREADY_FINISHING_TEXT = "This response is already finishing";
const MODE_CHANGE_REJECTED_TEXT = "Wait for the current response to finish or stop it first before changing modes";
const SETTINGS_CHANGE_REJECTED_TEXT = "Wait for the current response to finish or stop it first before changing settings";
const COMPACT_COMMAND_REJECTED_TEXT = "Wait for the current response to finish or stop it first before compacting";
const CLEAR_COMMAND_REJECTED_TEXT = "Wait for the current response to finish or stop it first before clearing";
const MODE_COMMAND_REQUIRES_SESSION_TEXT = "This topic does not have a Codex session yet. Send a normal message first to start one";
const COMPACT_COMMAND_REQUIRES_SESSION_TEXT = "This chat does not have a Codex session yet. Send a normal message first to start one";
const FAST_USAGE_TEXT = "Usage: /fast [on|off|status]";
const THREAD_USAGE_TEXT = "Usage: /thread <initial prompt>";
const RESTART_NOT_CONFIGURED_TEXT = "Restart is not configured for this kirbot deployment";
const RESTART_COMPLETED_TEXT = "Kirbot production session restarted.";
const PLAN_MODE_ENABLED_TEXT = "Plan mode enabled";
const PLAN_MODE_EXITED_TEXT = "Exited plan mode";
const COMMANDS_KEYBOARD_TEXT = "Commands";
const DEFAULT_ROOT_SESSION_TITLE = "Root Chat";
const DEFAULT_NEW_PLAN_SESSION_TITLE = "New Plan Session";
const UNAVAILABLE_CODEX_SESSION_TEXT = "This Codex session is no longer available. Start a new session in this chat or topic.";
const UNAVAILABLE_CODEX_SESSION_CALLBACK_TEXT = "Codex session is no longer available";
const STAGED_TURN_EVENT_TIMEOUT_MS = 10_000;
const MODEL_PAGE_SIZE = 6;
const CUSTOM_COMMAND_CONFIRMATION_STALE_TEXT = "This confirmation is no longer pending";
const ROOT_SESSION_PROVISIONING_TEXT = "The General Codex session is still provisioning. Try again in a moment";
const WORKSPACE_CHAT_ONLY_TEXT = "Use Kirbot from the configured workspace forum chat.";

class UnavailableCodexSessionError extends Error {
  constructor() {
    super("Codex session is no longer available");
    this.name = "UnavailableCodexSessionError";
  }
}

export class TelegramCodexBridge {
  readonly #queuePreviewMessageIds = new Map<string, number>();
  readonly #queuePreviewDesiredState = new Map<
    string,
    {
      chatId: number;
      topicId: number | null;
      previewText: string | null;
      replyMarkup: InlineKeyboardMarkup | null;
    }
  >();
  readonly #queuePreviewSyncs = new Map<string, Promise<void>>();
  readonly #compactionNoticeMessageIds = new Map<string, number>();
  readonly #notificationChains = new Map<string, Promise<void>>();
  readonly #sessionProvisioningBySurface = new Map<string, Promise<void>>();
  readonly #stagedTurnEvents = new Map<string, AppServerEvent[]>();
  readonly #stagedTurnEventTimers = new Map<string, NodeJS.Timeout>();
  readonly #turnsAwaitingActivation = new Set<string>();
  readonly #messenger: TelegramMessenger;
  readonly #lifecycle: TurnLifecycleCoordinator;
  readonly #requestCoordinator: BridgeRequestCoordinator;
  readonly #topicIconPicker: TopicIconPicker;
  readonly #restartKirbot: ((reportStep: (command: string) => Promise<void>) => Promise<void>) | null;

  constructor(
    private readonly config: AppConfig,
    private readonly database: BridgeDatabase,
    private readonly telegram: TelegramApi,
    private readonly codex: BridgeCodexApi,
    private readonly mediaStore: TemporaryImageStore,
    private readonly logger: LoggerLike = console,
    options?: TelegramCodexBridgeOptions
  ) {
    this.#messenger = new TelegramMessenger(telegram, logger, options?.messengerDeliveryPolicy);
    this.#topicIconPicker = options?.topicIconPicker ?? new RandomTopicIconPicker(telegram, logger);
    this.#restartKirbot = options?.restartKirbot ?? null;
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
      database,
      this.#messenger,
      codex,
      this.getTurnContext.bind(this),
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
    const inserted = await this.database.markUpdateProcessed(message.updateId);
    if (!inserted) {
      return;
    }

    if (message.chatId !== this.config.telegram.workspaceChatId) {
      await this.rejectUnsupportedChatMessage(message);
      return;
    }

    try {
      if (message.topicId === null) {
        await this.handleRootMessage(message);
        return;
      }

      await this.handleTopicMessage(message);
    } catch (error) {
      if (this.isUnavailableCodexSessionError(error)) {
        await this.sendScopedBridgeMessage({
          chatId: message.chatId,
          ...(message.topicId !== null ? { topicId: message.topicId } : {}),
          text: UNAVAILABLE_CODEX_SESSION_TEXT
        });
        return;
      }

      throw error;
    }
  }

  async handleTopicClosed(event: TopicLifecycleEvent): Promise<void> {
    if (event.chatId !== this.config.telegram.workspaceChatId) {
      return;
    }

    const session = await this.database.archiveSessionByTopic(event.chatId, event.topicId);
    if (!session?.codexThreadId) {
      return;
    }

    try {
      await this.withRegisteredPersistedThread(session, (threadId) => this.codex.archiveThread(threadId));
    } catch (error) {
      if (this.isUnavailableCodexSessionError(error)) {
        return;
      }

      this.logger.error("Failed to archive Codex thread", error);
    }
  }

  getActiveTurnCount(): number {
    return this.#lifecycle.getActiveTurnCount();
  }

  getActiveTopics(): Array<{ chatId: number; topicId: number | null }> {
    return this.#lifecycle.getActiveTopics();
  }

  private getTurnContext(turnId: string): TurnContext | undefined {
    return this.#lifecycle.getTurn(turnId);
  }

  async handleCallbackQuery(event: CallbackQueryEvent): Promise<void> {
    try {
      if (event.chatId !== this.config.telegram.workspaceChatId) {
        await this.answerCallbackQuery(event.callbackQueryId, {
          text: WORKSPACE_CHAT_ONLY_TEXT
        });
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

      await this.answerCallbackQuery(event.callbackQueryId, {
        text: "Unsupported callback"
      });
    } catch (error) {
      if (this.isUnavailableCodexSessionError(error)) {
        await this.sendScopedBridgeMessage({
          chatId: event.chatId,
          ...(event.topicId !== null ? { topicId: event.topicId } : {}),
          text: UNAVAILABLE_CODEX_SESSION_TEXT
        });
        if (event.data !== TOPIC_IMPLEMENT_CALLBACK_DATA) {
          await this.answerCallbackQuery(event.callbackQueryId, {
            text: UNAVAILABLE_CODEX_SESSION_CALLBACK_TEXT
          });
        }
        return;
      }

      throw error;
    }
  }

  private async rejectUnsupportedChatMessage(message: UserTurnMessage): Promise<void> {
    if (message.chatId <= 0) {
      return;
    }

    await this.#messenger.sendMessage({
      chatId: message.chatId,
      text: WORKSPACE_CHAT_ONLY_TEXT
    });
  }

  private async handleTopicImplementCallbackQuery(event: CallbackQueryEvent): Promise<void> {
    if (event.topicId === null) {
      await this.answerCallbackQuery(event.callbackQueryId, {
        text: "This action requires a topic"
      });
      return;
    }

    await this.answerCallbackQuery(event.callbackQueryId);
    await this.implementLatestPlan(buildSyntheticCallbackMessage(event, "/implement"), "");
  }

  private async handleTurnCallbackQuery(event: CallbackQueryEvent): Promise<void> {
    const [, turnId, action] = event.data.split(":");
    if (action !== "sendNow" || !turnId) {
      await this.answerCallbackQuery(event.callbackQueryId, {
        text: "Unsupported callback"
      });
      return;
    }

    if (event.topicId === null) {
      await this.answerCallbackQuery(event.callbackQueryId, {
        text: "This action requires a topic"
      });
      return;
    }

    const activeTurn = this.findActiveTurnByTopic(event.chatId, event.topicId);
    if (!activeTurn || activeTurn.turnId !== turnId) {
      await this.answerCallbackQuery(event.callbackQueryId, {
        text: "This turn is no longer active"
      });
      return;
    }

    if (activeTurn.stopRequested) {
      await this.answerCallbackQuery(event.callbackQueryId, {
        text: "Interrupt already requested"
      });
      return;
    }

    const queueState = this.#lifecycle.getQueueState(event.chatId, event.topicId);
    if (queueState.pendingSteers.length === 0) {
      await this.answerCallbackQuery(event.callbackQueryId, {
        text: "No pending steer instructions to send"
      });
      return;
    }

    this.#lifecycle.requestPendingSteerSubmissionAfterInterrupt(turnId);

    try {
      await this.codex.interruptTurn(activeTurn.threadId, activeTurn.turnId);
      await this.answerCallbackQuery(event.callbackQueryId, {
        text: "Submitting queued steer instructions"
      });
    } catch (error) {
      const classification = classifyInterruptError(error);
      if (classification.kind === "stale_or_missing_active_turn") {
        this.#lifecycle.requestPendingSteerSubmissionAfterInterrupt(turnId);
        await this.#lifecycle.finalizeInterruptedTurnById(activeTurn.threadId, activeTurn.turnId);
        await this.answerCallbackQuery(event.callbackQueryId, {
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
      await this.answerCallbackQuery(event.callbackQueryId, {
        text: "Failed to interrupt turn"
      });
    }
  }

  private async handleRootMessage(message: UserTurnMessage): Promise<void> {
    const command = parseSlashCommand(message.text);
    if (command) {
      if (!isAllowedSlashCommandInScope(command.command, "general")) {
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

    if (command.command === "commands") {
      await this.showCommandKeyboard(message);
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

    if (command.command === "commands") {
      await this.showCommandKeyboard(message);
      return;
    }

    await this.sendInvalidSlashCommandMessage(message);
  }

  private async handleRootCodexSlashCommand(message: UserTurnMessage, command: ParsedSlashCommand): Promise<void> {
    if (command.command === "fast") {
      await this.handleFastSlashCommand(
        {
          chatId: message.chatId,
          topicId: null
        },
        command.argsText
      );
      return;
    }

    if (command.command === "clear") {
      await this.clearCurrentThread(message);
      return;
    }

    if (command.command === "compact") {
      await this.compactCurrentThread(message);
      return;
    }

    if (command.command === "model") {
      await this.openModelSelection({ chatId: message.chatId, topicId: null }, 0, "root");
      return;
    }

    if (command.command === "permissions" || command.command === "approvals") {
      await this.openScopedPermissionsSelection({
        chatId: message.chatId,
        topicId: null
      }, "root");
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

    if (command.command === "clear") {
      await this.clearCurrentThread(message);
      return;
    }

    if (command.command === "compact") {
      await this.compactCurrentThread(message);
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
      await this.answerCallbackQuery(event.callbackQueryId, {
        text: "Unsupported callback"
      });
      return;
    }

    const pending = await this.database.getPendingCustomCommandAddById(parsed.pendingId);
    if (!pending || pending.status !== "pending") {
      await this.answerCallbackQuery(event.callbackQueryId, {
        text: CUSTOM_COMMAND_CONFIRMATION_STALE_TEXT
      });
      return;
    }

    if (parsed.action === "cancel") {
      await this.database.updatePendingCustomCommandAddStatus(pending.id, "canceled");
      await this.maybeEditPendingCustomCommandMessage(pending, buildCustomCommandCanceledText(pending.command));
      await this.answerCallbackQuery(event.callbackQueryId, {
        text: "Canceled"
      });
      return;
    }

    const conflict = await this.getCustomCommandConflictText(pending.command, pending.id);
    if (conflict) {
      await this.database.updatePendingCustomCommandAddStatus(pending.id, "canceled");
      await this.maybeEditPendingCustomCommandMessage(pending, conflict);
      await this.answerCallbackQuery(event.callbackQueryId, {
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
        await this.answerCallbackQuery(event.callbackQueryId, {
          text: "Could not add command"
        });
        return;
      }

      this.logger.error("Failed to add custom command", error);
      await this.answerCallbackQuery(event.callbackQueryId, {
        text: "Failed to add command"
      });
      return;
    }

    await this.database.updatePendingCustomCommandAddStatus(pending.id, "confirmed");
    await this.maybeEditPendingCustomCommandMessage(pending, buildCustomCommandAddedText(pending.command));
    await this.answerCallbackQuery(event.callbackQueryId, {
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

    await this.editBridgeMessage({
      chatId: Number.parseInt(pending.telegramChatId, 10),
      messageId: pending.telegramMessageId,
      text,
      coalesceKey: `custom-command:${pending.id}`,
      replacePending: true
    });
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

  private async compactCurrentThread(message: UserTurnMessage): Promise<void> {
    const session = await this.requireCompactCommandSession(message);
    if (!session) {
      return;
    }

    try {
      const notice = await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        ...(message.topicId !== null ? { topicId: message.topicId } : {}),
        text: "Compacting…"
      });
      this.#compactionNoticeMessageIds.set(session.codexThreadId!, notice.messageId);

      await this.withRegisteredPersistedThread(session, (threadId) => this.codex.compactThread(threadId));
    } catch (error) {
      if (this.isUnavailableCodexSessionError(error)) {
        throw error;
      }

      this.logger.error("Failed to compact thread", error);
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        ...(message.topicId !== null ? { topicId: message.topicId } : {}),
        text: `Failed to compact the current thread: ${formatError(error)}`
      });
    }
  }

  private async requireCompactCommandSession(message: UserTurnMessage): Promise<BridgeSession | TopicSession | null> {
    const session = await this.getSessionByLocation(message.chatId, message.topicId);
    if (!session) {
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        ...(message.topicId !== null ? { topicId: message.topicId } : {}),
        text: message.topicId === null ? COMPACT_COMMAND_REQUIRES_SESSION_TEXT : MODE_COMMAND_REQUIRES_SESSION_TEXT
      });
      return null;
    }

    if (!session.codexThreadId) {
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        ...(message.topicId !== null ? { topicId: message.topicId } : {}),
        text: message.topicId === null ? ROOT_SESSION_PROVISIONING_TEXT : "This topic is still provisioning a Codex session. Try again in a moment"
      });
      return null;
    }

    if (this.findActiveTurnByTopic(message.chatId, message.topicId)) {
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        ...(message.topicId !== null ? { topicId: message.topicId } : {}),
        text: COMPACT_COMMAND_REJECTED_TEXT
      });
      return null;
    }

    return session;
  }

  private async requireClearCommandSession(message: UserTurnMessage): Promise<BridgeSession | TopicSession | null> {
    const session = await this.getSessionByLocation(message.chatId, message.topicId);
    if (!session) {
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        ...(message.topicId !== null ? { topicId: message.topicId } : {}),
        text: message.topicId === null ? COMPACT_COMMAND_REQUIRES_SESSION_TEXT : MODE_COMMAND_REQUIRES_SESSION_TEXT
      });
      return null;
    }

    if (!session.codexThreadId) {
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        ...(message.topicId !== null ? { topicId: message.topicId } : {}),
        text: message.topicId === null ? ROOT_SESSION_PROVISIONING_TEXT : "This topic is still provisioning a Codex session. Try again in a moment"
      });
      return null;
    }

    const activeTurn = this.findActiveTurnByTopic(message.chatId, message.topicId);
    const queueState = this.#lifecycle.getQueueState(message.chatId, message.topicId);
    if (activeTurn || queueState.pendingSteers.length > 0 || queueState.queuedFollowUps.length > 0) {
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        ...(message.topicId !== null ? { topicId: message.topicId } : {}),
        text: CLEAR_COMMAND_REJECTED_TEXT
      });
      return null;
    }

    return session;
  }

  private async clearCurrentThread(message: UserTurnMessage): Promise<void> {
    const session = await this.requireClearCommandSession(message);
    if (!session) {
      return;
    }

    try {
      const effectiveSettings = await this.resolveEffectiveThreadStartSettings(session);
      const thread = await this.withRegisteredPersistedThread(
        session,
        (threadId) => this.codex.readThread(threadId)
      );
      const title = thread.name ?? (isRootBridgeSession(session) ? DEFAULT_ROOT_SESSION_TITLE : "Fresh Codex Thread");
      const freshThread = await this.codex.createThread(session.profileId, title, {
        cwd: effectiveSettings.cwd,
        settings: toCodexThreadSettingsOverrideFromThreadStartSettings(effectiveSettings)
      });
      this.codex.registerThreadProfile(freshThread.threadId, session.profileId);
      await this.database.activateSession(session.id, freshThread.threadId);
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        ...(message.topicId !== null ? { topicId: message.topicId } : {}),
        text: "Started a fresh Codex thread"
      });
    } catch (error) {
      if (this.isUnavailableCodexSessionError(error)) {
        throw error;
      }

      this.logger.error("Failed to clear thread", error);
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        ...(message.topicId !== null ? { topicId: message.topicId } : {}),
        text: `Failed to start a fresh thread: ${formatError(error)}`
      });
    }
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

    if (this.findActiveTurnByTopic(location.chatId, location.topicId)) {
      await this.sendScopedBridgeMessage({
        chatId: location.chatId,
        ...(location.topicId !== null ? { topicId: location.topicId } : {}),
        text: SETTINGS_CHANGE_REJECTED_TEXT
      });
      return;
    }

    const nextEffective =
      target.scope === "root"
        ? await this.updateSessionSettingsForSurface(location.chatId, { kind: "general" }, {
            serviceTier: nextTier
          })
        : await this.updateSessionSettingsForSurface(location.chatId, { kind: "topic", topicId: location.topicId! }, {
            serviceTier: nextTier
          });
    await this.sendScopedBridgeMessage({
      chatId: location.chatId,
      ...(location.topicId !== null ? { topicId: location.topicId } : {}),
      text: buildFastUpdatedMessage(target.scope, nextEffective.serviceTier)
    });
  }

  private async openPermissionsSelection(message: { chatId: number; topicId: number | null }): Promise<boolean> {
    return this.openScopedPermissionsSelection(message, "thread");
  }

  private async openScopedPermissionsSelection(
    message: { chatId: number; topicId: number | null },
    scope: SettingsSelectionScope
  ): Promise<boolean> {
    const target = await this.resolveThreadSettingsTarget(message, scope, {
      rejectIfActiveTurn: true
    });
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
    const target = await this.resolveThreadSettingsTarget(message, scope, {
      rejectIfActiveTurn: true
    });
    if (!target) {
      return false;
    }

    const models = await this.codex.listModels(this.resolveModelListProfileId(target));
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
                    ? [{
                        text: "Previous",
                        callback_data:
                          target.scope === "thread"
                            ? `slash:model:page:${boundedPage - 1}`
                            : `slash:model:page:${target.scope}:${boundedPage - 1}`
                      }]
                    : []),
                  ...(boundedPage < totalPages - 1
                    ? [{
                        text: "Next",
                        callback_data:
                          target.scope === "thread"
                            ? `slash:model:page:${boundedPage + 1}`
                            : `slash:model:page:${target.scope}:${boundedPage + 1}`
                      }]
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
    const target = await this.resolveThreadSettingsTarget(message, scope, {
      rejectIfActiveTurn: true
    });
    if (!target) {
      return false;
    }

    const models = await this.codex.listModels(this.resolveModelListProfileId(target));
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
        inline_keyboard: model.supportedReasoningEfforts.map(
          (option: (typeof model.supportedReasoningEfforts)[number]) => [
          {
            text: `${option.reasoningEffort === currentEffort ? "• " : ""}${option.reasoningEffort}`,
            callback_data:
              target.scope === "thread"
                ? `slash:model:apply:${modelIndex}:${option.reasoningEffort}`
                : `slash:model:apply:${target.scope}:${modelIndex}:${option.reasoningEffort}`
          }
        ]
        )
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
    const target = await this.resolveThreadSettingsTarget(message, scope, {
      rejectIfActiveTurn: true
    });
    if (!target) {
      return false;
    }

    const models = await this.codex.listModels(this.resolveModelListProfileId(target));
    const model = models[modelIndex];
    if (!model) {
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        ...(message.topicId !== null ? { topicId: message.topicId } : {}),
        text: "That model is no longer available"
      });
      return false;
    }

    if (target.scope === "thread") {
      await this.updateSessionSettingsForSurface(message.chatId, { kind: "topic", topicId: message.topicId! }, {
        model: model.model,
        reasoningEffort
      });
    } else {
      await this.updateSessionSettingsForSurface(message.chatId, { kind: "general" }, {
        model: model.model,
        reasoningEffort
      });
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
      await this.updateSessionSettingsForSurface(message.chatId, { kind: "topic", topicId: message.topicId! }, {
        approvalPolicy: preset.approvalPolicy,
        sandboxPolicy: preset.sandboxPolicy
      });
    } else {
      await this.updateSessionSettingsForSurface(message.chatId, { kind: "general" }, {
        approvalPolicy: preset.approvalPolicy,
        sandboxPolicy: preset.sandboxPolicy
      });
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
    if (area === "permissions" && action === "apply") {
      const [maybeScope, maybePreset] = rest;
      const scope = maybePreset ? maybeScope : "thread";
      const presetId = maybePreset ?? maybeScope;
      if ((scope !== "thread" && scope !== "root") || !isCodexPermissionPresetId(presetId)) {
        await this.answerCallbackQuery(event.callbackQueryId, {
          text: "Unsupported callback"
        });
        return;
      }

      const updated = await this.applyPermissionsSelection(
        { chatId: event.chatId, topicId: event.topicId },
        presetId,
        scope
      );
      await this.answerCallbackQuery(event.callbackQueryId, {
        text: updated ? "Permissions updated" : "Permissions not updated"
      });
      return;
    }

    if (area === "model" && action === "page") {
      const [maybeScope, maybePage] = rest;
      const scope = maybePage ? maybeScope : "thread";
      const page = Number.parseInt((maybePage ?? maybeScope) ?? "", 10);
      if (Number.isNaN(page)) {
        await this.answerCallbackQuery(event.callbackQueryId, {
          text: "Invalid model page"
        });
        return;
      }

      if (scope !== "thread" && scope !== "root") {
        await this.answerCallbackQuery(event.callbackQueryId, {
          text: "Invalid model page"
        });
        return;
      }

      const opened = await this.openModelSelection({ chatId: event.chatId, topicId: event.topicId }, page, scope);
      await this.answerCallbackQuery(
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
        await this.answerCallbackQuery(event.callbackQueryId, {
          text: "Invalid model selection"
        });
        return;
      }

      if (scope !== "thread" && scope !== "root") {
        await this.answerCallbackQuery(event.callbackQueryId, {
          text: "Invalid model selection"
        });
        return;
      }

      const opened = await this.openModelReasoningSelection(
        { chatId: event.chatId, topicId: event.topicId },
        modelIndex,
        scope
      );
      await this.answerCallbackQuery(
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
      if (scope !== "thread" && scope !== "root") {
        await this.answerCallbackQuery(event.callbackQueryId, {
          text: "Invalid reasoning selection"
        });
        return;
      }

      if (Number.isNaN(modelIndex) || !isReasoningEffort(reasoningEffort)) {
        await this.answerCallbackQuery(event.callbackQueryId, {
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
      await this.answerCallbackQuery(event.callbackQueryId, {
        text: updated ? "Model updated" : "Model not updated"
      });
      return;
    }

    await this.answerCallbackQuery(event.callbackQueryId, {
      text: "Unsupported callback"
    });
  }

  private async startSessionFromRootMessage(message: UserTurnMessage): Promise<void> {
    await this.runSessionProvisioning(message.chatId, null, async () => {
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        text: ROOT_SESSION_PROVISIONING_TEXT
      });
    }, async () => {
      const profileId = this.resolveConfiguredProfileId("general");
      const pending = await this.database.createProvisioningSession({
        telegramChatId: String(message.chatId),
        surface: { kind: "general" },
        profileId
      });

      try {
        const profileSettings = await this.readConfiguredProfileThreadStartSettings(profileId);
        const thread = await this.codex.createThread(profileId, DEFAULT_ROOT_SESSION_TITLE, {
          settings: toCodexThreadSettingsOverrideFromThreadStartSettings(profileSettings)
        });
        this.codex.registerThreadProfile(thread.threadId, profileId);
        await this.database.activateSession(pending.id, thread.threadId);
        let session = await this.database.getRootSessionByChat(message.chatId);
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
    });
  }

  private async startPlanSessionFromRootMessage(message: UserTurnMessage, promptText: string): Promise<void> {
    const trimmedPrompt = promptText.trim();
    const title = trimmedPrompt ? deriveTopicTitle(trimmedPrompt) : DEFAULT_NEW_PLAN_SESSION_TITLE;
    const forumTopic = await this.#messenger.createForumTopic({
      chatId: message.chatId,
      name: title,
      options: await this.#topicIconPicker.pickCreateForumTopicOptions()
    });
    await this.maybeSendTopicCreatedConfirmation(message, forumTopic.topicId);
    const topicMessage = {
      ...message,
      topicId: forumTopic.topicId
    };

    await this.startSessionInTopic(
      topicMessage,
      title,
      {
        profileId: this.resolveConfiguredProfileId("plan"),
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
    const forumTopic = await this.#messenger.createForumTopic({
      chatId: message.chatId,
      name: title,
      options: await this.#topicIconPicker.pickCreateForumTopicOptions()
    });
    await this.maybeSendTopicCreatedConfirmation(message, forumTopic.topicId);

    const topicMessage = {
      ...message,
      topicId: forumTopic.topicId
    };

    await this.startSessionInTopic(topicMessage, title, {
      profileId: this.resolveConfiguredProfileId("thread"),
      initialPromptText: trimmedPrompt,
      firstTurnMessage: replaceMessageText(topicMessage, trimmedPrompt)
    });
  }

  private async startSessionInExistingTopic(message: UserTurnMessage): Promise<void> {
    if (message.topicId === null) {
      throw new Error("Cannot start an in-topic session without a Telegram topic id");
    }

    const title = deriveTopicTitle(message.text);
    await this.startSessionInTopic(message, title, {
      profileId: this.resolveConfiguredProfileId("thread")
    });
  }

  private async startSessionInTopic(
    message: UserTurnMessage,
    title: string,
    options?: {
      profileId?: string;
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
    const profileId = options?.profileId ?? this.resolveConfiguredProfileId("thread");

    await this.runSessionProvisioning(message.chatId, topicId, async () => {
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        topicId,
        text: "This topic is still provisioning a Codex session. Try again in a moment"
      });
    }, async () => {
      const pending = await this.database.createProvisioningSession({
        telegramChatId: String(message.chatId),
        telegramTopicId: topicId,
        profileId
      });

      try {
        const profileSettings = await this.readConfiguredProfileThreadStartSettings(profileId);
        const thread = await this.codex.createThread(profileId, title, {
          ...(options?.threadCwd ? { cwd: options.threadCwd } : {}),
          settings: toCodexThreadSettingsOverrideFromThreadStartSettings(profileSettings)
        });
        this.codex.registerThreadProfile(thread.threadId, profileId);
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

        await this.maybeSendThreadStartFooterMessage(message.chatId, topicId, session.preferredMode, thread);
        await this.maybeSendInitialPromptMessage(message.chatId, topicId, options?.initialPromptText);

        if (options?.postActivationTopicMessage) {
          await this.sendScopedBridgeMessage({
            chatId: message.chatId,
            topicId,
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
          topicId,
          text: `Failed to create Codex session for "${title}": ${formatError(error)}`
        });
      }
    });
  }

  private async runSessionProvisioning(
    chatId: number,
    topicId: number | null,
    onAlreadyProvisioning: () => Promise<void>,
    task: () => Promise<void>
  ): Promise<void> {
    const key = `${chatId}:${topicId ?? "root"}`;
    if (this.#sessionProvisioningBySurface.has(key)) {
      await onAlreadyProvisioning();
      return;
    }

    let provisioning!: Promise<void>;
    provisioning = (async () => {
      try {
        await task();
      } finally {
        if (this.#sessionProvisioningBySurface.get(key) === provisioning) {
          this.#sessionProvisioningBySurface.delete(key);
        }
      }
    })();

    this.#sessionProvisioningBySurface.set(key, provisioning);
    await provisioning;
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

  private async maybeSendTopicCreatedConfirmation(message: UserTurnMessage, topicId: number): Promise<void> {
    try {
      const topicUrl = buildTelegramTopicUrl(message.chatId, topicId);
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        text: "Thread created",
        replyToMessageId: message.messageId,
        ...(topicUrl
          ? {
              replyMarkup: {
                inline_keyboard: [[{ text: "View", url: topicUrl }]]
              }
            }
          : {})
      });
    } catch (error) {
      this.logger.error("Failed to send root topic creation confirmation", error);
    }
  }

  private async readConfiguredProfileThreadStartSettings(profileId: string): Promise<ThreadStartSettings> {
    return this.codex.readProfileSettings(profileId);
  }

  private resolveConfiguredProfileId(route: keyof AppConfig["codex"]["routing"]): string {
    return this.config.codex.routing[route]!;
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
        settings: await this.resolveEffectiveThreadStartSettings(resolved.session)
      };
    }

    if (scope === "root") {
      const session = await this.database.getRootSessionByChat(message.chatId);
      if (!session?.codexThreadId) {
        await this.sendScopedBridgeMessage({
          chatId: message.chatId,
          text: COMPACT_COMMAND_REQUIRES_SESSION_TEXT
        });
        return null;
      }

      if (options?.rejectIfActiveTurn && this.findActiveTurnByTopic(message.chatId, null)) {
        await this.sendScopedBridgeMessage({
          chatId: message.chatId,
          text: SETTINGS_CHANGE_REJECTED_TEXT
        });
        return null;
      }

      return {
        scope: "root",
        session,
        settings: await this.resolveEffectiveThreadStartSettings(session)
      };
    }

    return null;
  }

  private resolveModelListProfileId(target: ThreadSettingsTarget): string {
    return target.session.profileId;
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
        scope: "root";
        session: BridgeSession;
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
      const session = await this.database.getRootSessionByChat(location.chatId);
      if (!session?.codexThreadId) {
        await this.sendScopedBridgeMessage({
          chatId: location.chatId,
          text: COMPACT_COMMAND_REQUIRES_SESSION_TEXT
        });
        return null;
      }

      if (options?.rejectIfActiveTurn && this.findActiveTurnByTopic(location.chatId, null)) {
        await this.sendScopedBridgeMessage({
          chatId: location.chatId,
          text: SETTINGS_CHANGE_REJECTED_TEXT
        });
        return null;
      }

      return {
        scope: "root",
        session,
        settings: await this.resolveEffectiveThreadStartSettings(session)
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
      settings: await this.resolveEffectiveThreadStartSettings(session)
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

    const effectiveSettings = await this.resolveEffectiveThreadStartSettings(session);
    const threadId = session.codexThreadId!;
    const turn = await this.submitPreparedInput(message, {
      submit: (input) =>
        this.withRegisteredPersistedThread(
          session,
          (registeredThreadId) => this.codex.sendTurn(
            registeredThreadId,
            input,
            {
              overrides: toCodexThreadSettingsOverrideFromThreadStartSettings(effectiveSettings),
              collaborationMode: buildTurnCollaborationMode(
                options?.forceMode ?? session.preferredMode,
                effectiveSettings,
                this.config.codex.developerInstructions ?? null,
                options?.forceMode === "default"
              )
            }
          )
        )
    });
    this.#turnsAwaitingActivation.add(turn.id);

    try {
      const activeTurn = this.#lifecycle.activateTurn(
        message,
        threadId,
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
        this.stageTurnEvent(turnId, event);
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

    const messageId = this.#compactionNoticeMessageIds.get(threadId);
    if (messageId !== undefined) {
      try {
        await this.editBridgeMessage({
          chatId: Number.parseInt(session.telegramChatId, 10),
          messageId,
          text: "Context compacted",
          coalesceKey: `compaction:${threadId}`,
          replacePending: true
        });
        return;
      } catch (error) {
        this.logger.warn("Failed to edit compaction notice", error);
      }
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

    try {
      await this.#restartKirbot(async (command) => {
        const runningMessage = buildRestartStepMessage(command);
        await this.sendScopedBridgeMessage({
          chatId: message.chatId,
          text: runningMessage.text,
          entities: runningMessage.entities
        });
      });
      await this.sendScopedBridgeMessage({
        chatId: message.chatId,
        text: RESTART_COMPLETED_TEXT
      });
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

  private async buildTopicCommandReplyMarkup(scope: SlashCommandScope): Promise<ReplyKeyboardMarkup | undefined> {
    return buildTopicCommandKeyboard(
      getVisibleSlashCommands(scope),
      await this.database.listCustomCommands()
    );
  }

  private async showCommandKeyboard(message: UserTurnMessage): Promise<void> {
    const replyMarkup = await this.buildTopicCommandReplyMarkup(message.topicId === null ? "general" : "topic");
    await this.sendScopedBridgeMessage({
      chatId: message.chatId,
      ...(message.topicId !== null ? { topicId: message.topicId } : {}),
      text: COMMANDS_KEYBOARD_TEXT,
      ...(replyMarkup ? { replyMarkup } : {})
    });
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
    return this.#messenger.sendMessage({
      ...input,
      ...(input.replyMarkup ? { replyMarkup: input.replyMarkup } : {})
    });
  }

  private async answerCallbackQuery(callbackQueryId: string, options?: { text?: string }): Promise<true> {
    return this.#messenger.answerCallbackQuery(callbackQueryId, options);
  }

  private async editBridgeMessage(input: {
    chatId: number;
    messageId: number;
    text: string;
    entities?: MessageEntity[];
    replyMarkup?: InlineKeyboardMarkup;
    deliveryClass?: TelegramDeliveryClass;
    coalesceKey?: string;
    replacePending?: boolean;
  }): Promise<unknown> {
    return this.#messenger.editMessageText(input);
  }

  private async resolveTurnSnapshot(threadId: string, turnId: string): Promise<ResolvedTurnSnapshot> {
    const streamedAssistantText = this.#lifecycle.renderAssistantItems(turnId);
    const streamedPlanText = this.#lifecycle.renderPlanItems(turnId);
    const snapshot = await this.withRegisteredPersistedThread(
      threadId,
      (registeredThreadId) => this.codex.readTurnSnapshot(registeredThreadId, turnId)
    );
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
    const key = topicKey(queueState.chatId, queueState.topicId);
    const activeTurn = this.findActiveTurnByTopic(queueState.chatId, queueState.topicId);
    this.#queuePreviewDesiredState.set(key, {
      chatId: queueState.chatId,
      topicId: queueState.topicId,
      previewText: renderQueuePreview(queueState),
      replyMarkup: buildQueuePreviewKeyboard(
        queueState,
        activeTurn?.turnId ?? null,
        activeTurn?.stopRequested ?? false
      ) ?? null
    });

    const existingSync = this.#queuePreviewSyncs.get(key);
    if (existingSync) {
      await existingSync;
      return;
    }

    const sync = this.#drainQueuePreview(key).finally(() => {
      this.#queuePreviewSyncs.delete(key);
    });
    this.#queuePreviewSyncs.set(key, sync);
    await sync;
  }

  async #drainQueuePreview(key: string): Promise<void> {
    while (true) {
      const desired = this.#queuePreviewDesiredState.get(key);
      if (!desired) {
        return;
      }

      this.#queuePreviewDesiredState.delete(key);

      const existingMessageId = this.#queuePreviewMessageIds.get(key) ?? null;
      if (!desired.previewText) {
        if (existingMessageId !== null) {
          this.#messenger.cancelPendingDelivery("visible_edit", `queue-preview:${desired.chatId}:${existingMessageId}`);
          this.#queuePreviewMessageIds.delete(key);
          this.#scheduleQueuePreviewDelete(desired.chatId, existingMessageId);
        }

        if (!this.#queuePreviewDesiredState.has(key)) {
          return;
        }
        continue;
      }

      if (existingMessageId !== null) {
        try {
          await this.editBridgeMessage({
            chatId: desired.chatId,
            messageId: existingMessageId,
            text: desired.previewText,
            ...(desired.replyMarkup ? { replyMarkup: desired.replyMarkup } : {}),
            coalesceKey: `queue-preview:${desired.chatId}:${existingMessageId}`,
            replacePending: true
          });
        } catch {
          this.#queuePreviewMessageIds.delete(key);
          continue;
        }
      } else {
        const message = await this.#messenger.sendMessage({
          chatId: desired.chatId,
          topicId: desired.topicId,
          text: desired.previewText,
          ...(desired.replyMarkup ? { replyMarkup: desired.replyMarkup } : {})
        });
        this.#queuePreviewMessageIds.set(key, message.messageId);
      }

      if (!this.#queuePreviewDesiredState.has(key)) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  #scheduleQueuePreviewDelete(chatId: number, messageId: number): void {
    setTimeout(() => {
      void this.#messenger.deleteMessage(chatId, messageId).catch(() => {
        // Ignore preview cleanup failures.
      });
    }, 25).unref?.();
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

  private async withRegisteredPersistedThread<T>(
    sessionOrThreadId: TopicSession | BridgeSession | string,
    operation: (threadId: string) => Promise<T>
  ): Promise<T> {
    const session =
      typeof sessionOrThreadId === "string"
        ? await this.database.getSessionByCodexThreadId(sessionOrThreadId)
        : sessionOrThreadId;
    const threadId =
      typeof sessionOrThreadId === "string"
        ? sessionOrThreadId
        : sessionOrThreadId.codexThreadId;

    if (!threadId) {
      throw new Error("Cannot operate on a persisted session without a Codex thread id");
    }

    try {
      if (session?.codexThreadId) {
        if (!Object.hasOwn(this.config.codex.profiles, session.profileId)) {
          throw new UnavailableCodexSessionError();
        }

        this.codex.registerThreadProfile(session.codexThreadId, session.profileId);
      }

      return await operation(threadId);
    } catch (error) {
      if (session && (this.isUnavailableCodexThreadError(error) || this.isUnavailableCodexSessionError(error))) {
        throw new UnavailableCodexSessionError();
      }

      throw error;
    }
  }

  private async resolveEffectiveThreadStartSettings(session: TopicSession | BridgeSession): Promise<ThreadStartSettings> {
    const [profileSettings, loaded] = await Promise.all([
      this.readConfiguredProfileThreadStartSettings(session.profileId),
      this.withRegisteredPersistedThread(
        session,
        (threadId) => this.codex.ensureThreadLoaded(threadId)
      )
    ]);
    return {
      ...mergePersistedThreadSettingsIntoThreadStartSettings(profileSettings, session.settings),
      cwd: loaded.cwd
    };
  }

  private async resolveSessionThreadStartSettingsFromOverrides(
    session: TopicSession | BridgeSession,
    settings: PersistedThreadSettings
  ): Promise<ThreadStartSettings> {
    const [profileSettings, loaded] = await Promise.all([
      this.readConfiguredProfileThreadStartSettings(session.profileId),
      this.withRegisteredPersistedThread(
        session,
        (threadId) => this.codex.ensureThreadLoaded(threadId)
      )
    ]);
    return {
      ...mergePersistedThreadSettingsIntoThreadStartSettings(profileSettings, settings),
      cwd: loaded.cwd
    };
  }

  private async updateSessionSettingsForSurface(
    chatId: number,
    surface: SessionSurface,
    update: CodexThreadSettingsOverride
  ): Promise<ThreadStartSettings> {
    const session =
      surface.kind === "general"
        ? await this.database.getRootSessionByChat(chatId)
        : await this.database.getSessionByTopic(chatId, surface.topicId);
    if (!session) {
      throw new Error("Session not found");
    }

    const merged = mergePersistedThreadSettings(session.settings, update);
    const updated =
      surface.kind === "general"
        ? await this.database.updateRootSessionSettings(chatId, merged)
        : await this.database.updateTopicSessionSettings(chatId, surface.topicId, merged);
    const nextSession = updated ?? { ...session, settings: merged };
    return this.resolveSessionThreadStartSettingsFromOverrides(nextSession, merged);
  }

  private isUnavailableCodexThreadError(error: unknown): boolean {
    const normalizedMessage = (error instanceof Error ? error.message : String(error)).toLowerCase();
    if (
      normalizedMessage.includes("thread not found") ||
      normalizedMessage.includes("unknown thread") ||
      normalizedMessage.includes("no such thread")
    ) {
      return true;
    }

    if (!isRecord(error) || error.constructor?.name !== "JsonRpcMethodError") {
      return false;
    }

    const data = isRecord(error.data) ? error.data : null;
    const kind = typeof data?.kind === "string" ? data.kind.toLowerCase() : "";
    return (
      kind.includes("thread_not_found") ||
      kind.includes("thread-not-found") ||
      kind.includes("missing_thread")
    );
  }

  private isUnavailableCodexSessionError(error: unknown): error is UnavailableCodexSessionError {
    return error instanceof UnavailableCodexSessionError;
  }

}

function buildTelegramTopicUrl(chatId: number, topicId: number): string | null {
  const chatIdText = String(chatId);
  if (!chatIdText.startsWith("-100") || chatIdText.length <= 4) {
    return null;
  }

  return `https://t.me/c/${chatIdText.slice(4)}/${topicId}`;
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
    ...(event.telegramUsername ? { telegramUsername: event.telegramUsername } : {}),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function buildFastStatusMessage(scope: SettingsSelectionScope, serviceTier: ServiceTier | null): string {
  return scope === "root"
    ? `Fast mode is ${serviceTier === "fast" ? "on" : "off"} for the General thread`
    : `Fast mode is ${serviceTier === "fast" ? "on" : "off"} for this thread`;
}

function buildFastUpdatedMessage(scope: SettingsSelectionScope, serviceTier: ServiceTier | null): string {
  return scope === "root"
    ? `General thread fast mode ${serviceTier === "fast" ? "enabled" : "disabled"}`
    : `Thread fast mode ${serviceTier === "fast" ? "enabled" : "disabled"}`;
}

function describeModelSelectionTitle(scope: SettingsSelectionScope): string {
  switch (scope) {
    case "thread":
      return "Choose the model for this thread";
    case "root":
      return "Choose the model for the General thread";
  }
}

function buildRestartStepMessage(command: string): { text: string; entities: MessageEntity[] } {
  return {
    text: `Running: ${command}`,
    entities: [
      {
        type: "code",
        offset: "Running: ".length,
        length: command.length
      }
    ]
  };
}

function describePermissionsSelectionTitle(scope: SettingsSelectionScope): string {
  switch (scope) {
    case "thread":
      return "Choose Codex permissions for this thread";
    case "root":
      return "Choose Codex permissions for the General thread";
  }
}

function describePermissionsSelectionScope(scope: SettingsSelectionScope): string {
  switch (scope) {
    case "thread":
      return "Your selection will apply only to this topic";
    case "root":
      return "Your selection will apply to the General thread";
  }
}

function buildModelUpdatedMessage(scope: SettingsSelectionScope, model: string, reasoningEffort: ReasoningEffort): string {
  switch (scope) {
    case "thread":
      return `Thread model set to ${model} ${reasoningEffort}`;
    case "root":
      return `General thread model set to ${model} ${reasoningEffort}`;
  }
}

function buildPermissionsUpdatedMessage(scope: SettingsSelectionScope, label: string): string {
  switch (scope) {
    case "thread":
      return `Thread permissions set to ${label}`;
    case "root":
      return `General thread permissions set to ${label}`;
  }
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

function toCodexThreadSettingsOverrideFromThreadStartSettings(
  settings: Pick<ThreadStartSettings, "model" | "reasoningEffort" | "serviceTier" | "approvalPolicy" | "sandboxPolicy">
): CodexThreadSettingsOverride {
  const model = normalizePersistedModel(settings.model);

  return {
    ...(model ? { model } : {}),
    ...(settings.reasoningEffort !== null ? { reasoningEffort: settings.reasoningEffort } : {}),
    ...(settings.serviceTier !== null ? { serviceTier: settings.serviceTier } : {}),
    ...(settings.approvalPolicy ? { approvalPolicy: settings.approvalPolicy } : {}),
    ...(settings.sandboxPolicy ? { sandboxPolicy: settings.sandboxPolicy } : {})
  };
}

function normalizePersistedModel(model: string | null): string | null {
  if (!model || model === "unknown-model") {
    return null;
  }

  return model;
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

function isRootBridgeSession(session: TopicSession | BridgeSession): session is BridgeSession & { surface: { kind: "general" } } {
  return "surface" in session && session.surface.kind === "general";
}

function mergePersistedThreadSettingsIntoThreadStartSettings(
  fallback: Pick<ThreadStartSettings, "model" | "reasoningEffort" | "serviceTier" | "approvalPolicy" | "sandboxPolicy">,
  settings: PersistedThreadSettings
): Pick<ThreadStartSettings, "model" | "reasoningEffort" | "serviceTier" | "approvalPolicy" | "sandboxPolicy"> {
  return {
    model: settings.model ?? fallback.model,
    reasoningEffort: settings.reasoningEffort ?? fallback.reasoningEffort,
    serviceTier: settings.serviceTier ?? fallback.serviceTier,
    approvalPolicy: settings.approvalPolicy ?? fallback.approvalPolicy,
    sandboxPolicy: settings.sandboxPolicy ?? fallback.sandboxPolicy
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
