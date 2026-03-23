import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageEntity } from "grammy/types";

import { TelegramCodexBridge, type BridgeCodexApi } from "../src/bridge";
import type { AppConfig } from "../src/config";
import { BridgeDatabase } from "../src/db";
import type { UserInput } from "@kirbot/codex-client/generated/codex/v2/UserInput";
import { TemporaryImageStore } from "../src/media-store";
import type { ServerNotification } from "@kirbot/codex-client/generated/codex/ServerNotification";
import type { ServerRequest } from "@kirbot/codex-client/generated/codex/ServerRequest";
import type { CommandExecutionApprovalDecision } from "@kirbot/codex-client/generated/codex/v2/CommandExecutionApprovalDecision";
import type { FileChangeApprovalDecision } from "@kirbot/codex-client/generated/codex/v2/FileChangeApprovalDecision";
import type { Model } from "@kirbot/codex-client/generated/codex/v2/Model";
import type { PermissionsRequestApprovalResponse } from "@kirbot/codex-client/generated/codex/v2/PermissionsRequestApprovalResponse";
import type { SandboxPolicy } from "@kirbot/codex-client/generated/codex/v2/SandboxPolicy";
import type { ToolRequestUserInputResponse } from "@kirbot/codex-client/generated/codex/v2/ToolRequestUserInputResponse";
import type { AskForApproval } from "@kirbot/codex-client/generated/codex/v2/AskForApproval";
import type { ReasoningEffort } from "@kirbot/codex-client/generated/codex/ReasoningEffort";
import type { ServiceTier } from "@kirbot/codex-client/generated/codex/ServiceTier";
import { JsonRpcMethodError, type AppServerEvent, type ResolvedTurnSnapshot } from "@kirbot/codex-client";
import {
  TELEGRAM_FORUM_TOPIC_ICON_COLORS,
  TelegramMessenger,
  type TelegramEditOptions,
  type TelegramApi,
  type TelegramCreateForumTopicOptions,
  type TelegramSendOptions
} from "../src/telegram-messenger";
import { BridgeRequestCoordinator } from "../src/bridge/request-coordinator";
import { decodeMiniAppArtifact, getEncodedMiniAppArtifactFromHash, MiniAppArtifactType } from "../src/mini-app/url";
import {
  buildArtifactReplyMarkup,
  buildCommentaryArtifactButton,
  buildResponseArtifactButton,
  TOPIC_IMPLEMENT_CALLBACK_DATA
} from "../src/bridge/presentation";
import { isAllowedSlashCommandInScope } from "../src/bridge/slash-commands";
import { createInitialUserInputState, stringifyUserInputState } from "../src/bridge/requests";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function longText(paragraph: string, count: number): string {
  return Array.from({ length: count }, () => paragraph).join("\n\n");
}

function preformattedEntities(text: string, language?: string): MessageEntity[] {
  return [
    {
      type: "pre",
      offset: 0,
      length: text.length,
      ...(language ? { language } : {})
    }
  ];
}

function getInlineButtonTexts(message: { options?: TelegramSendOptions } | undefined): string[] {
  const replyMarkup = (message?.options as { reply_markup?: { inline_keyboard?: Array<Array<{ text?: string }>> }; replyMarkup?: { inline_keyboard?: Array<Array<{ text?: string }>> } } | undefined)?.reply_markup
    ?? (message?.options as { reply_markup?: { inline_keyboard?: Array<Array<{ text?: string }>> }; replyMarkup?: { inline_keyboard?: Array<Array<{ text?: string }>> } } | undefined)?.replyMarkup;
  return (
    (replyMarkup as { inline_keyboard?: Array<Array<{ text?: string }>> } | undefined)?.inline_keyboard
      ?.flat()
      .map((button) => button.text)
      .filter((text): text is string => typeof text === "string") ?? []
  );
}

function getReplyKeyboardRows(message: { options?: TelegramSendOptions } | undefined): string[][] {
  return (
    ((message?.options?.reply_markup as { keyboard?: Array<Array<string>> } | undefined)?.keyboard?.map((row) => [...row])) ?? []
  );
}

function buildRunningMessage(command: string): { text: string; entities: MessageEntity[] } {
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

function getWebAppUrlByButtonText(
  message: { options?: TelegramSendOptions } | undefined,
  buttonText: string
): string | null {
  const replyMarkup = (message?.options as { reply_markup?: { inline_keyboard?: Array<Array<{ text?: string; web_app?: { url?: string } }>> }; replyMarkup?: { inline_keyboard?: Array<Array<{ text?: string; web_app?: { url?: string } }>> } } | undefined)?.reply_markup
    ?? (message?.options as { reply_markup?: { inline_keyboard?: Array<Array<{ text?: string; web_app?: { url?: string } }>> }; replyMarkup?: { inline_keyboard?: Array<Array<{ text?: string; web_app?: { url?: string } }>> } } | undefined)?.replyMarkup;
  return (
    ((replyMarkup as {
      inline_keyboard?: Array<Array<{ text?: string; web_app?: { url?: string } }>>;
    } | undefined)
      ?.inline_keyboard?.flat()
      .find((button) => button.text === buttonText)
      ?.web_app?.url ?? null)
  );
}

function getCallbackDataByButtonText(
  message: { options?: TelegramSendOptions } | undefined,
  buttonText: string
): string | null {
  const replyMarkup = (message?.options as { reply_markup?: { inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>> }; replyMarkup?: { inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>> } } | undefined)?.reply_markup
    ?? (message?.options as { reply_markup?: { inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>> }; replyMarkup?: { inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>> } } | undefined)?.replyMarkup;
  return (
    ((replyMarkup as {
      inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>>;
    } | undefined)
      ?.inline_keyboard?.flat()
      .find((button) => button.text === buttonText)
      ?.callback_data ?? null)
  );
}

function getFinalAnswerMessage(telegram: FakeTelegram) {
  const messages = telegram.drafts.length > 0 ? telegram.drafts : telegram.sentMessages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = messages[index]?.text ?? "";
    if (text === "> done") {
      continue;
    }

    if (text.includes(" • ") && text.includes("% left")) {
      continue;
    }

    return messages[index];
  }

  return undefined;
}

function isStreamingStatusText(text: string): boolean {
  return /^(thinking|planning|using tool|running|editing|searching|failed|interrupted)(?: · .*)?$/.test(text);
}

function findSingleButtonSafeDualButtonUnsafeMiniAppUrl(): string {
  for (let repeatCount = 300; repeatCount <= 1_500; repeatCount += 25) {
    const publicUrl = `https://example.com/${"mini-app/".repeat(repeatCount)}`;
    const responseButton = buildResponseArtifactButton(publicUrl, "Final answer");
    const commentaryButton = buildCommentaryArtifactButton(publicUrl, [{ kind: "commentary", text: "Inspecting files" }]);

    try {
      buildArtifactReplyMarkup([responseButton]);
      buildArtifactReplyMarkup([commentaryButton]);
    } catch {
      continue;
    }

    try {
      buildArtifactReplyMarkup([responseButton, commentaryButton]);
    } catch (error) {
      if (error instanceof Error && error.message === "mini_app_artifact_too_large") {
        return publicUrl;
      }
    }
  }

  throw new Error("Failed to find a Mini App URL that fits single buttons but not combined buttons");
}

async function waitForAsyncNotifications(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Timed out waiting for condition");
}

function rateLimitError(retryAfterSeconds: number): Error & {
  error_code: number;
  parameters: {
    retry_after: number;
  };
} {
  const error = new Error("Too Many Requests") as Error & {
    error_code: number;
    parameters: {
      retry_after: number;
    };
  };
  error.error_code = 429;
  error.parameters = {
    retry_after: retryAfterSeconds
  };
  return error;
}

const ZERO_SPACING_DELIVERY_POLICY = {
  callbackAnswerSpacingMs: 0,
  visibleSendSpacingMs: 0,
  topicCreateSpacingMs: 0,
  visibleEditSpacingMs: 0,
  chatActionSpacingMs: 0,
  deleteSpacingMs: 0
} as const;

class FakeCodex implements BridgeCodexApi {
  createdThreads: string[] = [];
  readThreadCalls: string[] = [];
  createThreadCalls: Array<{
    title: string;
    cwd?: string | null;
    settings?: {
      model?: string;
      reasoningEffort?: ReasoningEffort | null;
      serviceTier?: ServiceTier | null;
      approvalPolicy?: AskForApproval;
      sandboxPolicy?: SandboxPolicy;
    } | null;
  }> = [];
  ensuredThreads: string[] = [];
  globalSettingsUpdates: Array<{
    model?: string;
    reasoningEffort?: ReasoningEffort | null;
    serviceTier?: ServiceTier | null;
    approvalPolicy?: AskForApproval;
    sandboxPolicy?: SandboxPolicy;
  }> = [];
  compactThreadCalls: Array<{ threadId: string }> = [];
  threadSettingsUpdates: Array<{
    threadId: string;
    model?: string;
    reasoningEffort?: ReasoningEffort | null;
    serviceTier?: ServiceTier | null;
    approvalPolicy?: AskForApproval;
    sandboxPolicy?: SandboxPolicy;
  }> = [];
  turns: Array<{ threadId: string; text: string; input: UserInput[]; turnId: string }> = [];
  turnCollaborationModes: Array<{ turnId: string; collaborationMode: unknown | null }> = [];
  turnOverrides: Array<{ turnId: string; overrides: unknown | null }> = [];
  steerCalls: Array<{ threadId: string; expectedTurnId: string; text: string; input: UserInput[] }> = [];
  interruptCalls: Array<{ threadId: string; turnId: string }> = [];
  commandApprovals: Array<{ id: string | number; decision: CommandExecutionApprovalDecision }> = [];
  fileApprovals: Array<{ id: string | number; decision: FileChangeApprovalDecision }> = [];
  permissionsApprovals: Array<{ id: string | number; response: PermissionsRequestApprovalResponse }> = [];
  userInputs: Array<{ id: string | number; answers: ToolRequestUserInputResponse["answers"] }> = [];
  unsupported: Array<{ id: string | number; message: string }> = [];
  readTurnMessagesResult = "";
  readTurnSnapshotResult: Partial<ResolvedTurnSnapshot> = {};
  cwd = "/workspace";
  branch: string | null = "main";
  model = "gpt-5-codex";
  reasoningEffort: ReasoningEffort | null = null;
  serviceTier: ServiceTier | null = null;
  approvalPolicy: AskForApproval = "on-request";
  sandboxPolicy: SandboxPolicy = {
    type: "workspaceWrite",
    writableRoots: [],
    readOnlyAccess: {
      type: "fullAccess"
    },
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  };
  threadModel: string | undefined = undefined;
  threadReasoningEffort: ReasoningEffort | null | undefined = undefined;
  threadServiceTier: ServiceTier | null | undefined = undefined;
  threadApprovalPolicy: AskForApproval | undefined = undefined;
  threadSandboxPolicy: SandboxPolicy | undefined = undefined;
  threadCwd: string | undefined = undefined;
  threadName: string | undefined = undefined;
  #nextThreadId = 1;
  models: Model[] = [
    {
      id: "model-1",
      model: "gpt-5-codex",
      upgrade: null,
      upgradeInfo: null,
      availabilityNux: null,
      displayName: "gpt-5-codex",
      description: "Default coding model",
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Faster responses" },
        { reasoningEffort: "medium", description: "Balanced reasoning" },
        { reasoningEffort: "high", description: "Deeper reasoning" }
      ],
      defaultReasoningEffort: "medium",
      inputModalities: [],
      supportsPersonality: false,
      isDefault: true
    }
  ];
  nextSendTurnError: Error | null = null;
  nextSteerError: Error | null = null;
  nextInterruptError: Error | null = null;
  beforeSendTurnResolve:
    | ((input: { threadId: string; turnId: string; input: UserInput[] }) => Promise<void> | void)
    | null = null;

  readonly #eventQueue: AppServerEvent[] = [];
  readonly #eventWaiters: Array<(event: AppServerEvent | null) => void> = [];

  async createThread(optionsTitle: string, options?: {
    cwd?: string | null;
    settings?: {
      model?: string;
      reasoningEffort?: ReasoningEffort | null;
      serviceTier?: ServiceTier | null;
      approvalPolicy?: AskForApproval;
      sandboxPolicy?: SandboxPolicy;
    } | null;
  }): Promise<{
    threadId: string;
    branch: string | null;
    model: string;
    reasoningEffort: ReasoningEffort | null;
    serviceTier: ServiceTier | null;
    cwd: string;
    approvalPolicy: AskForApproval;
    sandboxPolicy: SandboxPolicy;
  }> {
    this.createdThreads.push(optionsTitle);
    this.createThreadCalls.push({
      title: optionsTitle,
      ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options?.settings !== undefined ? { settings: options.settings } : {})
    });
    const threadId = `thread-${this.#nextThreadId++}`;
    const initialSettings = options?.settings ?? {
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      serviceTier: this.serviceTier,
      approvalPolicy: this.approvalPolicy,
      sandboxPolicy: this.sandboxPolicy
    };
    this.threadModel = initialSettings.model;
    this.threadReasoningEffort = initialSettings.reasoningEffort ?? null;
    this.threadServiceTier = initialSettings.serviceTier ?? null;
    this.threadApprovalPolicy = initialSettings.approvalPolicy;
    this.threadSandboxPolicy = initialSettings.sandboxPolicy;
    this.threadCwd = options?.cwd ?? this.cwd;
    this.threadName = optionsTitle;
    return {
      threadId,
      branch: this.branch,
      model: this.threadModel ?? this.model,
      reasoningEffort: this.threadReasoningEffort === undefined ? this.reasoningEffort : this.threadReasoningEffort,
      serviceTier: this.threadServiceTier === undefined ? this.serviceTier : this.threadServiceTier,
      cwd: this.threadCwd,
      approvalPolicy: this.threadApprovalPolicy ?? this.approvalPolicy,
      sandboxPolicy: this.threadSandboxPolicy ?? this.sandboxPolicy
    };
  }

  async readThread(threadId: string): Promise<{
    name: string | null;
    cwd: string;
  }> {
    this.readThreadCalls.push(threadId);
    return {
      name: this.threadName ?? null,
      cwd: this.threadCwd ?? this.cwd
    };
  }

  async readGlobalSettings(): Promise<{
    model: string;
    reasoningEffort: ReasoningEffort | null;
    serviceTier: ServiceTier | null;
    cwd: string;
    approvalPolicy: AskForApproval;
    sandboxPolicy: SandboxPolicy;
  }> {
    return {
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      serviceTier: this.serviceTier,
      cwd: this.cwd,
      approvalPolicy: this.approvalPolicy,
      sandboxPolicy: this.sandboxPolicy
    };
  }

  async updateGlobalSettings(update: {
    model?: string;
    reasoningEffort?: ReasoningEffort | null;
    serviceTier?: ServiceTier | null;
    approvalPolicy?: AskForApproval;
    sandboxPolicy?: SandboxPolicy;
  }): Promise<{
    model: string;
    reasoningEffort: ReasoningEffort | null;
    serviceTier: ServiceTier | null;
    cwd: string;
    approvalPolicy: AskForApproval;
    sandboxPolicy: SandboxPolicy;
  }> {
    this.globalSettingsUpdates.push(update);
    if (update.model) {
      this.model = update.model;
    }
    if ("reasoningEffort" in update) {
      this.reasoningEffort = update.reasoningEffort ?? null;
    }
    if ("serviceTier" in update) {
      this.serviceTier = update.serviceTier ?? null;
    }
    if (update.approvalPolicy) {
      this.approvalPolicy = update.approvalPolicy;
    }
    if (update.sandboxPolicy) {
      this.sandboxPolicy = update.sandboxPolicy;
    }

    return this.readGlobalSettings();
  }

  async ensureThreadLoaded(threadId: string): Promise<{
    model: string;
    reasoningEffort: ReasoningEffort | null;
    serviceTier: ServiceTier | null;
    cwd: string;
    approvalPolicy: AskForApproval;
    sandboxPolicy: SandboxPolicy;
  }> {
    this.ensuredThreads.push(threadId);
    return {
      model: this.threadModel ?? this.model,
      reasoningEffort: this.threadReasoningEffort === undefined ? this.reasoningEffort : this.threadReasoningEffort,
      serviceTier: this.threadServiceTier === undefined ? this.serviceTier : this.threadServiceTier,
      cwd: this.threadCwd ?? this.cwd,
      approvalPolicy: this.threadApprovalPolicy ?? this.approvalPolicy,
      sandboxPolicy: this.threadSandboxPolicy ?? this.sandboxPolicy
    };
  }

  async compactThread(threadId: string): Promise<void> {
    this.compactThreadCalls.push({ threadId });
  }

  async updateThreadSettings(threadId: string, update: {
    model?: string;
    reasoningEffort?: ReasoningEffort | null;
    serviceTier?: ServiceTier | null;
    approvalPolicy?: AskForApproval;
    sandboxPolicy?: SandboxPolicy;
  }): Promise<{
    model: string;
    reasoningEffort: ReasoningEffort | null;
    serviceTier: ServiceTier | null;
    cwd: string;
    approvalPolicy: AskForApproval;
    sandboxPolicy: SandboxPolicy;
  }> {
    this.threadSettingsUpdates.push({
      threadId,
      ...update
    });
    if (update.model) {
      this.threadModel = update.model;
    }
    if ("reasoningEffort" in update) {
      this.threadReasoningEffort = update.reasoningEffort ?? null;
    }
    if ("serviceTier" in update) {
      this.threadServiceTier = update.serviceTier ?? null;
    }
    if (update.approvalPolicy) {
      this.threadApprovalPolicy = update.approvalPolicy;
    }
    if (update.sandboxPolicy) {
      this.threadSandboxPolicy = update.sandboxPolicy;
    }

    return this.ensureThreadLoaded(threadId);
  }

  async sendTurn(
    threadId: string,
    input: UserInput[],
    options?: {
      collaborationMode?: unknown | null;
      overrides?: {
        model?: string;
        reasoningEffort?: ReasoningEffort | null;
        serviceTier?: ServiceTier | null;
        approvalPolicy?: AskForApproval;
        sandboxPolicy?: SandboxPolicy;
      } | null;
    }
  ): Promise<{ id: string }> {
    if (this.nextSendTurnError) {
      const error = this.nextSendTurnError;
      this.nextSendTurnError = null;
      throw error;
    }

    const turnId = `turn-${this.turns.length + 1}`;
    const turn = { threadId, text: flattenTextInput(input), turnId } as {
      threadId: string;
      text: string;
      input: UserInput[];
      turnId: string;
    };
    Object.defineProperty(turn, "input", {
      value: input,
      enumerable: false,
      configurable: true,
      writable: true
    });
    this.turns.push(turn);
    this.turnCollaborationModes.push({
      turnId,
      collaborationMode: options?.collaborationMode ?? null
    });
    this.turnOverrides.push({
      turnId,
      overrides: options?.overrides ?? null
    });
    if (options?.overrides?.model) {
      this.threadModel = options.overrides.model;
    }
    if ("reasoningEffort" in (options?.overrides ?? {})) {
      this.threadReasoningEffort = options?.overrides?.reasoningEffort ?? null;
    }
    if ("serviceTier" in (options?.overrides ?? {})) {
      this.threadServiceTier = options?.overrides?.serviceTier ?? null;
    }
    if (options?.overrides?.approvalPolicy) {
      this.threadApprovalPolicy = options.overrides.approvalPolicy;
    }
    if (options?.overrides?.sandboxPolicy) {
      this.threadSandboxPolicy = options.overrides.sandboxPolicy;
    }
    await this.beforeSendTurnResolve?.({
      threadId,
      turnId,
      input
    });
    return { id: turnId };
  }

  async steerTurn(threadId: string, expectedTurnId: string, input: UserInput[]): Promise<{ turnId: string }> {
    const steerCall = { threadId, expectedTurnId, text: flattenTextInput(input) } as {
      threadId: string;
      expectedTurnId: string;
      text: string;
      input: UserInput[];
    };
    Object.defineProperty(steerCall, "input", {
      value: input,
      enumerable: false,
      configurable: true,
      writable: true
    });
    this.steerCalls.push(steerCall);
    if (this.nextSteerError) {
      const error = this.nextSteerError;
      this.nextSteerError = null;
      throw error;
    }

    return { turnId: expectedTurnId };
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.interruptCalls.push({ threadId, turnId });
    if (this.nextInterruptError) {
      const error = this.nextInterruptError;
      this.nextInterruptError = null;
      throw error;
    }
  }

  async archiveThread(): Promise<void> {}

  async readTurnSnapshot(): Promise<ResolvedTurnSnapshot> {
    return {
      text: this.readTurnMessagesResult,
      assistantText: this.readTurnMessagesResult,
      planText: "",
      changedFiles: 0,
      cwd: "/workspace",
      branch: "main",
      ...this.readTurnSnapshotResult
    };
  }

  async respondToCommandApproval(
    id: string | number,
    response: { decision: CommandExecutionApprovalDecision }
  ): Promise<void> {
    this.commandApprovals.push({ id, decision: response.decision });
  }

  async respondToFileChangeApproval(
    id: string | number,
    response: { decision: FileChangeApprovalDecision }
  ): Promise<void> {
    this.fileApprovals.push({ id, decision: response.decision });
  }

  async respondToPermissionsApproval(
    id: string | number,
    response: PermissionsRequestApprovalResponse
  ): Promise<void> {
    this.permissionsApprovals.push({ id, response });
  }

  async respondToUserInputRequest(
    id: string | number,
    response: ToolRequestUserInputResponse
  ): Promise<void> {
    this.userInputs.push({ id, answers: response.answers });
  }

  async respondUnsupportedRequest(id: string | number, message: string): Promise<void> {
    this.unsupported.push({ id, message });
  }

  async nextEvent(): Promise<AppServerEvent | null> {
    const event = this.#eventQueue.shift();
    if (event) {
      return event;
    }

    return new Promise<AppServerEvent | null>((resolve) => {
      this.#eventWaiters.push(resolve);
    });
  }

  emitNotification(notification: ServerNotification): void {
    this.emitEvent({
      kind: "notification",
      notification
    });
  }

  emitRequest(request: ServerRequest): void {
    this.emitEvent({
      kind: "serverRequest",
      request
    });
  }

  async listModels(): Promise<Model[]> {
    return this.models;
  }

  private emitEvent(event: AppServerEvent): void {
    const waiter = this.#eventWaiters.shift();
    if (waiter) {
      waiter(event);
      return;
    }

    this.#eventQueue.push(event);
  }
}

class FakeTelegram implements TelegramApi {
  topicCounter = 100;
  messageCounter = 500;
  nextCreateForumTopicError: Error | null = null;
  nextChatActionError: Error | null = null;
  nextDraftError: Error | null = null;
  nextSendMessageError: Error | null = null;
  nextEditMessageTextError: Error | null = null;
  nextDeleteMessageError: Error | null = null;
  nextAnswerCallbackQueryError: Error | null = null;
  draftBlocks: Array<Promise<void>> = [];
  editBlocks: Array<Promise<void>> = [];
  deleteBlocks: Array<Promise<void>> = [];
  events: string[] = [];
  chatActions: Array<{
    chatId: number;
    action: "typing" | "upload_document";
    options?: { message_thread_id?: number };
  }> = [];
  topicIconStickers: Array<{ custom_emoji_id?: string }> = [];
  nextGetForumTopicIconStickersError: Error | null = null;
  createdTopics: Array<{ chatId: number; name: string; options?: TelegramCreateForumTopicOptions }> = [];
  sentMessages: Array<{
    messageId: number;
    chatId: number;
    text: string;
    options?: TelegramSendOptions;
  }> = [];
  drafts: Array<{
    chatId: number;
    draftId: number;
    text: string;
    options?: TelegramSendOptions | TelegramEditOptions;
  }> = [];
  appliedDrafts: Array<{
    chatId: number;
    draftId: number;
    text: string;
    options?: TelegramSendOptions | TelegramEditOptions;
  }> = [];
  edits: Array<{ chatId: number; messageId: number; text: string }> = [];
  editOptions: Array<{
    chatId: number;
    messageId: number;
    options?: TelegramSendOptions;
  }> = [];
  callbackAnswers: Array<{ callbackQueryId: string; options?: { text?: string } }> = [];
  deletions: Array<{ chatId: number; messageId: number }> = [];
  downloads: Array<{ fileId: string }> = [];

  async getForumTopicIconStickers(): Promise<Array<{ custom_emoji_id?: string }>> {
    if (this.nextGetForumTopicIconStickersError) {
      const error = this.nextGetForumTopicIconStickersError;
      this.nextGetForumTopicIconStickersError = null;
      throw error;
    }

    return this.topicIconStickers;
  }

  async createForumTopic(
    chatId: number,
    name: string,
    options?: TelegramCreateForumTopicOptions
  ): Promise<{ message_thread_id: number; name: string }> {
    if (this.nextCreateForumTopicError) {
      const error = this.nextCreateForumTopicError;
      this.nextCreateForumTopicError = null;
      throw error;
    }

    this.events.push(`topic:${name}`);
    this.createdTopics.push(options ? { chatId, name, options } : { chatId, name });
    this.topicCounter += 1;
    return { message_thread_id: this.topicCounter, name };
  }

  async sendMessage(
    chatId: number,
    text: string,
    options?: TelegramSendOptions
  ): Promise<{ message_id: number }> {
    if (this.nextSendMessageError) {
      const error = this.nextSendMessageError;
      this.nextSendMessageError = null;
      throw error;
    }

    this.messageCounter += 1;
    this.events.push(`message:${text}`);
    if (!isStreamingStatusText(text)) {
      this.sentMessages.push(
        options
          ? { messageId: this.messageCounter, chatId, text, options }
          : { messageId: this.messageCounter, chatId, text }
      );
    }
    this.drafts.push(
      options
        ? { chatId, draftId: this.messageCounter, text, options }
        : { chatId, draftId: this.messageCounter, text }
    );
    this.appliedDrafts.push(
      options ? { chatId, draftId: this.messageCounter, text, options } : { chatId, draftId: this.messageCounter, text }
    );
    return { message_id: this.messageCounter };
  }

  async sendMessageDraft(
    chatId: number,
    draftId: number,
    text: string,
    options?: { message_thread_id?: number; entities?: MessageEntity[] }
  ): Promise<true> {
    this.events.push(`draft:${text}`);
    this.drafts.push(options ? { chatId, draftId, text, options } : { chatId, draftId, text });
    if (this.nextDraftError) {
      const error = this.nextDraftError;
      this.nextDraftError = null;
      throw error;
    }

    const blocker = this.draftBlocks.shift();
    if (blocker) {
      await blocker;
    }

    this.appliedDrafts.push(options ? { chatId, draftId, text, options } : { chatId, draftId, text });
    return true;
  }

  async sendChatAction(
    chatId: number,
    action: "typing" | "upload_document",
    options?: { message_thread_id?: number }
  ): Promise<true> {
    this.events.push(`chat-action:${action}`);
    this.chatActions.push(options ? { chatId, action, options } : { chatId, action });
    if (this.nextChatActionError) {
      const error = this.nextChatActionError;
      this.nextChatActionError = null;
      throw error;
    }
    return true;
  }

  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    options?: TelegramEditOptions
  ): Promise<unknown> {
    if (this.nextEditMessageTextError) {
      const error = this.nextEditMessageTextError;
      this.nextEditMessageTextError = null;
      throw error;
    }

    this.events.push(`edit:${messageId}:${text}`);
    this.edits.push({ chatId, messageId, text });
    this.editOptions.push(options ? { chatId, messageId, options } : { chatId, messageId });
    this.drafts.push(
      options ? { chatId, draftId: messageId, text, options } : { chatId, draftId: messageId, text }
    );
    const blocker = this.editBlocks.shift();
    if (blocker) {
      await blocker;
    }
    this.appliedDrafts.push(
      options ? { chatId, draftId: messageId, text, options } : { chatId, draftId: messageId, text }
    );
    return true;
  }

  async deleteMessage(chatId: number, messageId: number): Promise<true> {
    this.events.push(`delete:${messageId}`);
    if (this.nextDeleteMessageError) {
      const error = this.nextDeleteMessageError;
      this.nextDeleteMessageError = null;
      throw error;
    }
    this.deletions.push({ chatId, messageId });
    const blocker = this.deleteBlocks.shift();
    if (blocker) {
      await blocker;
    }
    return true;
  }

  async answerCallbackQuery(callbackQueryId: string, options?: { text?: string }): Promise<true> {
    this.events.push(`callback:${callbackQueryId}`);
    if (this.nextAnswerCallbackQueryError) {
      const error = this.nextAnswerCallbackQueryError;
      this.nextAnswerCallbackQueryError = null;
      throw error;
    }
    this.callbackAnswers.push(options ? { callbackQueryId, options } : { callbackQueryId });
    return true;
  }

  async downloadFile(fileId: string): Promise<{ bytes: Uint8Array; filePath?: string }> {
    this.downloads.push({ fileId });
    return {
      bytes: new TextEncoder().encode(`image:${fileId}`),
      filePath: `${fileId}.png`
    };
  }
}

describe("TelegramCodexBridge", () => {
  let database: BridgeDatabase;
  let tempDir: string;
  let codex: FakeCodex;
  let telegram: FakeTelegram;
  let bridge: TelegramCodexBridge;
  let config: AppConfig;
  let mediaStore: TemporaryImageStore;
  let restartKirbot: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "telegram-codex-bridge-service-"));
    database = new BridgeDatabase(join(tempDir, "bridge.sqlite"));
    await database.migrate();

    codex = new FakeCodex();
    telegram = new FakeTelegram();
    config = {
      telegram: {
        botToken: "token",
        workspaceChatId: -1001,
        mediaTempDir: join(tempDir, "telegram-media"),
        miniApp: {
          publicUrl: "https://example.com/mini-app"
        }
      },
      database: {
        path: join(tempDir, "bridge.sqlite")
      },
      codex: {
        defaultCwd: "/workspace",
        model: undefined,
        modelProvider: undefined,
        sandbox: undefined,
        approvalPolicy: undefined,
        serviceName: "telegram-codex-bridge",
        baseInstructions: undefined,
        developerInstructions: undefined,
        config: undefined
      }
    };

    mediaStore = new TemporaryImageStore(config.telegram.mediaTempDir);
    await mediaStore.cleanupStaleFiles();
    restartKirbot = vi.fn(async (_reportStep?: (command: string) => Promise<void>) => undefined);
    bridge = new TelegramCodexBridge(config, database, telegram, codex, mediaStore, console, {
      restartKirbot,
      messengerDeliveryPolicy: ZERO_SPACING_DELIVERY_POLICY
    });
  });

  afterEach(async () => {
    await database.close();
    rmSync(tempDir, { force: true, recursive: true });
  });

  it("creates a persistent root Codex thread from the main chat", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 10,
      updateId: 20,
      userId: 42,
      text: "Fix the failing deployment tests"
    });

    expect(telegram.createdTopics).toHaveLength(0);
    expect(codex.createdThreads).toEqual(["Root Chat"]);
    expect(codex.turns).toEqual([
      {
        threadId: "thread-1",
        text: "Fix the failing deployment tests",
        turnId: "turn-1"
      }
    ]);
    expect(telegram.sentMessages).toEqual([]);

    const session = await database.getRootSessionByChat(-1001);
    expect(session?.status).toBe("active");
    expect(session?.codexThreadId).toBe("thread-1");
    expect(session?.surface).toEqual({ kind: "general" });
  });

  it("treats General as the shared root slash-command scope", () => {
    expect(isAllowedSlashCommandInScope("plan", "general")).toBe(true);
    expect(isAllowedSlashCommandInScope("thread", "general")).toBe(true);
    expect(isAllowedSlashCommandInScope("cmd", "general")).toBe(true);
    expect(isAllowedSlashCommandInScope("stop", "general")).toBe(false);
    expect(isAllowedSlashCommandInScope("implement", "general")).toBe(false);
  });

  it("does not persist or reuse the unknown-model sentinel for root defaults", async () => {
    codex.model = "unknown-model";

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 10,
      updateId: 20,
      userId: 42,
      text: "Fix the failing deployment tests"
    });

    expect(codex.createThreadCalls.at(-1)).toEqual({
      title: "Root Chat",
      settings: expect.not.objectContaining({
        model: "unknown-model"
      })
    });

    const defaults = await database.getChatThreadDefaults("-1001");
    expect(defaults?.root.model).toBeNull();
    expect(defaults?.spawn.model).toBeNull();
  });

  it("does not attach the command keyboard to a completion footer unless requested", async () => {
    await database.createCustomCommand({
      command: "standup",
      prompt: "Draft the status update."
    });

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 11,
      updateId: 21,
      userId: 42,
      text: "Inspect the release checklist"
    });

    codex.readTurnSnapshotResult = {
      text: "Done",
      assistantText: "Done"
    };
    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await waitForAsyncNotifications();

    expect(getReplyKeyboardRows(telegram.sentMessages.at(-1))).toEqual([]);
  });

  it.each([
    {
      title: "general",
      topicId: null,
      expectedRows: [
        ["/plan", "/thread"],
        ["/restart", "/cmd"],
        ["/model", "/fast"],
        ["/compact", "/clear"],
        ["/permissions", "/commands"],
        ["/standup"]
      ]
    },
    {
      title: "topic",
      topicId: 777,
      expectedRows: [
        ["/stop", "/plan"],
        ["/implement", "/model"],
        ["/fast", "/compact"],
        ["/clear", "/permissions"],
        ["/commands", "/standup"]
      ]
    }
  ])("shows the command keyboard when /commands is requested in $title scope", async ({ topicId, expectedRows }) => {
    await database.createCustomCommand({
      command: "standup",
      prompt: "Draft the status update."
    });

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId,
      messageId: 11,
      updateId: 21,
      userId: 42,
      text: "/commands"
    });

    expect(telegram.sentMessages.at(-1)).toMatchObject({
      chatId: -1001,
      ...(topicId !== null ? { options: { message_thread_id: topicId } } : {}),
      text: "Commands"
    });
    expect(getReplyKeyboardRows(telegram.sentMessages.at(-1))).toEqual(expectedRows);
  });

  it.each([
    {
      title: "root",
      topicId: null,
      initialMessage: "Inspect the root session",
      followUpMessage: "Continue here"
    },
    {
      title: "topic",
      topicId: 777,
      initialMessage: "Inspect the topic session",
      followUpMessage: "Continue here"
    }
  ])("starts a fresh Codex thread when /clear is requested in $title scope", async ({ topicId, initialMessage, followUpMessage }) => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId,
      messageId: 12,
      updateId: 22,
      userId: 42,
      text: initialMessage
    });

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await waitForAsyncNotifications();

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId,
      messageId: 13,
      updateId: 23,
      userId: 42,
      text: "/clear"
    });

    expect(codex.createdThreads).toHaveLength(2);
    expect(codex.createdThreads[1]).toBe(codex.createdThreads[0]);
    expect(codex.createThreadCalls.at(1)?.settings).toEqual(codex.createThreadCalls.at(0)?.settings);
    expect(codex.readThreadCalls).toEqual(["thread-1"]);
    expect(telegram.sentMessages.at(-1)?.text).toBe("Started a fresh Codex thread");

    const session =
      topicId === null
        ? await database.getRootSessionByChat(-1001)
        : await database.getSessionByTopic(-1001, topicId);
    expect(session?.codexThreadId).toBe("thread-2");

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId,
      messageId: 14,
      updateId: 24,
      userId: 42,
      text: followUpMessage
    });

    expect(codex.turns.at(-1)?.threadId).toBe("thread-2");

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-2",
        turn: {
          id: "turn-2",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await waitForAsyncNotifications();
  });

  it.each([
    {
      title: "root",
      topicId: null,
      expectedText: "This chat does not have a Codex session yet. Send a normal message first to start one"
    },
    {
      title: "topic",
      topicId: 777,
      expectedText: "This topic does not have a Codex session yet. Send a normal message first to start one"
    }
  ])("rejects /clear before a Codex session exists in $title scope", async ({ topicId, expectedText }) => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId,
      messageId: 12,
      updateId: 22,
      userId: 42,
      text: "/clear"
    });

    expect(codex.createdThreads).toHaveLength(0);
    expect(telegram.sentMessages.at(-1)?.text).toBe(expectedText);
  });

  it.each([
    {
      title: "root",
      topicId: null
    },
    {
      title: "topic",
      topicId: 777
    }
  ])("rejects /clear while a turn is active in $title scope", async ({ topicId }) => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId,
      messageId: 12,
      updateId: 22,
      userId: 42,
      text: "Inspect the active response"
    });

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId,
      messageId: 13,
      updateId: 23,
      userId: 42,
      text: "/clear"
    });

    expect(codex.createdThreads).toHaveLength(1);
    expect(telegram.sentMessages.at(-1)?.text).toBe(
      "Wait for the current response to finish or stop it first before clearing"
    );

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await waitForAsyncNotifications();
  });

  it("assigns a random custom emoji topic icon when /thread creates a topic", async () => {
    telegram.topicIconStickers = [{ custom_emoji_id: "emoji-1" }];

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 10,
      updateId: 20,
      userId: 42,
      text: "/thread Fix the failing deployment tests"
    });

    expect(telegram.createdTopics).toMatchObject([
      {
        chatId: -1001,
        name: "Fix the failing deployment tests",
        options: {
          icon_custom_emoji_id: "emoji-1"
        }
      }
    ]);
  });

  it("falls back to a built-in topic icon color when /thread topic icon lookup fails", async () => {
    telegram.nextGetForumTopicIconStickersError = new Error("icon lookup failed");

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 10,
      updateId: 20,
      userId: 42,
      text: "/thread Fix the failing deployment tests"
    });

    expect(telegram.createdTopics).toHaveLength(1);
    expect(TELEGRAM_FORUM_TOPIC_ICON_COLORS).toContain(
      telegram.createdTopics[0]?.options?.icon_color ?? -1
    );
  });

  it("continues /thread session startup when sending the startup footer fails", async () => {
    telegram.nextSendMessageError = new Error("footer failed");

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 10,
      updateId: 20,
      userId: 42,
      text: "/thread Fix the failing deployment tests"
    });

    expect(telegram.sentMessages).toMatchObject([
      {
        chatId: -1001,
        text: "Fix the failing deployment tests",
        options: {
          message_thread_id: 101,
          entities: preformattedEntities("Fix the failing deployment tests", "user prompt")
        }
      }
    ]);
    expect(codex.turns).toEqual([
      {
        threadId: "thread-1",
        text: "Fix the failing deployment tests",
        turnId: "turn-1"
      }
    ]);
  });

  it("rejects root slash commands instead of creating a new topic", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 12,
      updateId: 22,
      userId: 42,
      text: "/stop"
    });

    expect(telegram.createdTopics).toHaveLength(0);
    expect(codex.createdThreads).toHaveLength(0);
    expect(telegram.sentMessages.at(-1)?.text).toBe("This command is not valid here");
  });

  it("reuses the same root Codex thread for multiple plain root messages", async () => {
    codex.readTurnSnapshotResult = {
      text: "Initial answer",
      assistantText: "Initial answer"
    };

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 13,
      updateId: 23,
      userId: 42,
      text: "Inspect repo"
    });
    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await waitForAsyncNotifications();

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 14,
      updateId: 24,
      userId: 42,
      text: "Continue"
    });

    expect(telegram.createdTopics).toHaveLength(0);
    expect(codex.createdThreads).toEqual(["Root Chat"]);
    expect(codex.turns).toEqual([
      {
        threadId: "thread-1",
        text: "Inspect repo",
        turnId: "turn-1"
      },
      {
        threadId: "thread-1",
        text: "Continue",
        turnId: "turn-2"
      }
    ]);
  });

  it("keeps root bootstrap fail-open when two first root messages race", async () => {
    const originalGetRootSessionByChat = database.getRootSessionByChat.bind(database);
    const firstTwoLookupsReached = deferred<void>();
    const releaseFirstTwoLookups = deferred<void>();
    let heldLookupCount = 0;

    database.getRootSessionByChat = vi.fn(async (chatId: number | string) => {
      if (heldLookupCount < 2) {
        heldLookupCount += 1;
        if (heldLookupCount === 2) {
          firstTwoLookupsReached.resolve();
        }
        await releaseFirstTwoLookups.promise;
      }

      return originalGetRootSessionByChat(chatId);
    });

    const firstMessagePromise = bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 13,
      updateId: 23,
      userId: 42,
      text: "Inspect repo"
    });
    const secondMessagePromise = bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 14,
      updateId: 24,
      userId: 42,
      text: "Continue"
    });

    await firstTwoLookupsReached.promise;
    releaseFirstTwoLookups.resolve();

    await expect(Promise.all([firstMessagePromise, secondMessagePromise])).resolves.toEqual([undefined, undefined]);

    expect(codex.createdThreads).toEqual(["Root Chat"]);
    expect(telegram.sentMessages.at(-1)?.text).toBe("The General Codex session is still provisioning. Try again in a moment");

    const session = await database.getRootSessionByChat(-1001);
    expect(session?.status).toBe("active");
    expect(session?.codexThreadId).toBe("thread-1");
  });

  it("recovers the root session after a prior provisioning failure left it errored", async () => {
    const pending = await database.createProvisioningSession({
      telegramChatId: "-1001",
      surface: { kind: "general" }
    });
    await database.markSessionErrored(pending.id);

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 15,
      updateId: 25,
      userId: 42,
      text: "Try root again"
    });

    expect(codex.createdThreads).toEqual(["Root Chat"]);
    expect(codex.turns).toEqual([
      {
        threadId: "thread-1",
        text: "Try root again",
        turnId: "turn-1"
      }
    ]);

    const session = await database.getRootSessionByChat(-1001);
    expect(session?.status).toBe("active");
    expect(session?.codexThreadId).toBe("thread-1");
  });

  it("rebuilds and restarts kirbot from root /restart", async () => {
    restartKirbot.mockImplementationOnce(async (reportStep?: (command: string) => Promise<void>) => {
      for (const command of [
        "git checkout master",
        "git fetch origin",
        "git reset --hard origin/master",
        "npm run build",
        "npm run start:tmux:restart"
      ]) {
        await reportStep?.(command);
      }
    });

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 12,
      updateId: 122,
      userId: 42,
      text: "/restart"
    });

    expect(restartKirbot).toHaveBeenCalledTimes(1);
    expect(telegram.createdTopics).toHaveLength(0);
    expect(codex.createdThreads).toHaveLength(0);
    expect(
      telegram.sentMessages.map((message) => ({
        text: message.text,
        entities: message.options?.entities
      }))
    ).toEqual([
      buildRunningMessage("git checkout master"),
      buildRunningMessage("git fetch origin"),
      buildRunningMessage("git reset --hard origin/master"),
      buildRunningMessage("npm run build"),
      buildRunningMessage("npm run start:tmux:restart"),
      {
        text: "Kirbot production session restarted.",
        entities: undefined
      }
    ]);
  });

  it("surfaces restart failures from root /restart", async () => {
    restartKirbot.mockImplementationOnce(async (reportStep?: (command: string) => Promise<void>) => {
      await reportStep?.("git checkout master");
      await reportStep?.("git fetch origin");
      await reportStep?.("git reset --hard origin/master");
      throw new Error("git reset --hard origin/master exited with code 1");
    });

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 12,
      updateId: 123,
      userId: 42,
      text: "/restart"
    });

    expect(restartKirbot).toHaveBeenCalledTimes(1);
    expect(
      telegram.sentMessages.map((message) => ({
        text: message.text,
        entities: message.options?.entities
      }))
    ).toEqual([
      buildRunningMessage("git checkout master"),
      buildRunningMessage("git fetch origin"),
      buildRunningMessage("git reset --hard origin/master"),
      {
        text: "Failed to rebuild or restart kirbot: git reset --hard origin/master exited with code 1",
        entities: undefined
      }
    ]);
  });

  it("creates a new topic session from root /thread with an initial prompt", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 13,
      updateId: 23,
      userId: 42,
      text: "/thread Draft the rollout"
    });

    expect(telegram.createdTopics).toMatchObject([
      {
        chatId: -1001,
        name: "Draft the rollout"
      }
    ]);
    expect(codex.createdThreads).toEqual(["Draft the rollout"]);
    expect(codex.createThreadCalls).toEqual([
      {
        title: "Draft the rollout",
        settings: expect.objectContaining({
          model: "gpt-5-codex",
          serviceTier: null
        })
      }
    ]);
    expect(codex.turns).toEqual([
      {
        threadId: "thread-1",
        text: "Draft the rollout",
        turnId: "turn-1"
      }
    ]);
  });

  it("rejects bare root /thread before creating a topic", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 13,
      updateId: 27,
      userId: 42,
      text: "/thread"
    });

    expect(telegram.createdTopics).toHaveLength(0);
    expect(codex.createdThreads).toHaveLength(0);
    expect(telegram.sentMessages.at(-1)?.text).toBe("Usage: /thread <initial prompt>");
  });

  it("creates a new plan-mode topic and immediate turn from root /plan with a prompt", async () => {
    codex.reasoningEffort = "high";

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 13,
      updateId: 23,
      userId: 42,
      text: "/plan sketch the migration"
    });

    expect(telegram.createdTopics).toMatchObject([
      {
        chatId: -1001,
        name: "sketch the migration"
      }
    ]);
    expect(codex.createdThreads).toEqual(["sketch the migration"]);
    expect(codex.turns).toEqual([
      {
        threadId: "thread-1",
        text: "sketch the migration",
        turnId: "turn-1"
      }
    ]);
    expect(codex.turnCollaborationModes).toEqual([
      {
        turnId: "turn-1",
        collaborationMode: {
          mode: "plan",
          settings: {
            model: "gpt-5-codex",
            reasoning_effort: "high",
            developer_instructions: null
          }
        }
      }
    ]);
    expect(await database.getSessionByTopic(-1001, 101)).toMatchObject({
      preferredMode: "plan"
    });
    expect(telegram.sentMessages).toMatchObject([
      {
        chatId: -1001,
        text:
          "General stays shared for workspace-wide work. Use /thread to create a separate topic.\n<1s • 100% left • /workspace • main • gpt-5-codex high • planning",
        options: {
          message_thread_id: 101,
          entities: preformattedEntities(
            "<1s • 100% left • /workspace • main • gpt-5-codex high • planning",
            "status"
          ).map((entity) => ({
            ...entity,
            offset:
              entity.offset +
              "General stays shared for workspace-wide work. Use /thread to create a separate topic.\n".length
          }))
        }
      },
      {
        chatId: -1001,
        text: "sketch the migration",
        options: {
          message_thread_id: 101,
          entities: preformattedEntities("sketch the migration", "user prompt")
        }
      },
      {
        chatId: -1001,
        text: "Plan mode enabled",
        options: {
          message_thread_id: 101
        }
      }
    ]);

  });

  it("preserves image attachments for root /plan turns started from an image caption", async () => {
    await bridge.handleUserMessage({
      chatId: -1001,
      topicId: null,
      messageId: 14,
      updateId: 24,
      userId: 42,
      text: "/plan sketch the migration",
      input: [
        {
          type: "text",
          text: "/plan sketch the migration",
          text_elements: []
        },
        {
          type: "telegramImage",
          fileId: "photo-root-plan",
          fileName: "plan.png",
          mimeType: "image/png"
        }
      ]
    });

    expect(telegram.createdTopics).toMatchObject([
      {
        chatId: -1001,
        name: "sketch the migration"
      }
    ]);
    expect(telegram.downloads).toEqual([{ fileId: "photo-root-plan" }]);
    expect(codex.turns.at(-1)).toMatchObject({
      threadId: "thread-1",
      text: "sketch the migration",
      turnId: "turn-1"
    });
    expect(codex.turns.at(-1)?.input[0]).toEqual({
      type: "text",
      text: "sketch the migration",
      text_elements: []
    });
    expect(codex.turns.at(-1)?.input[1]?.type).toBe("localImage");
  });

  it("creates a new empty plan-mode topic from bare root /plan", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 14,
      updateId: 24,
      userId: 42,
      text: "/plan"
    });

    expect(telegram.createdTopics).toMatchObject([
      {
        chatId: -1001,
        name: "New Plan Session"
      }
    ]);
    expect(codex.createdThreads).toEqual(["New Plan Session"]);
    expect(codex.turns).toHaveLength(0);
    expect(await database.getSessionByTopic(-1001, 101)).toMatchObject({
      preferredMode: "plan"
    });
    expect(telegram.sentMessages).toMatchObject([
      {
        chatId: -1001,
        text:
          "General stays shared for workspace-wide work. Use /thread to create a separate topic.\n<1s • 100% left • /workspace • main • gpt-5-codex • planning",
        options: {
          message_thread_id: 101,
          entities: preformattedEntities(
            "<1s • 100% left • /workspace • main • gpt-5-codex • planning",
            "status"
          ).map((entity) => ({
            ...entity,
            offset:
              entity.offset +
              "General stays shared for workspace-wide work. Use /thread to create a separate topic.\n".length
          }))
        }
      },
      {
        chatId: -1001,
        text: "Plan mode enabled",
        options: {
          message_thread_id: 101
        }
      }
    ]);

  });

  it("rejects /implement from root instead of creating a new topic", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 15,
      updateId: 25,
      userId: 42,
      text: "/implement"
    });

    expect(telegram.createdTopics).toHaveLength(0);
    expect(codex.createdThreads).toHaveLength(0);
    expect(telegram.sentMessages.at(-1)?.text).toBe("This command is not valid here");
  });

  it("shows a short help blurb for /cmd with no arguments", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 16,
      updateId: 26,
      userId: 42,
      text: "/cmd"
    });

    expect(telegram.sentMessages.at(-1)?.text).toBe(
      [
        "Manage custom thread commands.",
        "Usage: /cmd add <command> <prompt>",
        "Usage: /cmd update <command> <prompt>",
        "Usage: /cmd delete <command>",
        "Custom commands are typed-only and only work in topics."
      ].join("\n")
    );
  });

  it("creates a pending custom command confirmation instead of adding immediately", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 17,
      updateId: 27,
      userId: 42,
      text: "/cmd add standup Draft the daily update."
    });

    const pending = await database.getPendingCustomCommandAddByCommand("standup");
    expect(pending?.status).toBe("pending");
    expect(await database.getCustomCommandByName("standup")).toBeUndefined();
    expect(telegram.sentMessages.at(-1)).toMatchObject({
      chatId: -1001,
      text: "Add custom command /standup?\n\nPrompt:\nDraft the daily update."
    });
    expect(getInlineButtonTexts(telegram.sentMessages.at(-1))).toEqual(["Add", "Cancel"]);
  });

  it("confirms a pending custom command add through callback", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 18,
      updateId: 28,
      userId: 42,
      text: "/cmd add standup Draft the daily update."
    });

    const pending = await database.getPendingCustomCommandAddByCommand("standup");
    const confirmationMessage = telegram.sentMessages.at(-1);
    await bridge.handleCallbackQuery({
      callbackQueryId: "customcmd-confirm",
      data: getCallbackDataByButtonText(confirmationMessage, "Add")!,
      chatId: -1001,
      topicId: null,
      userId: 42
    });

    expect(await database.getCustomCommandByName("standup")).toMatchObject({
      command: "standup",
      prompt: "Draft the daily update."
    });
    expect((await database.getPendingCustomCommandAddById(pending!.id))?.status).toBe("confirmed");
    expect(telegram.edits.at(-1)?.text).toBe("Added /standup");
    expect(telegram.callbackAnswers.at(-1)?.options?.text).toBe("Command added");
  });

  it("cancels a pending custom command add through callback", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 19,
      updateId: 29,
      userId: 42,
      text: "/cmd add standup Draft the daily update."
    });

    const pending = await database.getPendingCustomCommandAddByCommand("standup");
    const confirmationMessage = telegram.sentMessages.at(-1);
    await bridge.handleCallbackQuery({
      callbackQueryId: "customcmd-cancel",
      data: getCallbackDataByButtonText(confirmationMessage, "Cancel")!,
      chatId: -1001,
      topicId: null,
      userId: 42
    });

    expect((await database.getPendingCustomCommandAddById(pending!.id))?.status).toBe("canceled");
    expect(await database.getCustomCommandByName("standup")).toBeUndefined();
    expect(telegram.edits.at(-1)?.text).toBe("Canceled adding /standup");
    expect(telegram.callbackAnswers.at(-1)?.options?.text).toBe("Canceled");
  });

  it("treats repeated custom command confirmation callbacks as stale", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 20,
      updateId: 30,
      userId: 42,
      text: "/cmd add standup Draft the daily update."
    });

    const confirmationMessage = telegram.sentMessages.at(-1);
    const confirmData = getCallbackDataByButtonText(confirmationMessage, "Add")!;
    await bridge.handleCallbackQuery({
      callbackQueryId: "customcmd-confirm-first",
      data: confirmData,
      chatId: -1001,
      topicId: null,
      userId: 42
    });
    await bridge.handleCallbackQuery({
      callbackQueryId: "customcmd-confirm-second",
      data: confirmData,
      chatId: -1001,
      topicId: null,
      userId: 42
    });

    expect(telegram.callbackAnswers.at(-1)?.options?.text).toBe("This confirmation is no longer pending");
  });

  it("rejects duplicate and reserved custom command names", async () => {
    await database.createCustomCommand({
      command: "standup",
      prompt: "Draft the daily update."
    });

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 20,
      updateId: 30,
      userId: 42,
      text: "/cmd add standup Draft something else."
    });
    expect(telegram.sentMessages.at(-1)?.text).toBe("/standup already exists");

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 21,
      updateId: 31,
      userId: 42,
      text: "/cmd add plan Draft something else."
    });
    expect(telegram.sentMessages.at(-1)?.text).toBe("/plan is reserved");
  });

  it("updates and deletes an existing custom command from root /cmd", async () => {
    await database.createCustomCommand({
      command: "standup",
      prompt: "Draft the daily update."
    });

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 22,
      updateId: 32,
      userId: 42,
      text: "/cmd update standup Draft the weekly update."
    });

    expect(telegram.sentMessages.at(-1)?.text).toBe("Updated /standup");
    expect((await database.getCustomCommandByName("standup"))?.prompt).toBe("Draft the weekly update.");

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 23,
      updateId: 33,
      userId: 42,
      text: "/cmd delete standup"
    });

    expect(telegram.sentMessages.at(-1)?.text).toBe("Deleted /standup");
    expect(await database.getCustomCommandByName("standup")).toBeUndefined();
  });

  it("accepts messages from any sender in the configured workspace chat", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 10,
      updateId: 20,
      userId: 99,
      text: "Fix the failing deployment tests"
    });

    expect(telegram.createdTopics).toHaveLength(0);
    expect(codex.createdThreads).toEqual(["Root Chat"]);
    expect(codex.turns).toEqual([
      {
        threadId: "thread-1",
        text: "Fix the failing deployment tests",
        turnId: "turn-1"
      }
    ]);
  });

  it("rejects direct messages instead of treating them as the root surface", async () => {
    await bridge.handleUserTextMessage({
      chatId: 99,
      topicId: null,
      messageId: 11,
      updateId: 21,
      userId: 99,
      text: "Can you help from DM?"
    });

    expect(codex.createdThreads).toHaveLength(0);
    expect(await database.getRootSessionByChat(99)).toBeUndefined();
    expect(telegram.sentMessages.at(-1)).toMatchObject({
      chatId: 99,
      text: "Use Kirbot from the configured workspace forum chat."
    });
  });

  it("creates a Codex session inside an unmapped existing topic", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 10,
      updateId: 21,
      userId: 42,
      text: "Investigate the flaky CI run"
    });

    expect(telegram.createdTopics).toHaveLength(0);
    expect(codex.createdThreads).toEqual(["Investigate the flaky CI run"]);
    expect(codex.turns).toEqual([
      {
        threadId: "thread-1",
        text: "Investigate the flaky CI run",
        turnId: "turn-1"
      }
    ]);

    const session = await database.getSessionByTopic(-1001, 777);
    expect(session?.status).toBe("active");
    expect(session?.codexThreadId).toBe("thread-1");
    expect(telegram.sentMessages.at(0)?.text).toBe(
      "General stays shared for workspace-wide work. Use /thread to create a separate topic.\n<1s • 100% left • /workspace • main • gpt-5-codex"
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(telegram.drafts.at(-1)?.text).toBe("thinking · 0s");
    expect(telegram.chatActions.some((action) => action.action === "typing")).toBe(true);
  });

  it("keeps live status drafts minimal while tool work updates the state", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 778,
      messageId: 10,
      updateId: 23,
      userId: 42,
      text: "Investigate the status flow"
    });

    codex.emitNotification({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "reasoning",
          id: "reasoning-1",
          summary: [],
          content: []
        }
      }
    });
    codex.emitNotification({
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "reasoning-1",
        summaryIndex: 0,
        delta: "Check the current status renderer."
      }
    });
    await waitForAsyncNotifications();

    expect(telegram.drafts.at(-1)?.text).toBe("thinking · 0s");
    expect(telegram.drafts.at(-1)?.options?.entities).toBeUndefined();

    codex.emitNotification({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "npm test",
          cwd: "/workspace",
          processId: null,
          status: "inProgress",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null
        }
      }
    });
    const commandDraft = "running · 0s";
    await waitForCondition(() => telegram.drafts.at(-1)?.text === commandDraft);

    expect(telegram.drafts.at(-1)?.text).toBe(commandDraft);
    expect(telegram.drafts.at(-1)?.options?.entities).toBeUndefined();
  });

  it("ignores raw reasoning deltas in the live status draft", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 18,
      updateId: 31,
      userId: 42,
      text: "Inspect the renderer"
    });

    codex.emitNotification({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "reasoning",
          id: "reasoning-1",
          summary: [],
          content: []
        }
      }
    });
    codex.emitNotification({
      method: "item/reasoning/textDelta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "reasoning-1",
        delta: "**Inspect current renderer**",
        contentIndex: 0
      }
    });
    await waitForAsyncNotifications();

    expect(telegram.drafts.at(-1)?.text).toBe("thinking · 0s");
    expect(telegram.drafts.at(-1)?.options?.entities).toBeUndefined();
  });

  it("replays turn completion that arrives before the turn is locally activated", async () => {
    codex.readTurnSnapshotResult = {
      text: "Final from snapshot",
      assistantText: "Final from snapshot"
    };
    codex.beforeSendTurnResolve = ({ threadId, turnId }) => {
      codex.emitNotification({
        method: "turn/completed",
        params: {
          threadId,
          turn: {
            id: turnId,
            items: [],
            status: "completed",
            error: null
          }
        }
      });
    };

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 779,
      messageId: 11,
      updateId: 22,
      userId: 42,
      text: "Handle the race"
    });
    await waitForCondition(() => getFinalAnswerMessage(telegram)?.text === "Final from snapshot");

    expect(getFinalAnswerMessage(telegram)?.text).toBe("Final from snapshot");
  });

  it("replays approval requests that arrive before the turn is locally activated", async () => {
    codex.beforeSendTurnResolve = ({ threadId, turnId }) => {
      codex.emitRequest({
        method: "item/commandExecution/requestApproval",
        id: "approval-early",
        params: {
          threadId,
          turnId,
          itemId: "item-1",
          command: "npm test",
          cwd: "/workspace",
          reason: "Need approval",
          availableDecisions: ["accept", "decline", "cancel"]
        }
      });
    };

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 780,
      messageId: 12,
      updateId: 23,
      userId: 42,
      text: "Handle approval race"
    });
    await waitForAsyncNotifications();

    const pending = await database.getPendingRequestByTopic(-1001, 780);
    expect(pending?.method).toBe("item/commandExecution/requestApproval");
    expect(telegram.sentMessages.at(-1)?.text).toContain("Command approval needed");
    expect(telegram.sentMessages.at(-1)?.text).toContain("CWD: /workspace");
    expect(telegram.sentMessages.at(-1)?.options?.entities?.map((entity) => entity.type)).toEqual(["pre", "code"]);
  });

  it("rejects slash commands in a topic before creating a session", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 778,
      messageId: 13,
      updateId: 23,
      userId: 42,
      text: "/help"
    });

    expect(codex.turns).toHaveLength(0);
    expect(telegram.sentMessages.at(-1)?.text).toBe("This command is not valid here");
    const session = await database.getSessionByTopic(-1001, 778);
    expect(session).toBeUndefined();
  });

  it("rejects /cmd inside a topic", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 779,
      messageId: 14,
      updateId: 24,
      userId: 42,
      text: "/cmd"
    });

    expect(telegram.sentMessages.at(-1)?.text).toBe("This command is not valid here");
  });

  it("requires an existing session before enabling plan mode", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 780,
      messageId: 14,
      updateId: 24,
      userId: 42,
      text: "/plan"
    });

    expect(telegram.sentMessages.at(-1)?.text).toBe(
      "This topic does not have a Codex session yet. Send a normal message first to start one"
    );
    expect(telegram.sentMessages.at(-1)?.options?.disable_notification).toBe(true);
  });

  it("requires an existing session before changing thread-local Codex settings", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 781,
      messageId: 15,
      updateId: 25,
      userId: 42,
      text: "/fast status"
    });

    expect(telegram.sentMessages.at(-1)?.text).toBe(
      "This topic does not have a Codex session yet. Send a normal message first to start one"
    );
  });

  it("rejects thread-local Codex setting changes while a turn is active", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 781,
      messageId: 10,
      updateId: 24,
      userId: 42,
      text: "Start the session"
    });

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 781,
      messageId: 11,
      updateId: 25,
      userId: 42,
      text: "/fast"
    });

    expect(telegram.sentMessages.at(-1)?.text).toBe(
      "Wait for the current response to finish or stop it first before changing settings"
    );
    expect(codex.globalSettingsUpdates).toHaveLength(0);
    expect(codex.threadSettingsUpdates).toHaveLength(0);
  });

  it("applies root /fast to spawn defaults through explicit scope selection", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 11,
      updateId: 27,
      userId: 42,
      text: "/fast on"
    });

    const scopePicker = telegram.sentMessages.at(-1);
    expect(scopePicker?.text).toBe("Apply fast mode to:");
    expect(getInlineButtonTexts(scopePicker)).toEqual(["General Thread", "New /thread Topics"]);

    const spawnCallback = getCallbackDataByButtonText(scopePicker, "New /thread Topics");
    expect(spawnCallback).toBe("slash:fast:apply:spawn:on");

    await bridge.handleCallbackQuery({
      callbackQueryId: "fast-spawn",
      data: spawnCallback!,
      chatId: -1001,
      topicId: null,
      userId: 42
    });

    expect(telegram.sentMessages.at(-1)?.text).toBe("New thread default fast mode enabled");
    expect(codex.globalSettingsUpdates).toHaveLength(0);
    expect(codex.threadSettingsUpdates).toHaveLength(0);

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 12,
      updateId: 28,
      userId: 42,
      text: "/thread Use fast mode"
    });

    expect(codex.createThreadCalls.at(-1)).toEqual({
      title: "Use fast mode",
      settings: expect.objectContaining({
        serviceTier: "fast"
      })
    });
  });

  it("applies topic /fast only to that thread", async () => {
    codex.readTurnSnapshotResult = {
      text: "Initial answer",
      assistantText: "Initial answer"
    };

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 783,
      messageId: 10,
      updateId: 29,
      userId: 42,
      text: "Start the session"
    });
    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await waitForAsyncNotifications();

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 783,
      messageId: 11,
      updateId: 30,
      userId: 42,
      text: "/fast on"
    });

    expect(telegram.sentMessages.at(-1)?.text).toBe("Thread fast mode enabled");
    expect(codex.threadSettingsUpdates).toHaveLength(0);
    expect(codex.globalSettingsUpdates).toHaveLength(0);

    codex.readTurnSnapshotResult = {
      text: "Fast answer",
      assistantText: "Fast answer"
    };
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 783,
      messageId: 12,
      updateId: 31,
      userId: 42,
      text: "Use fast mode"
    });

    expect(codex.turnOverrides.at(-1)?.overrides).toEqual({
      model: "gpt-5-codex",
      reasoningEffort: null,
      serviceTier: "fast",
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [],
        readOnlyAccess: {
          type: "fullAccess"
        },
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false
      }
    });

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-2",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await waitForAsyncNotifications();

    expect(telegram.sentMessages.at(-1)?.text).toContain("gpt-5-codex fast");
  });

  it("compacts the current thread and surfaces the compaction notice", async () => {
    codex.readTurnSnapshotResult = {
      text: "Initial answer",
      assistantText: "Initial answer"
    };

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 784,
      messageId: 10,
      updateId: 32,
      userId: 42,
      text: "Start the session"
    });
    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await waitForAsyncNotifications();

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 784,
      messageId: 11,
      updateId: 33,
      userId: 42,
      text: "/compact"
    });

    expect(codex.compactThreadCalls).toEqual([{ threadId: "thread-1" }]);

    codex.emitNotification({
      method: "thread/compacted",
      params: {
        threadId: "thread-1",
        turnId: "turn-1"
      }
    });
    await waitForAsyncNotifications();

    expect(telegram.edits.findLast((edit) => edit.text === "Context compacted")).toMatchObject({
      chatId: -1001,
      text: "Context compacted"
    });
  });

  it("stores root model settings separately and uses them for the persistent root session", async () => {
    codex.models = [
      codex.models[0]!,
      {
        id: "model-2",
        model: "gpt-5.3-codex",
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
        displayName: "gpt-5.3-codex",
        description: "Alternative model",
        hidden: false,
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Fast" },
          { reasoningEffort: "high", description: "Deep" }
        ],
        defaultReasoningEffort: "low",
        inputModalities: [],
        supportsPersonality: false,
        isDefault: false
      }
    ];

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 10,
      updateId: 29,
      userId: 42,
      text: "/model"
    });

    const scopePicker = telegram.sentMessages.at(-1);
    expect(scopePicker?.text).toBe("Choose which settings to update");
    expect(getInlineButtonTexts(scopePicker)).toEqual(["General Thread", "New /thread Topics"]);

    await bridge.handleCallbackQuery({
      callbackQueryId: "scope-root-model",
      data: "slash:scope:model:root",
      chatId: -1001,
      topicId: null,
      userId: 42
    });

    const modelPicker = telegram.sentMessages.at(-1);
    expect(modelPicker?.text).toBe(
      [
        "Choose the model for the General thread",
        "Current: gpt-5-codex",
        "Then choose a reasoning effort"
      ].join("\n")
    );
    const pickCallback = getCallbackDataByButtonText(modelPicker, "gpt-5.3-codex");
    expect(pickCallback).toBe("slash:model:pick:root:1");

    await bridge.handleCallbackQuery({
      callbackQueryId: "pick-model",
      data: pickCallback!,
      chatId: -1001,
      topicId: null,
      userId: 42
    });

    const reasoningPicker = telegram.sentMessages.at(-1);
    const applyCallback = getCallbackDataByButtonText(reasoningPicker, "high");
    expect(applyCallback).toBe("slash:model:apply:root:1:high");

    await bridge.handleCallbackQuery({
      callbackQueryId: "pick-effort",
      data: applyCallback!,
      chatId: -1001,
      topicId: null,
      userId: 42
    });

    expect(codex.globalSettingsUpdates).toHaveLength(0);
    expect(codex.threadSettingsUpdates).toHaveLength(0);
    expect(telegram.sentMessages.at(-1)?.text).toBe("General thread model set to gpt-5.3-codex high");

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 11,
      updateId: 30,
      userId: 42,
      text: "Use the new model"
    });

    expect(codex.createThreadCalls.at(-1)).toEqual({
      title: "Root Chat",
      settings: expect.objectContaining({
        model: "gpt-5.3-codex",
        reasoningEffort: "high"
      })
    });
  });

  it.each([
    {
      title: "General",
      callbackQueryId: "scope-root-model-pagination",
      callbackData: "slash:scope:model:root",
      expectedTitle: "Choose the model for the General thread",
      expectedPageCallback: "slash:model:page:root:1",
      expectedPickCallback: "slash:model:pick:root:6"
    },
    {
      title: "spawn defaults",
      callbackQueryId: "scope-spawn-model-pagination",
      callbackData: "slash:scope:model:spawn",
      expectedTitle: "Choose the default model for new /thread topics",
      expectedPageCallback: "slash:model:page:spawn:1",
      expectedPickCallback: "slash:model:pick:spawn:6"
    }
  ])("preserves $title model scope when paging through the picker", async ({
    callbackQueryId,
    callbackData,
    expectedTitle,
    expectedPageCallback,
    expectedPickCallback
  }) => {
    codex.models = Array.from({ length: 7 }, (_, index) => ({
      id: `model-${index + 1}`,
      model: `gpt-5-model-${index + 1}`,
      upgrade: null,
      upgradeInfo: null,
      availabilityNux: null,
      displayName: `gpt-5-model-${index + 1}`,
      description: `Model ${index + 1}`,
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "Balanced" }
      ],
      defaultReasoningEffort: "medium",
      inputModalities: [],
      supportsPersonality: false,
      isDefault: index === 0
    }));

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 20,
      updateId: 40,
      userId: 42,
      text: "/model"
    });

    await bridge.handleCallbackQuery({
      callbackQueryId,
      data: callbackData,
      chatId: -1001,
      topicId: null,
      userId: 42
    });

    const firstPage = telegram.sentMessages.at(-1);
    expect(firstPage?.text).toBe([
      expectedTitle,
      "Current: gpt-5-codex",
      "Then choose a reasoning effort"
    ].join("\n"));

    const nextPageCallback = getCallbackDataByButtonText(firstPage, "Next");
    expect(nextPageCallback).toBe(expectedPageCallback);

    await bridge.handleCallbackQuery({
      callbackQueryId: `${callbackQueryId}-page-2`,
      data: nextPageCallback!,
      chatId: -1001,
      topicId: null,
      userId: 42
    });

    const secondPage = telegram.sentMessages.at(-1);
    expect(secondPage?.text).toBe([
      expectedTitle,
      "Current: gpt-5-codex",
      "Then choose a reasoning effort"
    ].join("\n"));
    expect(getCallbackDataByButtonText(secondPage, "gpt-5-model-7")).toBe(expectedPickCallback);
  });

  it("uses General-facing copy when opening root permissions selection", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 10,
      updateId: 31,
      userId: 42,
      text: "/permissions"
    });

    await bridge.handleCallbackQuery({
      callbackQueryId: "scope-root-permissions",
      data: "slash:scope:permissions:root",
      chatId: -1001,
      topicId: null,
      userId: 42
    });

    expect(telegram.sentMessages.at(-1)?.text).toBe(
      [
        "Choose Codex permissions for the General thread",
        "Current: Default",
        "Your selection will apply to the General thread"
      ].join("\n")
    );
  });

  it("treats /approvals as an alias for /permissions and applies the selected preset to spawn defaults", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 10,
      updateId: 32,
      userId: 42,
      text: "/approvals"
    });

    const scopePicker = telegram.sentMessages.at(-1);
    expect(scopePicker?.text).toBe("Choose which settings to update");
    expect(getInlineButtonTexts(scopePicker)).toEqual(["General Thread", "New /thread Topics"]);

    await bridge.handleCallbackQuery({
      callbackQueryId: "scope-spawn-permissions",
      data: "slash:scope:permissions:spawn",
      chatId: -1001,
      topicId: null,
      userId: 42
    });

    const permissionsPicker = telegram.sentMessages.at(-1);
    expect(getInlineButtonTexts(permissionsPicker)).toEqual(["Read Only", "• Default", "Full Access"]);

    await bridge.handleCallbackQuery({
      callbackQueryId: "permissions-full",
      data: "slash:permissions:apply:spawn:full-access",
      chatId: -1001,
      topicId: null,
      userId: 42
    });

    expect(codex.globalSettingsUpdates).toHaveLength(0);
    expect(codex.threadSettingsUpdates).toHaveLength(0);
    expect(telegram.sentMessages.at(-1)?.text).toBe("New thread default permissions set to Full Access");

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 11,
      updateId: 33,
      userId: 42,
      text: "/thread Review deployment"
    });

    expect(codex.createThreadCalls.at(-1)).toEqual({
      title: "Review deployment",
      settings: expect.objectContaining({
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "dangerFullAccess"
        }
      })
    });
  });

  it("enables plan mode without starting a turn when /plan has no prompt", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 781,
      messageId: 15,
      updateId: 25,
      userId: 42,
      text: "Investigate the flaky CI run"
    });

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await waitForAsyncNotifications();

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 781,
      messageId: 16,
      updateId: 26,
      userId: 42,
      text: "/plan"
    });

    expect(telegram.sentMessages.at(-1)?.text).toBe("Plan mode enabled");
    expect(codex.turns).toHaveLength(1);
    expect(await database.getSessionByTopic(-1001, 781)).toMatchObject({
      preferredMode: "plan"
    });
  });

  it("starts a plan-mode turn immediately when /plan includes a prompt", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 782,
      messageId: 17,
      updateId: 27,
      userId: 42,
      text: "Set up the topic"
    });

    codex.reasoningEffort = "high";
    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await waitForAsyncNotifications();

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 782,
      messageId: 18,
      updateId: 28,
      userId: 42,
      text: "/plan sketch the migration"
    });

    expect(codex.turns.at(-1)).toMatchObject({
      threadId: "thread-1",
      text: "sketch the migration",
      turnId: "turn-2"
    });
    expect(codex.turnCollaborationModes.at(-1)).toMatchObject({
      turnId: "turn-2",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5-codex",
          reasoning_effort: null,
          developer_instructions: null
        }
      }
    });
    expect(await database.getSessionByTopic(-1001, 782)).toMatchObject({
      preferredMode: "plan"
    });
    expect(telegram.sentMessages.at(-1)?.text).toBe("Plan mode enabled");
    expect(getReplyKeyboardRows(telegram.sentMessages.at(-1))).toEqual([]);
  });

  it("preserves image attachments for topic /plan turns started from an image caption", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 783,
      messageId: 19,
      updateId: 29,
      userId: 42,
      text: "Set up the topic"
    });

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await waitForAsyncNotifications();

    await bridge.handleUserMessage({
      chatId: -1001,
      topicId: 783,
      messageId: 20,
      updateId: 30,
      userId: 42,
      text: "/plan sketch the migration",
      input: [
        {
          type: "text",
          text: "/plan sketch the migration",
          text_elements: []
        },
        {
          type: "telegramImage",
          fileId: "photo-topic-plan",
          fileName: "topic-plan.png",
          mimeType: "image/png"
        }
      ]
    });

    expect(telegram.downloads.at(-1)).toEqual({ fileId: "photo-topic-plan" });
    expect(codex.turns.at(-1)).toMatchObject({
      threadId: "thread-1",
      text: "sketch the migration",
      turnId: "turn-2"
    });
    expect(codex.turns.at(-1)?.input[0]).toEqual({
      type: "text",
      text: "sketch the migration",
      text_elements: []
    });
    expect(codex.turns.at(-1)?.input[1]?.type).toBe("localImage");
  });

  it("retains Telegram images until the turn completes", async () => {
    await bridge.handleUserMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 11,
      updateId: 22,
      userId: 42,
      text: "Check this screenshot",
      input: [
        {
          type: "text",
          text: "Check this screenshot",
          text_elements: []
        },
        {
          type: "telegramImage",
          fileId: "photo-1",
          fileName: "screenshot.png",
          mimeType: "image/png"
        }
      ]
    });

    expect(telegram.downloads).toEqual([{ fileId: "photo-1" }]);
    expect(codex.turns).toHaveLength(1);
    expect(codex.turns[0]?.input[0]).toEqual({
      type: "text",
      text: "Check this screenshot",
      text_elements: []
    });
    expect(codex.turns[0]?.input[1]?.type).toBe("localImage");
    const localImage = codex.turns[0]?.input[1];
    expect(localImage && "path" in localImage ? existsSync(localImage.path) : false).toBe(true);

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await waitForAsyncNotifications();

    expect(localImage && "path" in localImage ? existsSync(localImage.path) : true).toBe(false);
  });

  it("cleans up Telegram images immediately when turn submission fails", async () => {
    codex.nextSendTurnError = new Error("turn start failed");

    await bridge.handleUserMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 11,
      updateId: 22,
      userId: 42,
      text: "Check this screenshot",
      input: [
        {
          type: "text",
          text: "Check this screenshot",
          text_elements: []
        },
        {
          type: "telegramImage",
          fileId: "photo-1",
          fileName: "screenshot.png",
          mimeType: "image/png"
        }
      ]
    });

    expect(telegram.downloads).toEqual([{ fileId: "photo-1" }]);
    expect(codex.turns).toHaveLength(0);
    expect(readdirSync(config.telegram.mediaTempDir)).toEqual([]);
    expect(telegram.sentMessages.at(-1)?.text).toContain("turn start failed");
  });

  it("releases retained Telegram images when the turn fails", async () => {
    await bridge.handleUserMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 11,
      updateId: 22,
      userId: 42,
      text: "Check this screenshot",
      input: [
        {
          type: "text",
          text: "Check this screenshot",
          text_elements: []
        },
        {
          type: "telegramImage",
          fileId: "photo-1",
          fileName: "screenshot.png",
          mimeType: "image/png"
        }
      ]
    });

    const localImage = codex.turns[0]?.input[1];
    expect(localImage && "path" in localImage ? existsSync(localImage.path) : false).toBe(true);

    codex.emitNotification({
      method: "error",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        willRetry: false,
        error: {
          message: "vision failed"
        }
      }
    } as ServerNotification);
    await waitForAsyncNotifications();

    expect(localImage && "path" in localImage ? existsSync(localImage.path) : true).toBe(false);
  });

  it("does not fail a turn on retryable error notifications", async () => {
    codex.readTurnMessagesResult = "Recovered answer";

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 11,
      updateId: 22,
      userId: 42,
      text: "Keep going"
    });

    codex.emitNotification({
      method: "error",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        willRetry: true,
        error: {
          message: "temporary upstream issue"
        }
      }
    } as ServerNotification);
    await waitForAsyncNotifications();

    expect(telegram.sentMessages.some((message) => message.text.includes("Codex error: temporary upstream issue"))).toBe(false);

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await waitForAsyncNotifications();

    expect(getFinalAnswerMessage(telegram)?.text).toBe("Recovered answer");
  });

  it("finalizes turn/completed failed notifications as failed turns", async () => {
    codex.readTurnMessagesResult = "Partial answer";

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 11,
      updateId: 22,
      userId: 42,
      text: "Show the failure"
    });

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "failed",
          error: {
            message: "model crashed",
            codexErrorInfo: null,
            additionalDetails: null
          }
        }
      }
    });
    await waitForAsyncNotifications();

    expect(getFinalAnswerMessage(telegram)?.text).toContain("Codex error: model crashed");
  });

  it("dedupes failure terminalization when error is followed by failed completion", async () => {
    codex.readTurnMessagesResult = "Partial answer";

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 11,
      updateId: 22,
      userId: 42,
      text: "Fail once"
    });

    codex.emitNotification({
      method: "error",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        willRetry: false,
        error: {
          message: "vision failed"
        }
      }
    } as ServerNotification);
    await waitForAsyncNotifications();

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "failed",
          error: {
            message: "vision failed",
            codexErrorInfo: null,
            additionalDetails: null
          }
        }
      }
    });
    await waitForAsyncNotifications();

    expect(telegram.drafts.filter((message) => message.text.includes("Codex error: vision failed"))).toHaveLength(1);
    expect(getFinalAnswerMessage(telegram)?.text).toContain("Codex error: vision failed");
  });

  it("keeps status separate and only sends the final assistant message on completion", async () => {
    codex.reasoningEffort = "high";

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 10,
      updateId: 20,
      userId: 42,
      text: "Explain the fix"
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(telegram.drafts.at(-1)?.text).toBe("thinking · 0s");

    codex.emitNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "Working on it"
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(telegram.edits.some((edit) => edit.text === "Working on it")).toBe(false);
    expect(telegram.deletions).toHaveLength(1);
    expect(telegram.deletions[0]?.chatId).toBe(-1001);
    expect(getFinalAnswerMessage(telegram)?.text).toBe("Working on it");
    expect(telegram.sentMessages.at(-1)?.text).toBe("<1s • 100% left • /workspace • main • gpt-5-codex high");
    expect(telegram.sentMessages.at(-1)?.options?.entities).toEqual(
      preformattedEntities("<1s • 100% left • /workspace • main • gpt-5-codex high", "status")
    );
    expect(telegram.sentMessages.some((message) => message.text === "> done")).toBe(false);
    expect(getFinalAnswerMessage(telegram)?.text).toBe("Working on it");
  });

  it("uses streamed file-change items in the footer when the resolved snapshot still reports zero files", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 10,
      updateId: 21,
      userId: 42,
      text: "Edit the files"
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    codex.emitNotification({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "fileChange",
          id: "item-1",
          changes: [
            {
              path: "packages/kirbot-core/src/bridge.ts",
              kind: {
                type: "update",
                move_path: null
              },
              diff: ""
            },
            {
              path: "packages/kirbot-core/src/bridge/presentation.ts",
              kind: {
                type: "update",
                move_path: null
              },
              diff: ""
            }
          ],
          status: "inProgress"
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(telegram.sentMessages.at(-1)?.text).toBe("<1s • 100% left • 2 files • /workspace • main • gpt-5-codex");
    expect(telegram.sentMessages.at(-1)?.options?.entities).toEqual(
      preformattedEntities("<1s • 100% left • 2 files • /workspace • main • gpt-5-codex", "status")
    );
  });

  it("formats assistant markdown as Telegram entities for drafts and final messages", async () => {
    codex.readTurnMessagesResult = "Use **bold** and `code`.\n\n```ts\nconst answer = 42;\n```";

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 70,
      updateId: 80,
      userId: 42,
      text: "Format this output"
    });

    codex.emitNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "Use **bold** and `code`."
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const formattedMessage = getFinalAnswerMessage(telegram);
    expect(telegram.chatActions.some((action) => action.action === "typing")).toBe(true);
    expect(formattedMessage?.text).toBe("Use bold and code.\n\nconst answer = 42;");
    expect(formattedMessage?.options?.entities).toEqual([
      { type: "bold", offset: 4, length: 4 },
      { type: "code", offset: 13, length: 4 },
      { type: "pre", offset: 20, length: 18, language: "ts" }
    ]);
  });

  it("keeps the final message available when an intermediate edit rejects entities", async () => {
    codex.readTurnMessagesResult = "Use **bold** and `code`.";

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 74,
      updateId: 84,
      userId: 42,
      text: "Format this output"
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    telegram.nextEditMessageTextError = {
      error_code: 429,
      parameters: {
        retry_after: 0
      }
    } as unknown as Error;

    codex.emitNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "Use **bold** and `code`."
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await waitForCondition(() => getFinalAnswerMessage(telegram)?.text === "Use bold and code.", 3_000);

    expect(getFinalAnswerMessage(telegram)?.text).toBe("Use bold and code.");
    expect(getFinalAnswerMessage(telegram)?.options?.entities).toEqual([
      { type: "bold", offset: 4, length: 4 },
      { type: "code", offset: 13, length: 4 }
    ]);
  });

  it("keeps commentary out of the status draft and attaches a Mini App button to the final answer", async () => {
    const miniAppConfig: AppConfig = {
      ...config,
      telegram: {
        ...config.telegram,
        miniApp: {
          publicUrl: "https://example.com/mini-app"
        }
      }
    };
    const miniAppCodex = new FakeCodex();
    const miniAppTelegram = new FakeTelegram();
    const miniAppBridge = new TelegramCodexBridge(miniAppConfig, database, miniAppTelegram, miniAppCodex, mediaStore, console, {
      messengerDeliveryPolicy: ZERO_SPACING_DELIVERY_POLICY
    });

    await miniAppBridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 71,
      updateId: 81,
      userId: 42,
      text: "Summarize the change"
    });

    miniAppCodex.emitNotification({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "item-1",
          text: "",
          phase: "commentary"
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const initialDraftCount = miniAppTelegram.appliedDrafts.length;

    miniAppCodex.emitNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "Inspecting the files"
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(miniAppTelegram.drafts.at(-1)?.text).toBe("thinking · 0s");
    expect(miniAppTelegram.drafts.at(-1)?.options?.entities).toBeUndefined();
    expect(miniAppTelegram.sentMessages.at(-1)?.text).not.toBe("Inspecting the files");
    expect(miniAppTelegram.appliedDrafts.length).toBe(initialDraftCount);
    expect(miniAppTelegram.appliedDrafts.some((draft) => draft.text.includes("\nNow:"))).toBe(false);

    miniAppCodex.emitNotification({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "item-2",
          text: "",
          phase: "final_answer"
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    miniAppCodex.emitNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-2",
        delta: "Here is the answer."
      }
    });
    miniAppCodex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await waitForCondition(
      () =>
        miniAppTelegram.drafts.some((message) => message.text === "Here is the answer.") ||
        miniAppTelegram.sentMessages.some((message) => message.text === "Here is the answer."),
      3_000
    );

    expect(miniAppTelegram.sentMessages.some((message) => message.text.startsWith("Commentary"))).toBe(false);
    const answerMessage =
      miniAppTelegram.drafts.find(
        (message) => message.text === "Here is the answer." && getInlineButtonTexts(message).length > 0
      ) ?? miniAppTelegram.sentMessages.find((message) => message.text === "Here is the answer.");
    expect(answerMessage?.text).toBe("Here is the answer.");
    expect(getInlineButtonTexts(answerMessage)).toEqual(["Response", "Commentary"]);
    const responseUrl = getWebAppUrlByButtonText(answerMessage, "Response");
    expect(responseUrl?.startsWith("https://example.com/mini-app/plan#d=")).toBe(true);
    const responseEncoded = getEncodedMiniAppArtifactFromHash(new URL(responseUrl!).hash);
    expect(decodeMiniAppArtifact(responseEncoded!)).toEqual({
      v: 1,
      type: MiniAppArtifactType.Response,
      title: "Response",
      markdownText: "Here is the answer."
    });
    const url = getWebAppUrlByButtonText(answerMessage, "Commentary");
    const encoded = getEncodedMiniAppArtifactFromHash(new URL(url!).hash);
    expect(decodeMiniAppArtifact(encoded!)).toEqual({
      v: 1,
      type: MiniAppArtifactType.Commentary,
      title: "Commentary",
      markdownText: "Inspecting the files"
    });
  });

  it("keeps failed command detail in commentary without sending a Telegram failure bubble", async () => {
    codex.readTurnSnapshotResult = {
      text: "Final answer",
      assistantText: "Final answer"
    };

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 74,
      updateId: 84,
      userId: 42,
      text: "Diagnose the failing tests"
    });

    codex.emitNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "npm test -- --runInBand",
          cwd: "/workspace/packages/kirbot-core",
          processId: null,
          status: "failed",
          commandActions: [],
          aggregatedOutput: 'FAIL bridge.test.ts\nError: expected "waiting · 6s" to equal "waiting · 5s"',
          exitCode: 1,
          durationMs: 12_000
        }
      }
    });
    await waitForAsyncNotifications();

    expect(
      telegram.sentMessages.some((message) =>
        message.text.includes('Command failed\nnpm test -- --runInBand')
      )
    ).toBe(false);

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await waitForAsyncNotifications();

    const answerMessage = getFinalAnswerMessage(telegram);
    expect(answerMessage?.text).toBe("Final answer");
    expect((answerMessage?.options as TelegramSendOptions | undefined)?.disable_notification).toBeUndefined();
    expect(getInlineButtonTexts(answerMessage)).toEqual(["Response", "Commentary"]);

    const commentaryUrl = getWebAppUrlByButtonText(answerMessage, "Commentary");
    const commentaryEncoded = getEncodedMiniAppArtifactFromHash(new URL(commentaryUrl!).hash);
    expect(decodeMiniAppArtifact(commentaryEncoded!)).toEqual({
      v: 1,
      type: MiniAppArtifactType.Commentary,
      title: "Commentary",
      markdownText:
        ':::details Logs (1)\n**Command failed**\n```\nnpm test -- --runInBand\n```\n\nCWD: `/workspace/packages/kirbot-core`  \nExit code: `1`  \nDuration: `12s`\n\nError\n> FAIL bridge.test.ts\n> Error: expected "waiting · 6s" to equal "waiting · 5s"\n:::'
    });
  });

  it("falls back to a standalone commentary stub when combined response and commentary buttons exceed the markup budget", async () => {
    const miniAppConfig: AppConfig = {
      ...config,
      telegram: {
        ...config.telegram,
        miniApp: {
          publicUrl: findSingleButtonSafeDualButtonUnsafeMiniAppUrl()
        }
      }
    };
    const miniAppCodex = new FakeCodex();
    miniAppCodex.readTurnMessagesResult = "Here is the answer.";
    const miniAppTelegram = new FakeTelegram();
    const miniAppBridge = new TelegramCodexBridge(miniAppConfig, database, miniAppTelegram, miniAppCodex, mediaStore, console, {
      messengerDeliveryPolicy: ZERO_SPACING_DELIVERY_POLICY
    });

    await miniAppBridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 72,
      updateId: 82,
      userId: 42,
      text: "Summarize the change"
    });

    miniAppCodex.emitNotification({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "item-1",
          text: "",
          phase: "commentary"
        }
      }
    });
    miniAppCodex.emitNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "Inspecting the files"
      }
    });
    miniAppCodex.emitNotification({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "item-2",
          text: "",
          phase: "final_answer"
        }
      }
    });
    miniAppCodex.emitNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-2",
        delta: "Here is the answer."
      }
    });
    miniAppCodex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await waitForAsyncNotifications();

    const answerMessage = miniAppTelegram.drafts.find((message) => message.text === "Here is the answer.");
    expect(answerMessage?.text).toBe("Here is the answer.");
    expect((answerMessage?.options as TelegramSendOptions | undefined)?.disable_notification).toBeUndefined();
    expect(getInlineButtonTexts(answerMessage)).toEqual(["Response"]);

    const commentaryStub = miniAppTelegram.sentMessages.find((message) => message.text === "Commentary is available");
    expect((commentaryStub?.options as TelegramSendOptions | undefined)?.disable_notification).toBe(true);
    expect(getInlineButtonTexts(commentaryStub)).toEqual(["Commentary"]);
    expect(miniAppTelegram.drafts.findIndex((message) => message.text === "Here is the answer.")).toBeLessThan(
      miniAppTelegram.drafts.findIndex((message) => message.text === "Commentary is available")
    );
  });

  it("truncates long final assistant output into one Telegram message with a response button", async () => {
    codex.readTurnMessagesResult = longText("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu", 90);

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 10,
      updateId: 20,
      userId: 42,
      text: "Explain the fix"
    });

    codex.emitNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "streaming started"
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(telegram.sentMessages.some((message) => message.text.startsWith("Part "))).toBe(false);
    const answerMessage = getFinalAnswerMessage(telegram);
    expect(answerMessage?.text).toContain("[response truncated, continue in View]");
    expect(answerMessage?.text.length).toBeLessThanOrEqual(4000);
    expect(getInlineButtonTexts(answerMessage)).toEqual(["Response"]);
    const responseUrl = getWebAppUrlByButtonText(answerMessage, "Response");
    const encoded = getEncodedMiniAppArtifactFromHash(new URL(responseUrl!).hash);
    expect(decodeMiniAppArtifact(encoded!)).toEqual({
      v: 1,
      type: MiniAppArtifactType.Response,
      title: "Response",
      markdownText: longText("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu", 90)
    });
  });

  it("attaches response and commentary Mini App buttons to a truncated long final answer", async () => {
    const miniAppConfig: AppConfig = {
      ...config,
      telegram: {
        ...config.telegram,
        miniApp: {
          publicUrl: "https://example.com/mini-app"
        }
      }
    };
    const miniAppCodex = new FakeCodex();
    miniAppCodex.readTurnMessagesResult = longText(
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu",
      90
    );
    const miniAppTelegram = new FakeTelegram();
    const miniAppBridge = new TelegramCodexBridge(miniAppConfig, database, miniAppTelegram, miniAppCodex, mediaStore, console, {
      messengerDeliveryPolicy: ZERO_SPACING_DELIVERY_POLICY
    });

    await miniAppBridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 11,
      updateId: 21,
      userId: 42,
      text: "Explain the fix"
    });

    miniAppCodex.emitNotification({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "item-1",
          text: "",
          phase: "commentary"
        }
      }
    });
    miniAppCodex.emitNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "Inspecting files"
      }
    });
    miniAppCodex.emitNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "item-1",
          text: "Inspecting files",
          phase: "commentary"
        }
      }
    });
    miniAppCodex.emitNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-2",
        delta: "streaming started"
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    miniAppCodex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await waitForCondition(
      () => miniAppTelegram.drafts.some((message) => message.text.includes("[response truncated, continue in View]")),
      3_000
    );

    expect(miniAppTelegram.sentMessages.some((message) => message.text.startsWith("Commentary"))).toBe(false);
    expect(miniAppTelegram.sentMessages.some((message) => message.text.startsWith("Part "))).toBe(false);
    const answerMessage =
      miniAppTelegram.drafts.find(
        (message) => message.text.includes("[response truncated, continue in View]") && getInlineButtonTexts(message).length > 0
      ) ?? miniAppTelegram.sentMessages.find((message) => message.text.includes("[response truncated, continue in View]"));
    expect(answerMessage?.text).toContain("[response truncated, continue in View]");
    expect(getInlineButtonTexts(answerMessage)).toEqual(["Response", "Commentary"]);
  });

  it("keeps oversized assistant deltas out of the visible status bubble", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 10,
      updateId: 20,
      userId: 42,
      text: "Explain the fix"
    });

    codex.emitNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: longText("chunked draft preview content", 180)
      }
    });
    await waitForAsyncNotifications();

    expect(telegram.drafts.some((draft) => draft.text.includes("[preview truncated]"))).toBe(false);
    expect(telegram.drafts.at(-1)?.text).toBe("thinking · 0s");
  });

  it("does not fold oversized commentary into the live status draft", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 72,
      updateId: 82,
      userId: 42,
      text: "Think out loud"
    });

    codex.emitNotification({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "item-1",
          text: "",
          phase: "commentary"
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    codex.emitNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: longText("commentary content", 180)
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(telegram.drafts.length).toBeGreaterThan(0);
    expect(telegram.drafts.at(-1)?.text).toBe("thinking · 0s");
    expect(telegram.drafts.at(-1)?.options?.entities).toBeUndefined();
  });

  it("combines commentary items into one Mini App artifact on the final answer", async () => {
    const miniAppConfig: AppConfig = {
      ...config,
      telegram: {
        ...config.telegram,
        miniApp: {
          publicUrl: "https://example.com/mini-app"
        }
      }
    };
    const miniAppCodex = new FakeCodex();
    miniAppCodex.readTurnSnapshotResult = {
      text: "Final answer",
      assistantText: "Final answer"
    };
    const miniAppTelegram = new FakeTelegram();
    const miniAppBridge = new TelegramCodexBridge(miniAppConfig, database, miniAppTelegram, miniAppCodex, mediaStore, console, {
      messengerDeliveryPolicy: ZERO_SPACING_DELIVERY_POLICY
    });

    await miniAppBridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 73,
      updateId: 83,
      userId: 42,
      text: "Narrate the work"
    });

    miniAppCodex.emitNotification({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "item-1",
          text: "",
          phase: "commentary"
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    miniAppCodex.emitNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "Inspecting files"
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    miniAppCodex.emitNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "item-1",
          text: "Inspecting files",
          phase: "commentary"
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    miniAppCodex.emitNotification({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "item-2",
          text: "",
          phase: "commentary"
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    miniAppCodex.emitNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-2",
        delta: "Planning edits"
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    miniAppCodex.emitNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "item-2",
          text: "Planning edits",
          phase: "commentary"
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(miniAppTelegram.sentMessages.some((message) => message.text.includes("Inspecting files"))).toBe(false);

    miniAppCodex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(miniAppTelegram.sentMessages.some((message) => message.text.startsWith("Commentary"))).toBe(false);
    const answerMessage = getFinalAnswerMessage(miniAppTelegram);
    expect(answerMessage?.text).toBe("Final answer");
    expect(getInlineButtonTexts(answerMessage)).toEqual(["Response", "Commentary"]);
    const responseUrl = getWebAppUrlByButtonText(answerMessage, "Response");
    const responseEncoded = getEncodedMiniAppArtifactFromHash(new URL(responseUrl!).hash);
    expect(decodeMiniAppArtifact(responseEncoded!)).toEqual({
      v: 1,
      type: MiniAppArtifactType.Response,
      title: "Response",
      markdownText: "Final answer"
    });
    const url = getWebAppUrlByButtonText(answerMessage, "Commentary");
    const encoded = getEncodedMiniAppArtifactFromHash(new URL(url!).hash);
    expect(decodeMiniAppArtifact(encoded!)).toEqual({
      v: 1,
      type: MiniAppArtifactType.Commentary,
      title: "Commentary",
      markdownText: "Inspecting files\n\nPlanning edits"
    });
  });

  it("publishes plan items as Mini App stubs instead of raw plan bubbles", async () => {
    const miniAppConfig: AppConfig = {
      ...config,
      telegram: {
        ...config.telegram,
        miniApp: {
          publicUrl: "https://example.com/mini-app"
        }
      }
    };
    const miniAppCodex = new FakeCodex();
    const miniAppTelegram = new FakeTelegram();
    const miniAppBridge = new TelegramCodexBridge(miniAppConfig, database, miniAppTelegram, miniAppCodex, mediaStore, console, {
      messengerDeliveryPolicy: ZERO_SPACING_DELIVERY_POLICY
    });

    await miniAppBridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 788,
      messageId: 300,
      updateId: 400,
      userId: 42,
      text: "Plan the rollout"
    });

    miniAppCodex.emitNotification({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "plan",
          id: "plan-1",
          text: ""
        }
      }
    });
    miniAppCodex.emitNotification({
      method: "item/plan/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "plan-1",
        delta: "Draft the rollout"
      }
    });
    await waitForAsyncNotifications();

    expect(miniAppTelegram.drafts.some((draft) => draft.text === "Plan\n\nDraft the rollout")).toBe(false);

    miniAppCodex.emitNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "plan",
          id: "plan-1",
          text: "1. Draft the rollout"
        }
      }
    });
    miniAppCodex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await waitForAsyncNotifications();

    expect(miniAppTelegram.sentMessages.filter((message) => message.text === "Plan is ready")).toHaveLength(1);
    expect(miniAppTelegram.sentMessages.some((message) => message.text === "Plan\n\n1. Draft the rollout")).toBe(false);
    const stub = miniAppTelegram.sentMessages.find((message) => message.text === "Plan is ready");
    expect(stub?.options?.disable_notification).toBeUndefined();
    expect(getInlineButtonTexts(stub)).toEqual(["Plan", "Implement"]);
    const url = getWebAppUrlByButtonText(stub, "Plan");
    expect(url).toBeTruthy();
    expect(url?.startsWith("https://example.com/mini-app/plan#d=")).toBe(true);
    expect(getCallbackDataByButtonText(stub, "Implement")).toBe(TOPIC_IMPLEMENT_CALLBACK_DATA);
    const encoded = getEncodedMiniAppArtifactFromHash(new URL(url!).hash);
    expect(encoded).toBeTruthy();
    expect(decodeMiniAppArtifact(encoded!)).toEqual({
      v: 1,
      type: MiniAppArtifactType.Plan,
      title: "Plan",
      markdownText: "1. Draft the rollout"
    });
  });

  it("splits large plan artifacts into multiple Mini App stubs instead of Telegram plan bubbles", async () => {
    const oversizeMiniAppConfig: AppConfig = {
      ...config,
      telegram: {
        ...config.telegram,
        miniApp: {
          publicUrl: "https://example.com/mini-app"
        }
      }
    };
    const oversizeMiniAppCodex = new FakeCodex();
    const oversizeMiniAppTelegram = new FakeTelegram();
    const oversizeMiniAppBridge = new TelegramCodexBridge(
      oversizeMiniAppConfig,
      database,
      oversizeMiniAppTelegram,
      oversizeMiniAppCodex,
      mediaStore,
      console,
      {
        messengerDeliveryPolicy: ZERO_SPACING_DELIVERY_POLICY
      }
    );
    const longPlan = Array.from({ length: 250 }, (_, index) =>
      `${index + 1}. ${Array.from({ length: 20 }, (__unused, wordIndex) => `token-${index}-${wordIndex}`).join(" ")}`
    ).join("\n");

    await oversizeMiniAppBridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 788,
      messageId: 302,
      updateId: 402,
      userId: 42,
      text: "Plan the rollout"
    });

    oversizeMiniAppCodex.emitNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "plan",
          id: "plan-1",
          text: longPlan
        }
      }
    });
    oversizeMiniAppCodex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await waitForAsyncNotifications();

    const planMessages = oversizeMiniAppTelegram.sentMessages.filter((message) => message.text.startsWith("Plan"));
    expect(planMessages.length).toBeGreaterThan(1);
    expect(planMessages.some((message) => message.text === "Plan artifact was too large to encode")).toBe(false);
    expect(
      oversizeMiniAppTelegram.sentMessages.some((message) => message.text.startsWith("Plan\n\n"))
    ).toBe(false);
    expect(getCallbackDataByButtonText(planMessages.at(-1), "Implement")).toBe(TOPIC_IMPLEMENT_CALLBACK_DATA);
    expect(planMessages.slice(0, -1).every((message) => getCallbackDataByButtonText(message, "Implement") === null)).toBe(true);
  });

  it("publishes a standalone commentary stub before completed plan artifacts when no assistant answer follows", async () => {
    const miniAppConfig: AppConfig = {
      ...config,
      telegram: {
        ...config.telegram,
        miniApp: {
          publicUrl: "https://example.com/mini-app"
        }
      }
    };
    const miniAppCodex = new FakeCodex();
    const miniAppTelegram = new FakeTelegram();
    const miniAppBridge = new TelegramCodexBridge(miniAppConfig, database, miniAppTelegram, miniAppCodex, mediaStore, console, {
      messengerDeliveryPolicy: ZERO_SPACING_DELIVERY_POLICY
    });

    await miniAppBridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 789,
      messageId: 301,
      updateId: 401,
      userId: 42,
      text: "Plan the rollout"
    });

    miniAppCodex.emitNotification({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "item-1",
          text: "",
          phase: "commentary"
        }
      }
    });
    miniAppCodex.emitNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "Inspecting files"
      }
    });
    miniAppCodex.emitNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "item-1",
          text: "Inspecting files",
          phase: "commentary"
        }
      }
    });
    miniAppCodex.emitNotification({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "plan",
          id: "plan-1",
          text: ""
        }
      }
    });
    miniAppCodex.emitNotification({
      method: "item/plan/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "plan-1",
        delta: "Draft the rollout"
      }
    });
    miniAppCodex.emitNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "plan",
          id: "plan-1",
          text: "1. Draft the rollout"
        }
      }
    });
    miniAppCodex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await waitForAsyncNotifications();

    const commentaryStub = miniAppTelegram.sentMessages.find((message) => message.text === "Commentary is available");
    expect(commentaryStub).toBeTruthy();
    expect(getInlineButtonTexts(commentaryStub)).toEqual(["Commentary"]);
    const url = getWebAppUrlByButtonText(commentaryStub, "Commentary");
    const encoded = getEncodedMiniAppArtifactFromHash(new URL(url!).hash);
    expect(decodeMiniAppArtifact(encoded!)).toEqual({
      v: 1,
      type: MiniAppArtifactType.Commentary,
      title: "Commentary",
      markdownText: "Inspecting files"
    });
    const planIndex = miniAppTelegram.sentMessages.findIndex((message) => message.text.startsWith("Plan"));
    expect(planIndex).toBeGreaterThanOrEqual(0);
    expect(miniAppTelegram.sentMessages.findIndex((message) => message.text === "Commentary is available")).toBeLessThan(planIndex);
  });

  it("publishes a non-blocking notice when the response artifact is too large to encode", async () => {
    const oversizeMiniAppConfig: AppConfig = {
      ...config,
      telegram: {
        ...config.telegram,
        miniApp: {
          publicUrl: `https://example.com/${"mini-app/".repeat(1_500)}`
        }
      }
    };
    const finalAnswer = longText("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu", 90);
    const oversizeMiniAppCodex = new FakeCodex();
    oversizeMiniAppCodex.readTurnSnapshotResult = {
      text: finalAnswer,
      assistantText: finalAnswer
    };
    const oversizeMiniAppTelegram = new FakeTelegram();
    const oversizeMiniAppBridge = new TelegramCodexBridge(
      oversizeMiniAppConfig,
      database,
      oversizeMiniAppTelegram,
      oversizeMiniAppCodex,
      mediaStore,
      console,
      {
        messengerDeliveryPolicy: ZERO_SPACING_DELIVERY_POLICY
      }
    );

    await oversizeMiniAppBridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 76,
      updateId: 86,
      userId: 42,
      text: "Explain the fix"
    });

    oversizeMiniAppCodex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await waitForAsyncNotifications();

    const answerMessage = oversizeMiniAppTelegram.drafts.find((message) => message.text.includes("[response truncated]"));
    expect(answerMessage?.text).toContain("[response truncated]");
    expect(getInlineButtonTexts(answerMessage)).toEqual([]);
    expect(
      oversizeMiniAppTelegram.sentMessages.some((message) => message.text === "Response artifact was too large to encode")
    ).toBe(true);
  });

  it("sends the final persisted message as a separate assistant bubble and deletes the status bubble", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 10,
      updateId: 25,
      userId: 42,
      text: "Explain the fix"
    });

    codex.emitNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "Hello"
      }
    });
    await waitForAsyncNotifications();

    codex.emitNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: " world"
      }
    });
    await waitForAsyncNotifications();

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await waitForAsyncNotifications();

    expect(telegram.edits.some((edit) => edit.text === "Hello")).toBe(false);
    expect(telegram.edits.some((edit) => edit.text === "Hello world")).toBe(false);
    expect(telegram.deletions).toHaveLength(1);
    expect(telegram.deletions[0]?.chatId).toBe(-1001);
    expect(getFinalAnswerMessage(telegram)?.text).toBe("Hello world");
  });

  it("renders multiple assistant items with separators instead of concatenating them", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 11,
      updateId: 24,
      userId: 42,
      text: "Check the setup"
    });

    codex.emitNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "That setup"
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    codex.emitNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-2",
        delta: "Yes makes sense"
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getFinalAnswerMessage(telegram)?.text).toBe("That setup\n\nYes makes sense");
  });

  it("reconciles streamed assistant text with the full completed item text", async () => {
    codex.readTurnMessagesResult = "Start from the inside.";

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 16,
      updateId: 29,
      userId: 42,
      text: "Explain it end to end"
    });

    codex.emitNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "from the inside."
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    codex.emitNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "item-1",
          text: "Start from the inside.",
          phase: null
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getFinalAnswerMessage(telegram)?.text).toBe("Start from the inside.");
  });

  it("uses Codex thread readback as the final message when streamed text is out of order", async () => {
    codex.readTurnMessagesResult = "Hello from the inside.";

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 17,
      updateId: 30,
      userId: 42,
      text: "Say hello"
    });

    codex.emitNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-2",
        delta: "from the inside."
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    codex.emitNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "Hello "
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getFinalAnswerMessage(telegram)?.text).toBe("Hello from the inside.");
  });

  it("keeps command status drafts minimal before assistant text arrives", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 10,
      updateId: 22,
      userId: 42,
      text: "Inspect the flaky command"
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 600));
    codex.emitNotification({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "commandExecution",
          id: "item-1",
          command: "npm test",
          cwd: "/workspace",
          processId: null,
          status: "inProgress",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await waitForCondition(() => telegram.drafts.some((draft) => draft.text === "running · 0s"));
    expect(telegram.drafts.some((draft) => draft.text === "running · 0s" && !draft.options?.entities)).toBe(true);
    expect(telegram.chatActions.some((action) => action.action === "typing")).toBe(true);
  });

  it("keeps editing status drafts minimal before assistant text arrives", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 10,
      updateId: 22,
      userId: 42,
      text: "Inspect the edited files"
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 600));

    codex.emitNotification({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "fileChange",
          id: "item-1",
          changes: [
            {
              path: "packages/kirbot-core/src/bridge/presentation.ts",
              kind: {
                type: "update",
                move_path: null
              },
              diff: ""
            }
          ],
          status: "inProgress"
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await waitForCondition(() => telegram.drafts.some((draft) => draft.text === "editing · 0s"));
    expect(telegram.drafts.some((draft) => draft.text === "editing · 0s" && !draft.options?.entities)).toBe(true);
  });

  it("keeps a stable status draft and sends the final text separately when no assistant delta arrives", async () => {
    codex.readTurnMessagesResult = "Completed without streamed deltas";

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 10,
      updateId: 23,
      userId: 42,
      text: "Finish quietly"
    });

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getFinalAnswerMessage(telegram)?.text).toBe("Completed without streamed deltas");
  });

  it("tracks a follow-up as a pending steer until the committed user item arrives", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 12,
      updateId: 25,
      userId: 42,
      text: "Inspect the current failure"
    });

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 13,
      updateId: 26,
      userId: 42,
      text: "Also check the deploy logs"
    });

    expect(codex.turns).toHaveLength(1);
    expect(codex.steerCalls).toEqual([
      {
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        text: "Also check the deploy logs"
      }
    ]);

    const previewMessageId = telegram.sentMessages.at(-1)?.messageId;
    expect(telegram.sentMessages.at(-1)?.text).toBe("Queued for current turn:\n- Also check the deploy logs");

    codex.emitNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "userMessage",
          id: "item-user-1",
          content: [
            {
              type: "text",
              text: "Also check the deploy logs",
              text_elements: []
            }
          ]
        }
      }
    });
    await waitForCondition(() => telegram.deletions.length === (previewMessageId ? 1 : 0));

    expect(telegram.deletions).toEqual(
      previewMessageId ? [{ chatId: -1001, messageId: previewMessageId }] : []
    );
  });

  it("tracks an image follow-up as a pending steer until the committed user item arrives", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 12,
      updateId: 125,
      userId: 42,
      text: "Inspect the current failure"
    });

    await bridge.handleUserMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 13,
      updateId: 126,
      userId: 42,
      text: "",
      input: [
        {
          type: "telegramImage",
          fileId: "photo-follow-up",
          fileName: "deploy.png",
          mimeType: "image/png"
        }
      ]
    });

    expect(telegram.sentMessages.at(-1)?.text).toBe("Queued for current turn:\n- [Image]");
    const localImage = codex.steerCalls[0]?.input[0];
    expect(localImage?.type).toBe("localImage");
    expect(localImage && "path" in localImage ? existsSync(localImage.path) : false).toBe(true);

    const previewMessageId = telegram.sentMessages.at(-1)?.messageId;
    codex.emitNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "userMessage",
          id: "item-user-image-1",
          content: localImage && "path" in localImage ? [{ type: "localImage", path: localImage.path }] : []
        }
      }
    });
    await waitForCondition(() => telegram.deletions.length === (previewMessageId ? 1 : 0));

    expect(telegram.deletions).toEqual(
      previewMessageId ? [{ chatId: -1001, messageId: previewMessageId }] : []
    );
    expect(localImage && "path" in localImage ? existsSync(localImage.path) : false).toBe(true);

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await waitForAsyncNotifications();

    expect(localImage && "path" in localImage ? existsSync(localImage.path) : true).toBe(false);
  });

  it("queues a follow-up for the next turn when steer loses the active-turn race", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 14,
      updateId: 27,
      userId: 42,
      actorLabel: "Jeremy",
      text: "Inspect the current failure"
    });

    codex.nextSteerError = new JsonRpcMethodError("turn/steer", 1, {
      code: -32600,
      message: "expectedTurnId does not match the current active turn",
      data: {
        kind: "invalid_active_turn"
      }
    });

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 15,
      updateId: 28,
      userId: 42,
      actorLabel: "Jeremy",
      text: "Start the next step"
    });

    expect(codex.steerCalls).toEqual([
      {
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        text: "Start the next step"
      }
    ]);
    expect(codex.turns).toEqual([
      {
        threadId: "thread-1",
        text: "Inspect the current failure",
        turnId: "turn-1"
      }
    ]);
    expect(telegram.edits.at(-1)?.text).toBe("Queued for next turn:\n- Jeremy: Start the next step");

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(codex.turns).toEqual([
      {
        threadId: "thread-1",
        text: "Inspect the current failure",
        turnId: "turn-1"
      },
      {
        threadId: "thread-1",
        text: "Start the next step",
        turnId: "turn-2"
      }
    ]);
  });

  it("collapses repeated queue-preview churn to the latest visible preview text for one message", async () => {
    const previewTelegram = new FakeTelegram();
    const previewCodex = new FakeCodex();
    const previewDatabase = new BridgeDatabase(join(tempDir, "preview-bridge.sqlite"));
    await previewDatabase.migrate();
    const previewBridge = new TelegramCodexBridge(
      config,
      previewDatabase,
      previewTelegram,
      previewCodex,
      mediaStore,
      console,
      {
        messengerDeliveryPolicy: {
          ...ZERO_SPACING_DELIVERY_POLICY,
          visibleEditSpacingMs: 100
        }
      }
    );

    await previewBridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 14,
      updateId: 27,
      userId: 42,
      text: "Inspect the current failure"
    });

    await previewBridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 15,
      updateId: 28,
      userId: 42,
      text: "First follow-up"
    });

    const previewMessageId = previewTelegram.sentMessages.findLast((message) =>
      message.text.startsWith("Queued for current turn:")
    )?.messageId;
    expect(previewMessageId).toBeDefined();

    const blockedEdit = deferred<void>();
    previewTelegram.editBlocks.push(blockedEdit.promise);

    const secondFollowUp = previewBridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 16,
      updateId: 29,
      userId: 42,
      text: "Second follow-up"
    });
    await waitForCondition(() => previewTelegram.edits.some((edit) => edit.text.includes("Second follow-up")));

    const thirdFollowUp = previewBridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 17,
      updateId: 30,
      userId: 42,
      text: "Third follow-up"
    });
    const fourthFollowUp = previewBridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 18,
      updateId: 31,
      userId: 42,
      text: "Fourth follow-up"
    });

    blockedEdit.resolve();
    await Promise.all([secondFollowUp, thirdFollowUp, fourthFollowUp]);

    const previewEdits = previewTelegram.edits.filter((edit) => edit.messageId === previewMessageId);
    expect(previewEdits[0]?.text).toBe("Queued for current turn:\n- First follow-up\n- Second follow-up");
    expect(previewEdits.at(-1)?.text).toBe(
      "Queued for current turn:\n- First follow-up\n- Second follow-up\n- Third follow-up\n- …and 1 more"
    );
    expect(
      new Set(previewEdits.map((edit) => edit.messageId))
    ).toEqual(new Set([previewMessageId]));

    await previewDatabase.close();
  });

  it("keeps queue-preview cleanup deletes best effort without blocking final visible sends", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 19,
      updateId: 32,
      userId: 42,
      text: "Inspect the current failure"
    });

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 20,
      updateId: 33,
      userId: 42,
      text: "Queued follow-up"
    });
    const previewMessageId = telegram.sentMessages.findLast((message) =>
      message.text.startsWith("Queued for current turn:")
    )?.messageId;
    expect(previewMessageId).toBeDefined();

    codex.readTurnSnapshotResult = {
      assistantText: "Final answer",
      text: "Final answer",
      planText: "",
      cwd: "/workspace",
      branch: "main",
      changedFiles: 0
    };

    const blockedDelete = deferred<void>();
    telegram.deleteBlocks.push(blockedDelete.promise);

    codex.emitNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "userMessage",
          id: "item-user-queued",
          content: [
            {
              type: "text",
              text: "Queued follow-up",
              text_elements: []
            }
          ]
        }
      }
    });
    await Promise.resolve();

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });

    await waitForCondition(() =>
      telegram.sentMessages.some((message) => message.text === "Final answer") ||
      telegram.drafts.some((draft) => draft.text === "Final answer")
    );
    expect(telegram.deletions.some((deletion) => deletion.messageId === previewMessageId)).toBe(false);

    blockedDelete.resolve(undefined as unknown as void);
    await waitForCondition(() => telegram.deletions.some((deletion) => deletion.messageId === previewMessageId));

    expect(telegram.sentMessages.some((message) => message.text === "Final answer")).toBe(true);
    expect(telegram.deletions.some((deletion) => deletion.messageId === previewMessageId)).toBe(true);
  });

  it("routes queue-preview cleanup deletes through TelegramMessenger retries", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 21,
      updateId: 34,
      userId: 42,
      text: "Inspect the current failure"
    });

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 22,
      updateId: 35,
      userId: 42,
      text: "Queued follow-up"
    });
    const previewMessageId = telegram.sentMessages.findLast((message) =>
      message.text.startsWith("Queued for current turn:")
    )?.messageId;
    expect(previewMessageId).toBeDefined();

    telegram.nextDeleteMessageError = rateLimitError(1);

    codex.emitNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "userMessage",
          id: "item-user-queued-retry",
          content: [
            {
              type: "text",
              text: "Queued follow-up",
              text_elements: []
            }
          ]
        }
      }
    });

    await waitForCondition(
      () => telegram.events.filter((event) => event === `delete:${previewMessageId}`).length >= 2,
      2_000
    );
  });

  it("supersedes stale queue-preview edits before preview cleanup deletes the message", async () => {
    vi.useFakeTimers();
    try {
      await bridge.handleUserTextMessage({
        chatId: -1001,
        topicId: 777,
        messageId: 23,
        updateId: 36,
        userId: 42,
        text: "Inspect the current failure"
      });

      await bridge.handleUserTextMessage({
        chatId: -1001,
        topicId: 777,
        messageId: 24,
        updateId: 37,
        userId: 42,
        text: "Queued follow-up"
      });
      const previewMessageId = telegram.sentMessages.findLast((message) =>
        message.text.startsWith("Queued for current turn:")
      )?.messageId;
      expect(previewMessageId).toBeDefined();

      telegram.nextEditMessageTextError = rateLimitError(1);

      const secondFollowUp = bridge.handleUserTextMessage({
        chatId: -1001,
        topicId: 777,
        messageId: 25,
        updateId: 38,
        userId: 42,
        text: "Second follow-up"
      });
      await Promise.resolve();

      codex.emitNotification({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "userMessage",
            id: "item-user-queued-cleanup",
            content: [
              {
                type: "text",
                text: "Queued follow-up",
                text_elements: []
              }
            ]
          }
        }
      });

      await vi.advanceTimersByTimeAsync(50);
      await waitForCondition(() => telegram.deletions.some((deletion) => deletion.messageId === previewMessageId));
      await expect(secondFollowUp).resolves.toBeUndefined();

      await vi.advanceTimersByTimeAsync(1_500);
      const previewEditEvents = telegram.events.filter((event) => event.startsWith(`edit:${previewMessageId}:`));
      expect(previewEditEvents).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects oversized steer input without queueing it for the next turn", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 18,
      updateId: 31,
      userId: 42,
      text: "Inspect the current failure"
    });

    codex.nextSteerError = new JsonRpcMethodError("turn/steer", 2, {
      code: -32602,
      message: "Input exceeds the maximum length of 10 characters.",
      data: {
        input_error_code: "input_too_large",
        max_chars: 10,
        actual_chars: 18
      }
    });

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 19,
      updateId: 32,
      userId: 42,
      text: "This follow-up is too long"
    });

    expect(codex.turns).toEqual([
      {
        threadId: "thread-1",
        text: "Inspect the current failure",
        turnId: "turn-1"
      }
    ]);
    expect(telegram.sentMessages.at(-1)?.text).toBe(
      "Codex rejected the follow-up because it exceeds the maximum input length (18/10 characters)."
    );
    const previewMessageId = telegram.sentMessages.find((message) =>
      message.text === "Queued for current turn:\n- This follow-up is too long"
    )?.messageId;
    expect(
      telegram.edits.some((edit) => edit.text.includes("Queued for next turn")) ||
        telegram.sentMessages.some((message) => message.text.includes("Queued for next turn"))
    ).toBe(false);
    await waitForCondition(() => telegram.deletions.length === (previewMessageId ? 1 : 0));
    expect(telegram.deletions).toEqual(
      previewMessageId ? [{ chatId: -1001, messageId: previewMessageId }] : []
    );

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(codex.turns).toHaveLength(1);
  });

  it("shows a send-now control for pending steers on the active turn", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 40,
      updateId: 50,
      userId: 42,
      text: "Inspect the current failure"
    });

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 41,
      updateId: 51,
      userId: 42,
      text: "Also check the deploy logs"
    });

    expect(telegram.sentMessages.at(-1)?.options?.reply_markup).toEqual({
      inline_keyboard: [[{ text: "Send now", callback_data: "turn:turn-1:sendNow" }]]
    });
  });

  it("does not send a separate stop control message for active turns", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 400,
      updateId: 500,
      userId: 42,
      text: "Inspect the current failure"
    });

    expect(telegram.sentMessages).toMatchObject([
      {
        chatId: -1001,
        text:
          "General stays shared for workspace-wide work. Use /thread to create a separate topic.\n<1s • 100% left • /workspace • main • gpt-5-codex",
        options: {
          message_thread_id: 777,
          entities: preformattedEntities("<1s • 100% left • /workspace • main • gpt-5-codex", "status").map(
            (entity) => ({
              ...entity,
              offset:
                entity.offset +
                "General stays shared for workspace-wide work. Use /thread to create a separate topic.\n".length
            })
          )
        }
      }
    ]);
  });

  it("invokes a custom command as a normal topic turn after the session is active", async () => {
    await database.createCustomCommand({
      command: "standup",
      prompt: "Draft the daily update."
    });

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 785,
      messageId: 401,
      updateId: 501,
      userId: 42,
      text: "Start the session"
    });

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await waitForAsyncNotifications();

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 785,
      messageId: 402,
      updateId: 502,
      userId: 42,
      text: "/standup"
    });

    expect(codex.turns.at(-1)).toMatchObject({
      threadId: "thread-1",
      text: "Draft the daily update."
    });
  });

  it("appends extra text when a custom command steers an active turn", async () => {
    await database.createCustomCommand({
      command: "standup",
      prompt: "Draft the daily update."
    });

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 786,
      messageId: 403,
      updateId: 503,
      userId: 42,
      text: "Start the session"
    });

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 786,
      messageId: 404,
      updateId: 504,
      userId: 42,
      text: "/standup blockers from yesterday"
    });

    expect(codex.steerCalls.at(-1)?.text).toBe("Draft the daily update.\n\nblockers from yesterday");
  });

  it("starts a topic session from a custom command in an unmapped topic", async () => {
    await database.createCustomCommand({
      command: "standup",
      prompt: "Draft the daily update."
    });

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 787,
      messageId: 405,
      updateId: 505,
      userId: 42,
      text: "/standup blockers from yesterday"
    });

    expect(codex.turns.at(-1)?.text).toBe("Draft the daily update.\n\nblockers from yesterday");
    expect(await database.getSessionByTopic(-1001, 787)).toBeDefined();
  });

  it("preserves image attachments when a custom command starts a turn from an unmapped topic", async () => {
    await database.createCustomCommand({
      command: "standup",
      prompt: "Draft the daily update."
    });

    await bridge.handleUserMessage({
      chatId: -1001,
      topicId: 788,
      messageId: 406,
      updateId: 506,
      userId: 42,
      text: "/standup blockers from yesterday",
      input: [
        {
          type: "text",
          text: "/standup blockers from yesterday",
          text_elements: []
        },
        {
          type: "telegramImage",
          fileId: "photo-custom-command-turn",
          fileName: "standup.png",
          mimeType: "image/png"
        }
      ]
    });

    expect(codex.turns.at(-1)?.text).toBe("Draft the daily update.\n\nblockers from yesterday");
    expect(codex.turns.at(-1)?.input[0]).toEqual({
      type: "text",
      text: "Draft the daily update.\n\nblockers from yesterday",
      text_elements: []
    });
    expect(codex.turns.at(-1)?.input[1]?.type).toBe("localImage");
    expect(await database.getSessionByTopic(-1001, 788)).toBeDefined();
  });

  it("preserves image attachments when a custom command steers an active turn", async () => {
    await database.createCustomCommand({
      command: "standup",
      prompt: "Draft the daily update."
    });

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 789,
      messageId: 407,
      updateId: 507,
      userId: 42,
      text: "Start the session"
    });

    await bridge.handleUserMessage({
      chatId: -1001,
      topicId: 789,
      messageId: 408,
      updateId: 508,
      userId: 42,
      text: "/standup blockers from yesterday",
      input: [
        {
          type: "text",
          text: "/standup blockers from yesterday",
          text_elements: []
        },
        {
          type: "telegramImage",
          fileId: "photo-custom-command-steer",
          fileName: "standup-steer.png",
          mimeType: "image/png"
        }
      ]
    });

    expect(codex.steerCalls.at(-1)?.text).toBe("Draft the daily update.\n\nblockers from yesterday");
    expect(codex.steerCalls.at(-1)?.input[0]).toEqual({
      type: "text",
      text: "Draft the daily update.\n\nblockers from yesterday",
      text_elements: []
    });
    expect(codex.steerCalls.at(-1)?.input[1]?.type).toBe("localImage");
  });

  it("invokes a custom command as a normal root turn after the root session is active", async () => {
    await database.createCustomCommand({
      command: "standup",
      prompt: "Draft the daily update."
    });

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 406,
      updateId: 506,
      userId: 42,
      text: "/standup blockers from yesterday"
    });

    expect(telegram.createdTopics).toHaveLength(0);
    expect(codex.createdThreads).toEqual(["Root Chat"]);
    expect(codex.turns).toEqual([
      {
        threadId: "thread-1",
        text: "Draft the daily update.\n\nblockers from yesterday",
        turnId: "turn-1"
      }
    ]);
  });

  it("rejects unknown slash commands during an active turn instead of steering", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 401,
      updateId: 501,
      userId: 42,
      text: "Inspect the current failure"
    });

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 402,
      updateId: 502,
      userId: 42,
      text: "/help"
    });

    expect(codex.steerCalls).toEqual([]);
    expect(telegram.sentMessages.at(-1)?.text).toBe("This command is not valid here");
  });

  it("rejects /plan while a turn is active instead of steering", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 783,
      messageId: 410,
      updateId: 510,
      userId: 42,
      text: "Inspect the current failure"
    });

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 783,
      messageId: 411,
      updateId: 511,
      userId: 42,
      text: "/plan"
    });

    expect(codex.steerCalls).toEqual([]);
    expect(telegram.sentMessages.at(-1)?.text).toBe(
      "Wait for the current response to finish or stop it first before changing modes"
    );
  });

  it("starts a default-mode implementation turn on the existing thread context", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 784,
      messageId: 412,
      updateId: 512,
      userId: 42,
      text: "Plan the rollout"
    });

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await waitForAsyncNotifications();

    await database.updateSessionPreferredMode(-1001, 784, "plan");

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 784,
      messageId: 413,
      updateId: 513,
      userId: 42,
      text: "/implement and keep the diff small"
    });

    expect(codex.turns.at(-1)?.text).toBe(["Implement the plan.", "", "Additional instructions:", "and keep the diff small"].join("\n"));
    expect(codex.turnCollaborationModes.at(-1)).toMatchObject({
      turnId: "turn-2",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5-codex",
          reasoning_effort: null,
          developer_instructions: null
        }
      }
    });
    expect(await database.getSessionByTopic(-1001, 784)).toMatchObject({
      preferredMode: "default"
    });
    expect(telegram.sentMessages.at(-1)?.text).toBe("Exited plan mode");
  });

  it("starts a default-mode implementation turn without requiring stored plan text", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 785,
      messageId: 414,
      updateId: 514,
      userId: 42,
      text: "Plan the rollout"
    });

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await waitForAsyncNotifications();

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 785,
      messageId: 415,
      updateId: 515,
      userId: 42,
      text: "/implement"
    });

    expect(codex.turns).toHaveLength(2);
    expect(codex.turns.at(-1)?.text).toBe("Implement the plan.");
    expect(codex.turnCollaborationModes.at(-1)).toEqual({
      turnId: "turn-2",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5-codex",
          reasoning_effort: null,
          developer_instructions: null
        }
      }
    });
    expect(telegram.sentMessages.at(-1)?.text).toBe("Exited plan mode");
  });

  it("preserves image attachments for /implement turns started from an image caption", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 790,
      messageId: 416,
      updateId: 516,
      userId: 42,
      text: "Plan the rollout"
    });

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await waitForAsyncNotifications();

    await database.updateSessionPreferredMode(-1001, 790, "plan");

    await bridge.handleUserMessage({
      chatId: -1001,
      topicId: 790,
      messageId: 417,
      updateId: 517,
      userId: 42,
      text: "/implement and keep the diff small",
      input: [
        {
          type: "text",
          text: "/implement and keep the diff small",
          text_elements: []
        },
        {
          type: "telegramImage",
          fileId: "photo-implement",
          fileName: "implement.png",
          mimeType: "image/png"
        }
      ]
    });

    expect(codex.turns.at(-1)?.text).toBe(
      ["Implement the plan.", "", "Additional instructions:", "and keep the diff small"].join("\n")
    );
    expect(codex.turns.at(-1)?.input[0]).toEqual({
      type: "text",
      text: ["Implement the plan.", "", "Additional instructions:", "and keep the diff small"].join("\n"),
      text_elements: []
    });
    expect(codex.turns.at(-1)?.input[1]?.type).toBe("localImage");
  });

  it("starts a default-mode implementation turn from the plan stub button", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 786,
      messageId: 416,
      updateId: 516,
      userId: 42,
      text: "Plan the rollout"
    });

    codex.emitNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "plan",
          id: "plan-1",
          text: "1. Draft the rollout"
        }
      }
    });
    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await waitForAsyncNotifications();

    await database.updateSessionPreferredMode(-1001, 786, "plan");

    const stub = telegram.sentMessages.find((message) => message.text === "Plan is ready");
    expect(stub?.options?.disable_notification).toBeUndefined();
    const callbackData = getCallbackDataByButtonText(stub, "Implement");
    expect(callbackData).toBe(TOPIC_IMPLEMENT_CALLBACK_DATA);

    await bridge.handleCallbackQuery({
      callbackQueryId: "callback-implement-plan",
      data: callbackData!,
      chatId: -1001,
      topicId: 786,
      userId: 42
    });

    expect(codex.turns).toHaveLength(2);
    expect(codex.turns.at(-1)?.text).toBe("Implement the plan.");
    expect(telegram.sentMessages.at(-1)?.text).toBe("Exited plan mode");
  });

  it("interrupts the active turn from /stop", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 403,
      updateId: 503,
      userId: 42,
      text: "Inspect the current failure"
    });

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 404,
      updateId: 504,
      userId: 42,
      text: "/stop"
    });

    expect(codex.interruptCalls).toEqual([{ threadId: "thread-1", turnId: "turn-1" }]);
    expect(telegram.sentMessages.at(-1)).toMatchObject({
      chatId: -1001,
      text: "Stopping the current response…",
      options: {
        message_thread_id: 777
      }
    });

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "interrupted",
          error: null
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(telegram.deletions).toEqual([]);
  });

  it("replies that /stop is not valid when there is no active response", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 779,
      messageId: 405,
      updateId: 505,
      userId: 42,
      text: "/stop"
    });

    expect(codex.interruptCalls).toEqual([]);
    expect(telegram.sentMessages.at(-1)?.text).toBe("There is no active response to stop right now");
    const session = await database.getSessionByTopic(-1001, 779);
    expect(session).toBeUndefined();
  });

  it("interrupts the active turn and immediately submits merged pending steers", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 42,
      updateId: 52,
      userId: 42,
      text: "Inspect the current failure"
    });

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 43,
      updateId: 53,
      userId: 42,
      text: "First steer"
    });

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 44,
      updateId: 54,
      userId: 42,
      text: "Second steer"
    });

    await bridge.handleCallbackQuery({
      callbackQueryId: "callback-send-now",
      data: "turn:turn-1:sendNow",
      chatId: -1001,
      topicId: 777,
      userId: 42
    });

    expect(codex.interruptCalls).toEqual([{ threadId: "thread-1", turnId: "turn-1" }]);

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "interrupted",
          error: null
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(codex.turns).toEqual([
      {
        threadId: "thread-1",
        text: "Inspect the current failure",
        turnId: "turn-1"
      },
      {
        threadId: "thread-1",
        text: "First steer\nSecond steer",
        turnId: "turn-2"
      }
    ]);
  });

  it("keeps queued follow-ups queued after an interrupted turn", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 45,
      updateId: 55,
      userId: 42,
      actorLabel: "Jeremy",
      text: "Inspect the current failure"
    });

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 46,
      updateId: 56,
      userId: 42,
      actorLabel: "Jeremy",
      text: "Pending steer"
    });

    codex.nextSteerError = new JsonRpcMethodError("turn/steer", 3, {
      code: -32600,
      message: "expectedTurnId does not match the current active turn",
      data: {
        kind: "invalid_active_turn"
      }
    });

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 47,
      updateId: 57,
      userId: 42,
      text: "Queued follow-up"
    });

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "interrupted",
          error: null
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(codex.turns).toEqual([
      {
        threadId: "thread-1",
        text: "Inspect the current failure",
        turnId: "turn-1"
      }
    ]);
    expect(telegram.edits.at(-1)?.text).toBe("Queued for next turn:\n- Jeremy: Pending steer\n- User 42: Queued follow-up");
  });

  it("treats a stale interrupt as already finished and submits pending steers immediately", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 48,
      updateId: 58,
      userId: 42,
      text: "Inspect the current failure"
    });

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 49,
      updateId: 59,
      userId: 42,
      text: "Queued steer"
    });

    codex.nextInterruptError = new JsonRpcMethodError("turn/interrupt", 4, {
      code: -32600,
      message: "No active turn to interrupt",
      data: {
        kind: "invalid_active_turn"
      }
    });

    await bridge.handleCallbackQuery({
      callbackQueryId: "callback-stale-interrupt",
      data: "turn:turn-1:sendNow",
      chatId: -1001,
      topicId: 777,
      userId: 42
    });

    expect(codex.turns).toEqual([
      {
        threadId: "thread-1",
        text: "Inspect the current failure",
        turnId: "turn-1"
      },
      {
        threadId: "thread-1",
        text: "Queued steer",
        turnId: "turn-2"
      }
    ]);
    expect(telegram.chatActions.some((action) => action.action === "typing")).toBe(true);
  });

  it("preserves queued input when interrupting the current turn fails", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 60,
      updateId: 70,
      userId: 42,
      text: "Inspect the current failure"
    });

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 61,
      updateId: 71,
      userId: 42,
      text: "Queued steer"
    });

    codex.nextInterruptError = new Error("interrupt failed");

    await bridge.handleCallbackQuery({
      callbackQueryId: "callback-failed-interrupt",
      data: "turn:turn-1:sendNow",
      chatId: -1001,
      topicId: 777,
      userId: 42
    });

    expect(codex.turns).toHaveLength(1);
    expect(telegram.sentMessages.at(-1)?.text).toBe("Failed to interrupt the current turn: interrupt failed");
    expect(telegram.sentMessages.some((message) => message.text === "Queued for current turn:\n- Queued steer")).toBe(true);
  });

  it("still submits queued steer instructions when Telegram chat action is rate limited", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 62,
      updateId: 72,
      userId: 42,
      text: "Inspect the current failure"
    });

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 63,
      updateId: 73,
      userId: 42,
      text: "Queued steer"
    });

    await bridge.handleCallbackQuery({
      callbackQueryId: "callback-send-now-429",
      data: "turn:turn-1:sendNow",
      chatId: -1001,
      topicId: 777,
      userId: 42
    });

    telegram.nextChatActionError = {
      parameters: {
        retry_after: 4
      }
    } as unknown as Error;

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "interrupted",
          error: null
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(codex.turns).toEqual([
      {
        threadId: "thread-1",
        text: "Inspect the current failure",
        turnId: "turn-1"
      },
      {
        threadId: "thread-1",
        text: "Queued steer",
        turnId: "turn-2"
      }
    ]);
  });

  it("walks a multi-question user-input request without requiring JSON replies", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 786,
      messageId: 420,
      updateId: 520,
      userId: 42,
      text: "Start the topic"
    });

    codex.emitRequest({
      method: "item/tool/requestUserInput",
      id: 90,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-input-1",
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "What kind of change do you want?",
            isOther: false,
            isSecret: false,
            options: [
              {
                label: "Refactor",
                description: "Change structure only"
              }
            ]
          },
          {
            id: "notes",
            header: "Notes",
            question: "Any extra context?",
            isOther: false,
            isSecret: false,
            options: null
          }
        ]
      }
    });
    await waitForAsyncNotifications();

    const pending = await database.getPendingRequest(JSON.stringify(90));
    expect(telegram.sentMessages.at(-1)?.text).toContain("Question 1/2");
    expect(telegram.sentMessages.at(-1)?.text).toContain("Use the buttons below to answer, or reply in this shared topic");
    expect(telegram.sentMessages.at(-1)?.options?.reply_markup).toEqual({
      inline_keyboard: [[{ text: "Refactor", callback_data: `req:${pending.id}:opt:0` }]]
    });
    expect(telegram.sentMessages.at(-1)?.options?.disable_notification).toBeUndefined();

    await bridge.handleCallbackQuery({
      callbackQueryId: "callback-user-input-1",
      data: `req:${pending.id}:opt:0`,
      chatId: -1001,
      topicId: 786,
      userId: 42
    });

    expect(telegram.edits.at(-1)?.text).toContain("Question 2/2");

    const finalAnswer = "Keep the diff small";

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 786,
      messageId: 421,
      updateId: 521,
      userId: 42,
      text: finalAnswer
    });

    expect(codex.userInputs).toEqual([
      {
        id: 90,
        answers: {
          scope: { answers: ["Refactor"] },
          notes: { answers: [finalAnswer] }
        }
      }
    ]);
    expect(telegram.edits.at(-1)?.text).toBe(`User answered: ${finalAnswer}`);
    expect(telegram.editOptions.at(-1)?.options?.entities).toEqual([
      {
        type: "code",
        offset: "User answered: ".length,
        length: finalAnswer.length
      }
    ]);
  });

  it("supports option prompts that fall back to free text via Other", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 787,
      messageId: 422,
      updateId: 522,
      userId: 42,
      text: "Start the topic"
    });

    codex.emitRequest({
      method: "item/tool/requestUserInput",
      id: 91,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-input-2",
        questions: [
          {
            id: "secret_choice",
            header: "Secret",
            question: "Choose how to proceed",
            isOther: true,
            isSecret: true,
            options: [
              {
                label: "Standard",
                description: "Use the default flow"
              }
            ]
          }
        ]
      }
    });
    await waitForAsyncNotifications();

    const pending = await database.getPendingRequest(JSON.stringify(91));
    expect(telegram.sentMessages.at(-1)?.text).toContain("Sensitive input. Your reply stays visible in this shared topic.");
    expect(telegram.sentMessages.at(-1)?.text).toContain("Standard: Use the default flow");

    await bridge.handleCallbackQuery({
      callbackQueryId: "callback-user-input-2",
      data: `req:${pending.id}:other`,
      chatId: -1001,
      topicId: 787,
      userId: 42
    });

    expect(telegram.edits.at(-1)?.text).toContain("Reply with your own answer in this shared topic");

    const finalAnswer = "Use a custom rollout path";

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 787,
      messageId: 423,
      updateId: 523,
      userId: 42,
      text: finalAnswer
    });

    expect(codex.userInputs).toContainEqual({
      id: 91,
      answers: {
        secret_choice: { answers: [finalAnswer] }
      }
    });
    expect(telegram.edits.at(-1)?.text).toBe(`User answered: ${finalAnswer}`);
    expect(telegram.editOptions.at(-1)?.options?.entities).toEqual([
      {
        type: "code",
        offset: "User answered: ".length,
        length: finalAnswer.length
      }
    ]);
  });

  it("does not let a stale retried user-input prompt overwrite a later completion", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 787,
      messageId: 422,
      updateId: 5_220,
      userId: 42,
      text: "Start the topic"
    });

    codex.emitRequest({
      method: "item/tool/requestUserInput",
      id: 9_101,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-input-2",
        questions: [
          {
            id: "secret_choice",
            header: "Secret",
            question: "Choose how to proceed",
            isOther: true,
            isSecret: true,
            options: [
              {
                label: "Standard",
                description: "Use the default flow"
              }
            ]
          }
        ]
      }
    });
    await waitForCondition(() =>
      telegram.sentMessages.some((message) =>
        message.text.includes("Sensitive input. Your reply stays visible in this shared topic.")
      )
    );

    const pending = await database.getPendingRequest(JSON.stringify(9_101));
    const promptMessage = telegram.sentMessages.findLast((message) =>
      message.text.includes("Sensitive input. Your reply stays visible in this shared topic.")
    );
    expect(promptMessage).toBeDefined();

    vi.useFakeTimers();

    try {
      telegram.nextEditMessageTextError = rateLimitError(1);

      const callbackPromise = bridge.handleCallbackQuery({
        callbackQueryId: "callback-user-input-race",
        data: `req:${pending.id}:other`,
        chatId: -1001,
        topicId: 787,
        userId: 42
      });

      await Promise.resolve();

      const finalAnswer = "Use a custom rollout path";
      const completionPromise = bridge.handleUserTextMessage({
        chatId: -1001,
        topicId: 787,
        messageId: 423,
        updateId: 5_221,
        userId: 42,
        text: finalAnswer
      });

      await vi.advanceTimersByTimeAsync(5000);
      await vi.runOnlyPendingTimersAsync();
      await Promise.all([callbackPromise, completionPromise]);

      expect(codex.userInputs).toContainEqual({
        id: 9_101,
        answers: {
          secret_choice: { answers: [finalAnswer] }
        }
      });
      expect(
        telegram.edits.some((edit) => edit.text.includes("Reply with your own answer in this shared topic"))
      ).toBe(false);
      expect(telegram.edits.at(-1)?.text).toBe(`User answered: ${finalAnswer}`);
      expect(telegram.editOptions.at(-1)?.messageId).toBe(promptMessage?.messageId);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start user-input side effects before the callback ack succeeds", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 787,
      messageId: 422,
      updateId: 5_230,
      userId: 42,
      text: "Start the topic"
    });

    codex.emitRequest({
      method: "item/tool/requestUserInput",
      id: 9_102,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-input-3",
        questions: [
          {
            id: "choice",
            header: "Choice",
            question: "Choose how to proceed",
            isOther: false,
            isSecret: false,
            options: [
              {
                label: "Standard",
                description: "Use the default flow"
              }
            ]
          }
        ]
      }
    });
    await waitForCondition(() =>
      telegram.sentMessages.some((message) => message.text.includes("Choose how to proceed"))
    );

    const pendingBefore = await database.getPendingRequest(JSON.stringify(9_102));
    const promptMessage = telegram.sentMessages.findLast((message) =>
      message.text.includes("Choose how to proceed")
    );
    expect(promptMessage).toBeDefined();
    const editsBefore = telegram.edits.length;

    telegram.nextAnswerCallbackQueryError = new Error("ack failed");

    await expect(
      bridge.handleCallbackQuery({
        callbackQueryId: "callback-user-input-ack-failure",
        data: `req:${pendingBefore.id}:opt:0`,
        chatId: -1001,
        topicId: 787,
        userId: 42
      })
    ).rejects.toThrow("ack failed");

    const pendingAfter = await database.getPendingRequest(JSON.stringify(9_102));
    expect(codex.userInputs).toEqual([]);
    expect(telegram.edits).toHaveLength(editsBefore);
    expect(
      telegram.edits.some((edit) => edit.messageId === promptMessage?.messageId)
    ).toBe(false);
    expect(pendingAfter.status).toBe("pending");
    expect(pendingAfter.stateJson).toBe(pendingBefore.stateJson);
  });

  it("sends a topic startup footer that explains General and /thread", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 700,
      updateId: 800,
      userId: 42,
      text: "/thread Review the deployment plan"
    });

    const footerMessage = telegram.sentMessages.find((message) =>
      message.text.startsWith("General stays shared for workspace-wide work.")
    );

    expect(footerMessage).toMatchObject({
      chatId: -1001,
      text:
        "General stays shared for workspace-wide work. Use /thread to create a separate topic.\n<1s • 100% left • /workspace • main • gpt-5-codex",
      options: {
        message_thread_id: 101,
        entities: preformattedEntities("<1s • 100% left • /workspace • main • gpt-5-codex", "status").map(
          (entity) => ({
            ...entity,
            offset:
              entity.offset +
              "General stays shared for workspace-wide work. Use /thread to create a separate topic.\n".length
          })
        )
      }
    });
  });

  it("retries temporary 429s when creating a new topic from root /plan", async () => {
    vi.useFakeTimers();

    try {
      telegram.nextCreateForumTopicError = rateLimitError(1);

      const promise = bridge.handleUserTextMessage({
        chatId: -1001,
        topicId: null,
        messageId: 700,
        updateId: 801,
        userId: 42,
        text: "/plan"
      });

      await Promise.resolve();
      expect(telegram.createdTopics).toEqual([]);

      await vi.advanceTimersByTimeAsync(10000);
      await vi.runOnlyPendingTimersAsync();
      void promise.catch(() => undefined);
      expect(telegram.createdTopics).toEqual([
        expect.objectContaining({
          chatId: -1001,
          name: "New Plan Session"
        })
      ]);
      expect(codex.createdThreads).toEqual(["New Plan Session"]);
      const session = await database.getSessionByTopic(-1001, 101);
      expect(session?.codexThreadId).toBe("thread-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stores approval requests and resolves them via callback queries", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 10,
      updateId: 20,
      userId: 42,
      text: "Run the deployment fix"
    });

    codex.emitRequest({
      method: "item/commandExecution/requestApproval",
      id: 88,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        command: "npm publish",
        cwd: "/workspace",
        availableDecisions: ["accept", "decline", "cancel"]
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const pending = await database.getPendingRequest(JSON.stringify(88));
    expect(pending.method).toBe("item/commandExecution/requestApproval");
    const promptMessage = telegram.sentMessages.at(-1);
    expect(promptMessage?.text).toBe(
      "Command approval needed\n\nnpm publish\n\nCWD: /workspace\nScope: this approval is for this command only"
    );
    expect(promptMessage?.options?.entities?.map((entity) => entity.type)).toEqual(["pre", "code"]);
    expect(promptMessage?.options?.disable_notification).toBeUndefined();
    expect(getInlineButtonTexts(promptMessage)).toEqual(["Allow once", "Deny", "Interrupt turn"]);

    await bridge.handleCallbackQuery({
      callbackQueryId: "callback-1",
      data: getCallbackDataByButtonText(promptMessage, "Allow once")!,
      chatId: -1001,
      topicId: 101,
      userId: 42
    });

    expect(codex.commandApprovals).toEqual([{ id: 88, decision: "accept" }]);
    const resolved = await database.getPendingRequest(JSON.stringify(88));
    expect(resolved.status).toBe("resolved");
    expect(telegram.edits.at(-1)?.text).toContain("accept");
  });

  it("acknowledges approval callbacks before a blocked resolution edit finishes", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 10,
      updateId: 20_001,
      userId: 42,
      text: "Run the deployment fix"
    });

    codex.emitRequest({
      method: "item/commandExecution/requestApproval",
      id: 880,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        command: "npm publish",
        cwd: "/workspace",
        availableDecisions: ["accept", "decline", "cancel"]
      }
    });
    await waitForCondition(() =>
      telegram.sentMessages.some((message) => message.text.startsWith("Command approval needed"))
    );

    const promptMessage = telegram.sentMessages.findLast((message) =>
      message.text.startsWith("Command approval needed")
    );
    expect(promptMessage).toBeDefined();

    const blocker = deferred<void>();
    telegram.editBlocks.push(blocker.promise);

    const callbackPromise = bridge.handleCallbackQuery({
      callbackQueryId: "callback-ack-before-edit",
      data: getCallbackDataByButtonText(promptMessage, "Allow once")!,
      chatId: -1001,
      topicId: 101,
      userId: 42
    });

    await waitForCondition(() => telegram.callbackAnswers.length > 0);
    expect(telegram.callbackAnswers.at(-1)?.options?.text).toBe("Request updated");

    blocker.resolve(undefined as unknown as void);
    await callbackPromise;

    expect(telegram.edits.at(-1)?.text).toContain("accept");
  });

  it("answers callback queries promptly while lower-priority Telegram edits are queued", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 10,
      updateId: 21,
      userId: 42,
      text: "Run the deployment fix"
    });

    codex.emitRequest({
      method: "item/commandExecution/requestApproval",
      id: 89,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        command: "npm publish",
        cwd: "/workspace",
        availableDecisions: ["accept", "decline", "cancel"]
      }
    });
    await waitForCondition(() =>
      telegram.sentMessages.some((message) => message.text.startsWith("Command approval needed"))
    );

    vi.useFakeTimers();

    try {
      telegram.events = [];
      telegram.nextEditMessageTextError = rateLimitError(1);

      codex.emitNotification({
        method: "serverRequest/resolved",
        params: {
          threadId: "thread-1",
          requestId: 89
        }
      });
      await Promise.resolve();

      await bridge.handleCallbackQuery({
        callbackQueryId: "callback-priority-1",
        data: "unsupported",
        chatId: -1001,
        topicId: 101,
        userId: 42
      });

      expect(telegram.events[0]).toBe("callback:callback-priority-1");

      await vi.advanceTimersByTimeAsync(5000);
      await vi.runOnlyPendingTimersAsync();
      expect(telegram.edits.at(-1)?.text).toBe("Request resolved");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries temporary 429s on request callback writes instead of failing the callback path", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 10,
      updateId: 22,
      userId: 42,
      text: "Run the deployment fix"
    });

    codex.emitRequest({
      method: "item/commandExecution/requestApproval",
      id: 90,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        command: "npm publish",
        cwd: "/workspace",
        availableDecisions: ["accept", "decline", "cancel"]
      }
    });
    await waitForCondition(() =>
      telegram.sentMessages.some((message) => message.text.startsWith("Command approval needed"))
    );

    const promptMessage = telegram.sentMessages.findLast((message) =>
      message.text.startsWith("Command approval needed")
    );
    expect(promptMessage).toBeDefined();

    vi.useFakeTimers();

    try {
      telegram.nextEditMessageTextError = rateLimitError(1);
      telegram.nextAnswerCallbackQueryError = rateLimitError(1);

      const promise = bridge.handleCallbackQuery({
        callbackQueryId: "callback-retry-1",
        data: getCallbackDataByButtonText(promptMessage, "Allow once")!,
        chatId: -1001,
        topicId: 101,
        userId: 42
      });

      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(8000);
      await vi.runOnlyPendingTimersAsync();
      await expect(promise).resolves.toBeUndefined();
      expect(codex.commandApprovals).toEqual([{ id: 90, decision: "accept" }]);
      expect(telegram.callbackAnswers.at(-1)?.options?.text).toBe("Request updated");
      expect(telegram.edits.at(-1)?.text).toContain("accept");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a stale external resolution retry overwrite a later approval summary", async () => {
    const messenger = new TelegramMessenger(telegram, console, ZERO_SPACING_DELIVERY_POLICY);
    const messengerEditSpy = vi.spyOn(messenger, "editMessageText");
    const coordinator = new BridgeRequestCoordinator(database, messenger, codex, async () => undefined);
    const pending = await database.createPendingRequest({
      requestIdJson: JSON.stringify(90_100),
      method: "item/commandExecution/requestApproval",
      telegramChatId: "-1001",
      telegramTopicId: 101,
      telegramMessageId: 9_001,
      payloadJson: JSON.stringify({
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        command: "npm publish",
        cwd: "/workspace",
        availableDecisions: ["accept", "decline", "cancel"]
      })
    });

    const releaseExternal = deferred<void>();
    const releaseLocalSummary = deferred<void>();
    const originalResolveRequestExternally = database.resolveRequestExternally.bind(database);
    const originalRespondToCommandApproval = codex.respondToCommandApproval.bind(codex);
    const resolveRequestExternallySpy = vi.spyOn(database, "resolveRequestExternally").mockImplementation(async (requestIdJson) => {
      await releaseExternal.promise;
      return originalResolveRequestExternally(requestIdJson);
    });
    const respondToCommandApprovalSpy = vi.spyOn(codex, "respondToCommandApproval").mockImplementation(async (id, response) => {
      await releaseLocalSummary.promise;
      return originalRespondToCommandApproval(id, response);
    });

    try {
      const externalPromise = coordinator.handleServerRequestResolved({
        threadId: "thread-1",
        requestId: 90_100
      });
      await waitForCondition(() => resolveRequestExternallySpy.mock.calls.length === 1);

      vi.useFakeTimers();
      telegram.nextEditMessageTextError = rateLimitError(1);

      const callbackPromise = coordinator.handleCallbackQuery({
        callbackQueryId: "callback-summary-race",
        data: `req:${pending.id}:accept`,
        chatId: -1001,
        topicId: 101
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(respondToCommandApprovalSpy).toHaveBeenCalledTimes(1);

      releaseExternal.resolve(undefined as unknown as void);
      await Promise.resolve();
      releaseLocalSummary.resolve(undefined as unknown as void);

      await vi.advanceTimersByTimeAsync(5000);
      await vi.runOnlyPendingTimersAsync();
      await Promise.all([callbackPromise, externalPromise]);

      const coalesceKeys = messengerEditSpy.mock.calls
        .map(([options]) => options)
        .filter((options) => options.messageId === 9_001)
        .map((options) => options.coalesceKey)
        .filter((key): key is string => typeof key === "string");
      expect(telegram.edits.at(-1)?.messageId).toBe(9_001);
      expect(telegram.edits.at(-1)?.text).toContain("accept");
      expect(new Set(coalesceKeys)).toHaveLength(1);
    } finally {
      messengerEditSpy.mockRestore();
      resolveRequestExternallySpy.mockRestore();
      respondToCommandApprovalSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not let a stale external resolution retry overwrite a later user-input completion", async () => {
    const messenger = new TelegramMessenger(telegram, console, ZERO_SPACING_DELIVERY_POLICY);
    const messengerEditSpy = vi.spyOn(messenger, "editMessageText");
    const coordinator = new BridgeRequestCoordinator(database, messenger, codex, async () => undefined);
    const pending = await database.createPendingRequest({
      requestIdJson: JSON.stringify(90_101),
      method: "item/tool/requestUserInput",
      telegramChatId: "-1001",
      telegramTopicId: 787,
      telegramMessageId: 9_002,
      payloadJson: JSON.stringify({
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-input-4",
        questions: [
          {
            id: "choice",
            header: "Choice",
            question: "Choose how to proceed",
            options: [
              {
                label: "Standard",
                description: "Use the default flow"
              }
            ]
          }
        ]
      })
    });
    await database.updateRequestState(
      pending.requestIdJson,
      stringifyUserInputState(createInitialUserInputState())
    );

    const releaseExternal = deferred<void>();
    const releaseLocalCompletion = deferred<void>();
    const originalResolveRequestExternally = database.resolveRequestExternally.bind(database);
    const originalRespondToUserInputRequest = codex.respondToUserInputRequest.bind(codex);
    const resolveRequestExternallySpy = vi.spyOn(database, "resolveRequestExternally").mockImplementation(async (requestIdJson) => {
      await releaseExternal.promise;
      return originalResolveRequestExternally(requestIdJson);
    });
    const respondToUserInputRequestSpy = vi.spyOn(codex, "respondToUserInputRequest").mockImplementation(async (id, response) => {
      await releaseLocalCompletion.promise;
      return originalRespondToUserInputRequest(id, response);
    });

    try {
      const externalPromise = coordinator.handleServerRequestResolved({
        threadId: "thread-1",
        requestId: 90_101
      });
      await waitForCondition(() => resolveRequestExternallySpy.mock.calls.length === 1);

      vi.useFakeTimers();
      telegram.nextEditMessageTextError = rateLimitError(1);

      const callbackPromise = coordinator.handleCallbackQuery({
        callbackQueryId: "callback-completion-race",
        data: `req:${pending.id}:opt:0`,
        chatId: -1001,
        topicId: 787
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(respondToUserInputRequestSpy).toHaveBeenCalledTimes(1);

      releaseExternal.resolve(undefined as unknown as void);
      await Promise.resolve();
      releaseLocalCompletion.resolve(undefined as unknown as void);

      await vi.advanceTimersByTimeAsync(5000);
      await vi.runOnlyPendingTimersAsync();
      await Promise.all([callbackPromise, externalPromise]);

      const coalesceKeys = messengerEditSpy.mock.calls
        .map(([options]) => options)
        .filter((options) => options.messageId === 9_002)
        .map((options) => options.coalesceKey)
        .filter((key): key is string => typeof key === "string");
      expect(telegram.edits.at(-1)?.messageId).toBe(9_002);
      expect(telegram.edits.at(-1)?.text).toBe("User answered: Standard");
      expect(new Set(coalesceKeys)).toHaveLength(1);
    } finally {
      messengerEditSpy.mockRestore();
      resolveRequestExternallySpy.mockRestore();
      respondToUserInputRequestSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("stores file approval requests and resolves them via callback queries", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 10,
      updateId: 20,
      userId: 42,
      text: "Apply the workspace fix"
    });

    codex.emitRequest({
      method: "item/fileChange/requestApproval",
      id: 188,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-file-1",
        reason: "needs write access outside the current sandbox root",
        grantRoot: "/workspace/packages/kirbot-core"
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const pending = await database.getPendingRequest(JSON.stringify(188));
    expect(pending.method).toBe("item/fileChange/requestApproval");
    const promptMessage = telegram.sentMessages.at(-1);
    expect(promptMessage?.text).toBe(
      "File change approval needed\n\nReason: needs write access outside the current sandbox root\nRequested root: /workspace/packages/kirbot-core\nScope: this approval is for this change; accepting also proposes this write root for the session"
    );
    expect(promptMessage?.options?.entities?.map((entity) => entity.type)).toEqual(["code"]);
    expect(promptMessage?.options?.disable_notification).toBeUndefined();
    expect(getInlineButtonTexts(promptMessage)).toEqual(["Allow once", "Deny", "Interrupt turn"]);

    await bridge.handleCallbackQuery({
      callbackQueryId: "callback-file-1",
      data: getCallbackDataByButtonText(promptMessage, "Allow once")!,
      chatId: -1001,
      topicId: 101,
      userId: 42
    });

    expect(codex.fileApprovals).toEqual([{ id: 188, decision: "accept" }]);
    const resolved = await database.getPendingRequest(JSON.stringify(188));
    expect(resolved.status).toBe("resolved");
    expect(telegram.edits.at(-1)?.text).toContain("accept");
  });

  it("stores permissions approval requests and resolves them via callback queries", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 10,
      updateId: 20,
      userId: 42,
      text: "Request additional permissions"
    });

    codex.emitRequest({
      method: "item/permissions/requestApproval",
      id: 288,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-perm-1",
        reason: "Need to write outside the workspace",
        permissions: {
          network: null,
          fileSystem: {
            read: null,
            write: ["/tmp/export"]
          },
          macos: null
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const pending = await database.getPendingRequest(JSON.stringify(288));
    expect(pending.method).toBe("item/permissions/requestApproval");
    const promptMessage = telegram.sentMessages.at(-1);
    expect(promptMessage?.text).toContain("Additional permissions requested");
    expect(promptMessage?.text).toContain("Need to write outside the workspace");
    expect(promptMessage?.text).toContain("Write /tmp/export");
    expect(promptMessage?.options?.disable_notification).toBeUndefined();
    expect(getInlineButtonTexts(promptMessage)).toEqual(["Allow this turn", "Allow this session", "Deny"]);

    await bridge.handleCallbackQuery({
      callbackQueryId: "callback-permissions-1",
      data: getCallbackDataByButtonText(promptMessage, "Allow this session")!,
      chatId: -1001,
      topicId: 101,
      userId: 42
    });

    expect(codex.permissionsApprovals).toEqual([
      {
        id: 288,
        response: {
          permissions: {
            fileSystem: {
              read: null,
              write: ["/tmp/export"]
            }
          },
          scope: "session"
        }
      }
    ]);
    const resolved = await database.getPendingRequest(JSON.stringify(288));
    expect(resolved.status).toBe("resolved");
    expect(telegram.edits.at(-1)?.text).toBe("Allowed additional permissions for this session");
  });

  it("cleans up pending approval prompts when the app server resolves them elsewhere", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 11,
      updateId: 21,
      userId: 42,
      text: "Run the deployment fix"
    });

    codex.emitRequest({
      method: "item/commandExecution/requestApproval",
      id: 89,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        command: "npm publish",
        cwd: "/workspace",
        availableDecisions: ["accept", "decline", "cancel"]
      }
    });
    await waitForAsyncNotifications();

    const promptMessage = telegram.sentMessages.at(-1);
    expect(promptMessage?.text).toContain("Command approval needed");
    expect(getInlineButtonTexts(promptMessage)).toEqual(["Allow once", "Deny", "Interrupt turn"]);

    codex.emitNotification({
      method: "serverRequest/resolved",
      params: {
        threadId: "thread-1",
        requestId: 89
      }
    });
    await waitForAsyncNotifications();

    expect(codex.commandApprovals).toEqual([]);
    expect(telegram.edits.at(-1)).toMatchObject({
      chatId: -1001,
      messageId: promptMessage?.messageId,
      text: "Request resolved"
    });

    const resolved = await database.getPendingRequest(JSON.stringify(89));
    expect(resolved.status).toBe("resolved");
  });

  it("shows explicit session-scope approval options when available", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 12,
      updateId: 22,
      userId: 42,
      text: "Run the deployment fix"
    });

    codex.emitRequest({
      method: "item/commandExecution/requestApproval",
      id: 90,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        command: "npm test",
        cwd: "/workspace",
        availableDecisions: ["accept", "acceptForSession", "decline", "cancel"]
      }
    });
    await waitForAsyncNotifications();

    const promptMessage = telegram.sentMessages.at(-1);
    expect(promptMessage?.text).toBe(
      "Command approval needed\n\nnpm test\n\nCWD: /workspace\nScope: allow only this run, or all matching runs for this session"
    );
    expect(getInlineButtonTexts(promptMessage)).toEqual([
      "Allow once",
      "Allow this session",
      "Deny",
      "Interrupt turn"
    ]);
  });

  it("acks topic compaction and edits the ack to the final message", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 12,
      updateId: 22,
      userId: 42,
      text: "Inspect the long thread"
    });

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await waitForAsyncNotifications();

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 13,
      updateId: 23,
      userId: 42,
      text: "/compact"
    });

    expect(codex.compactThreadCalls).toEqual([{ threadId: "thread-1" }]);
    const compactingMessage = telegram.sentMessages.findLast((message) => message.text === "Compacting…");
    expect(compactingMessage).toMatchObject({
      chatId: -1001,
      text: "Compacting…",
      options: {
        message_thread_id: 777
      }
    });

    codex.emitNotification({
      method: "thread/compacted",
      params: {
        threadId: "thread-1",
        turnId: "turn-1"
      }
    });
    await waitForAsyncNotifications();

    expect(telegram.edits.findLast((edit) => edit.messageId === compactingMessage?.messageId)).toMatchObject({
      chatId: -1001,
      messageId: compactingMessage?.messageId,
      text: "Context compacted",
    });
  });

  it("acks root compaction and edits the ack to the final message", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 14,
      updateId: 24,
      userId: 42,
      text: "Inspect the long thread"
    });

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await waitForAsyncNotifications();

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 15,
      updateId: 25,
      userId: 42,
      text: "/compact"
    });

    expect(codex.compactThreadCalls).toEqual([{ threadId: "thread-1" }]);
    const compactingMessage = telegram.sentMessages.findLast((message) => message.text === "Compacting…");
    expect(compactingMessage).toMatchObject({
      chatId: -1001,
      text: "Compacting…"
    });

    codex.emitNotification({
      method: "thread/compacted",
      params: {
        threadId: "thread-1",
        turnId: "turn-1"
      }
    });
    await waitForAsyncNotifications();

    expect(telegram.edits.findLast((edit) => edit.messageId === compactingMessage?.messageId)).toMatchObject({
      chatId: -1001,
      messageId: compactingMessage?.messageId,
      text: "Context compacted"
    });
  });

  it("deduplicates item-level compaction notices after the compact ack is edited", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 13,
      updateId: 23,
      userId: 42,
      text: "Inspect the long thread"
    });

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await waitForAsyncNotifications();

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 14,
      updateId: 24,
      userId: 42,
      text: "/compact"
    });

    codex.emitNotification({
      method: "thread/compacted",
      params: {
        threadId: "thread-1",
        turnId: "turn-1"
      }
    });
    codex.emitNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "contextCompaction",
          id: "compact-1"
        }
      }
    });
    await waitForAsyncNotifications();

    expect(telegram.sentMessages.filter((message) => message.text === "Compacting…")).toHaveLength(1);
    expect(
      telegram.edits.filter(
        (message) => message.messageId === telegram.sentMessages.find((sentMessage) => sentMessage.text === "Compacting…")?.messageId &&
          message.text === "Context compacted"
      )
    ).toHaveLength(1);
  });

  it("surfaces auto-compaction notices from item-level contextCompaction events", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 13,
      updateId: 23,
      userId: 42,
      text: "Start the session"
    });

    codex.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null
        }
      }
    });
    await waitForAsyncNotifications();

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 14,
      updateId: 24,
      userId: 42,
      text: "Keep going until the thread gets long"
    });

    codex.emitNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-2",
        item: {
          type: "contextCompaction",
          id: "compact-1"
        }
      }
    });
    await waitForAsyncNotifications();

    expect(telegram.sentMessages.findLast((message) => message.text === "Context compacted")).toMatchObject({
      chatId: -1001,
      text: "Context compacted",
      options: {
        message_thread_id: 777
      }
    });
  });

  it("accepts callback queries from any sender in the configured workspace chat", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 401,
      updateId: 501,
      userId: 42,
      text: "Inspect the current failure"
    });

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 402,
      updateId: 502,
      userId: 42,
      text: "Queued steer"
    });

    await bridge.handleCallbackQuery({
      callbackQueryId: "callback-send-now-unauthorized",
      data: "turn:turn-1:sendNow",
      chatId: -1001,
      topicId: 777,
      userId: 99
    });

    expect(codex.interruptCalls).toEqual([
      {
        threadId: "thread-1",
        turnId: "turn-1"
      }
    ]);
  });
});

function flattenTextInput(input: UserInput[]): string {
  return input
    .filter((item): item is Extract<UserInput, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}
