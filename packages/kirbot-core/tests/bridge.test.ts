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
import type { ToolRequestUserInputResponse } from "@kirbot/codex-client/generated/codex/v2/ToolRequestUserInputResponse";
import type { ReasoningEffort } from "@kirbot/codex-client/generated/codex/ReasoningEffort";
import { JsonRpcMethodError, type AppServerEvent } from "@kirbot/codex-client";
import { renderMarkdownToFormattedText } from "@kirbot/telegram-format";
import type { TelegramApi, TelegramSendOptions } from "../src/telegram-messenger";
import type { ResolvedTurnSnapshot } from "../src/bridge/turn-finalization";
import { decodeMiniAppArtifact, getEncodedMiniAppArtifactFromHash, MiniAppArtifactType } from "../src/mini-app/url";

const EMPTY_DRAFT_TEXT = "";

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

function quoteEntities(text: string, type: "blockquote" | "expandable_blockquote" = "expandable_blockquote"): MessageEntity[] {
  return [
    {
      type,
      offset: 0,
      length: text.length
    }
  ];
}

function combinedDraft(...parts: string[]): string {
  return parts.join("\n\n");
}

function commentaryRendered(...blocks: string[]) {
  const markdown = `Commentary\n\n${blocks.map((block) => `\`\`\`\n${block}\n\`\`\``).join("\n\n")}`;
  return renderMarkdownToFormattedText(markdown);
}

function getFinalAnswerMessage(telegram: FakeTelegram) {
  const last = telegram.sentMessages.at(-1);
  if (last?.text.includes(" • ") && last.text.includes("% left")) {
    return telegram.sentMessages.at(-2);
  }

  return last;
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

class FakeCodex implements BridgeCodexApi {
  createdThreads: string[] = [];
  ensuredThreads: string[] = [];
  turns: Array<{ threadId: string; text: string; input: UserInput[]; turnId: string }> = [];
  turnCollaborationModes: Array<{ turnId: string; collaborationMode: unknown | null }> = [];
  steerCalls: Array<{ threadId: string; expectedTurnId: string; text: string; input: UserInput[] }> = [];
  interruptCalls: Array<{ threadId: string; turnId: string }> = [];
  commandApprovals: Array<{ id: string | number; decision: CommandExecutionApprovalDecision }> = [];
  fileApprovals: Array<{ id: string | number; decision: FileChangeApprovalDecision }> = [];
  userInputs: Array<{ id: string | number; answers: ToolRequestUserInputResponse["answers"] }> = [];
  unsupported: Array<{ id: string | number; message: string }> = [];
  readTurnMessagesResult = "";
  readTurnSnapshotResult: Partial<ResolvedTurnSnapshot> = {};
  model = "gpt-5-codex";
  reasoningEffort: ReasoningEffort | null = null;
  nextSendTurnError: Error | null = null;
  nextSteerError: Error | null = null;
  nextInterruptError: Error | null = null;
  beforeSendTurnResolve:
    | ((input: { threadId: string; turnId: string; input: UserInput[] }) => Promise<void> | void)
    | null = null;

  readonly #eventQueue: AppServerEvent[] = [];
  readonly #eventWaiters: Array<(event: AppServerEvent | null) => void> = [];

  async createThread(title: string): Promise<{ threadId: string; model: string; reasoningEffort: ReasoningEffort | null }> {
    this.createdThreads.push(title);
    return {
      threadId: "thread-1",
      model: this.model,
      reasoningEffort: this.reasoningEffort
    };
  }

  async ensureThreadLoaded(threadId: string): Promise<{ model: string; reasoningEffort: ReasoningEffort | null }> {
    this.ensuredThreads.push(threadId);
    return {
      model: this.model,
      reasoningEffort: this.reasoningEffort
    };
  }

  async sendTurn(threadId: string, input: UserInput[], collaborationMode?: unknown): Promise<{ id: string }> {
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
      collaborationMode: collaborationMode ?? null
    });
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
  nextChatActionError: Error | null = null;
  nextDraftError: Error | null = null;
  nextSendMessageError: Error | null = null;
  draftBlocks: Array<Promise<void>> = [];
  events: string[] = [];
  chatActions: Array<{
    chatId: number;
    action: "typing" | "upload_document";
    options?: { message_thread_id?: number };
  }> = [];
  createdTopics: Array<{ chatId: number; name: string }> = [];
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
    options?: { message_thread_id?: number; entities?: MessageEntity[] };
  }> = [];
  appliedDrafts: Array<{
    chatId: number;
    draftId: number;
    text: string;
    options?: { message_thread_id?: number; entities?: MessageEntity[] };
  }> = [];
  edits: Array<{ chatId: number; messageId: number; text: string }> = [];
  editOptions: Array<{
    chatId: number;
    messageId: number;
    options?: TelegramSendOptions;
  }> = [];
  deletions: Array<{ chatId: number; messageId: number }> = [];
  downloads: Array<{ fileId: string }> = [];

  async createForumTopic(chatId: number, name: string): Promise<{ message_thread_id: number; name: string }> {
    this.createdTopics.push({ chatId, name });
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
    this.sentMessages.push(
      options
        ? { messageId: this.messageCounter, chatId, text, options }
        : { messageId: this.messageCounter, chatId, text }
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
    options?: TelegramSendOptions
  ): Promise<unknown> {
    this.edits.push({ chatId, messageId, text });
    this.editOptions.push(options ? { chatId, messageId, options } : { chatId, messageId });
    return true;
  }

  async deleteMessage(chatId: number, messageId: number): Promise<true> {
    this.deletions.push({ chatId, messageId });
    return true;
  }

  async answerCallbackQuery(): Promise<true> {
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

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "telegram-codex-bridge-service-"));
    database = new BridgeDatabase(join(tempDir, "bridge.sqlite"));
    await database.migrate();

    codex = new FakeCodex();
    telegram = new FakeTelegram();
    config = {
      telegram: {
        botToken: "token",
        userId: 42,
        mediaTempDir: join(tempDir, "telegram-media"),
        miniApp: {
          publicUrl: undefined
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
    bridge = new TelegramCodexBridge(config, database, telegram, codex, mediaStore);
  });

  afterEach(async () => {
    await database.close();
    rmSync(tempDir, { force: true, recursive: true });
  });

  it("creates a new topic and Codex thread from the lobby chat", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 10,
      updateId: 20,
      userId: 42,
      text: "Fix the failing deployment tests"
    });

    expect(telegram.createdTopics).toHaveLength(1);
    expect(codex.createdThreads).toEqual(["Fix the failing deployment tests"]);
    expect(codex.turns).toEqual([
      {
        threadId: "thread-1",
        text: "Fix the failing deployment tests",
        turnId: "turn-1"
      }
    ]);
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

    const session = await database.getSessionByTopic(-1001, 101);
    expect(session?.status).toBe("active");
    expect(session?.codexThreadId).toBe("thread-1");
  });

  it("continues session startup when sending the initial prompt mirror fails", async () => {
    telegram.nextSendMessageError = new Error("mirror failed");

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 10,
      updateId: 20,
      userId: 42,
      text: "Fix the failing deployment tests"
    });

    expect(telegram.sentMessages).toEqual([]);
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
    expect(telegram.sentMessages.at(-1)?.text).toBe("This command is not valid here.");
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

    expect(telegram.createdTopics).toEqual([
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
    expect(codex.turnCollaborationModes.at(-1)?.collaborationMode).toEqual({
      mode: "plan",
      settings: {
        model: "gpt-5-codex",
        reasoning_effort: "high",
        developer_instructions: null
      }
    });
    expect(telegram.sentMessages).toMatchObject([
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
        text: "Plan mode enabled.",
        options: {
          message_thread_id: 101
        }
      }
    ]);

    const session = await database.getSessionByTopic(-1001, 101);
    expect(session?.preferredMode).toBe("plan");
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

    expect(telegram.createdTopics).toEqual([
      {
        chatId: -1001,
        name: "New Plan Session"
      }
    ]);
    expect(codex.createdThreads).toEqual(["New Plan Session"]);
    expect(codex.turns).toHaveLength(0);
    expect(telegram.sentMessages).toMatchObject([
      {
        chatId: -1001,
        text: "Plan mode enabled.",
        options: {
          message_thread_id: 101
        }
      }
    ]);

    const session = await database.getSessionByTopic(-1001, 101);
    expect(session?.preferredMode).toBe("plan");
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
    expect(telegram.sentMessages.at(-1)?.text).toBe("This command is not valid here.");
  });

  it("ignores messages from users other than the configured Telegram user", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 10,
      updateId: 20,
      userId: 99,
      text: "Fix the failing deployment tests"
    });

    expect(telegram.createdTopics).toHaveLength(0);
    expect(codex.createdThreads).toHaveLength(0);
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(telegram.drafts.at(-1)?.text).toBe("thinking · 0s");
    expect(telegram.chatActions.some((action) => action.action === "typing")).toBe(true);
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
    const persistedTurn = await database.getTurnById("turn-1");
    expect(persistedTurn.status).toBe("completed");
    expect(persistedTurn.resolvedAssistantText).toBe("Final from snapshot");
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
    expect(telegram.sentMessages.at(-1)?.text).toContain("npm test");
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
    expect(telegram.sentMessages.at(-1)?.text).toBe("This command is not valid here.");
    const session = await database.getSessionByTopic(-1001, 778);
    expect(session).toBeUndefined();
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
      "This topic does not have a Codex session yet. Send a normal message first to start one."
    );
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

    expect(telegram.sentMessages.at(-1)?.text).toBe("Plan mode enabled.");
    expect(codex.turns).toHaveLength(1);
    const session = await database.getSessionByTopic(-1001, 781);
    expect(session?.preferredMode).toBe("plan");
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
    expect(codex.turnCollaborationModes.at(-1)?.collaborationMode).toEqual({
      mode: "plan",
      settings: {
        model: "gpt-5-codex",
        reasoning_effort: "high",
        developer_instructions: null
      }
    });
    expect(telegram.sentMessages.at(-1)?.text).toBe("Plan mode enabled.");
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
    expect((await database.getTurnById("turn-1")).status).toBe("streaming");

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
    expect((await database.getTurnById("turn-1")).status).toBe("completed");
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
    expect((await database.getTurnById("turn-1")).status).toBe("failed");
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

    expect(telegram.sentMessages.filter((message) => message.text.includes("Codex error: vision failed"))).toHaveLength(1);
    expect((await database.getTurnById("turn-1")).status).toBe("failed");
  });

  it("streams turn deltas and publishes the final completion message", async () => {
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

    expect(telegram.drafts.some((draft) => draft.text === "Working on it")).toBe(true);
    expect(telegram.deletions).toEqual([]);
    expect(getFinalAnswerMessage(telegram)?.text).toBe("Working on it");
    expect(telegram.sentMessages.at(-1)?.text).toBe("gpt-5-codex high • <1s • 0 files • 100% left • /workspace • main");
    expect(telegram.sentMessages.at(-1)?.options?.entities).toEqual(
      preformattedEntities("gpt-5-codex high • <1s • 0 files • 100% left • /workspace • main", "status")
    );
    expect(telegram.appliedDrafts.at(-1)?.text).toBe(EMPTY_DRAFT_TEXT);

    const turn = await database.getTurnById("turn-1");
    expect(turn.status).toBe("completed");
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

    expect(
      telegram.drafts.some(
        (draft) =>
          draft.text === "Use bold and code." &&
          draft.options?.entities?.some((entity) => entity.type === "bold") &&
          draft.options.entities.some((entity) => entity.type === "code")
      )
    ).toBe(true);
    expect(telegram.chatActions.some((action) => action.action === "typing")).toBe(true);
    expect(telegram.appliedDrafts.at(-1)?.text).toBe(EMPTY_DRAFT_TEXT);
    expect(getFinalAnswerMessage(telegram)?.text).toBe("Use bold and code.\n\nconst answer = 42;");
    expect(getFinalAnswerMessage(telegram)?.options?.entities).toEqual([
      { type: "bold", offset: 4, length: 4 },
      { type: "code", offset: 13, length: 4 },
      { type: "pre", offset: 20, length: 18, language: "ts" }
    ]);
  });

  it("logs draft rejections and still delivers the final message", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
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

      telegram.nextDraftError = new Error("can't parse entities");

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

      expect(warnSpy).toHaveBeenCalledWith(
        "Failed to send Telegram draft",
        expect.objectContaining({
          entityCount: 2
        }),
        expect.any(Error)
      );
      expect(getFinalAnswerMessage(telegram)?.text).toBe("Use bold and code.");
      expect(getFinalAnswerMessage(telegram)?.options?.entities).toEqual([
        { type: "bold", offset: 4, length: 4 },
        { type: "code", offset: 13, length: 4 }
      ]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("keeps commentary out of the status draft and publishes it before the final answer", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 71,
      updateId: 81,
      userId: 42,
      text: "Summarize the change"
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

    const initialDraftCount = telegram.appliedDrafts.length;

    codex.emitNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "Inspecting the files"
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(telegram.drafts.at(-1)?.text).toBe("thinking · 0s");
    expect(telegram.drafts.at(-1)?.options?.entities).toBeUndefined();
    expect(telegram.sentMessages.at(-1)?.text).not.toBe("Inspecting the files");
    expect(telegram.appliedDrafts.length).toBe(initialDraftCount);
    expect(telegram.appliedDrafts.some((draft) => draft.text.includes("\nNow:"))).toBe(false);

    codex.emitNotification({
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

    codex.emitNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-2",
        delta: "Here is the answer."
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 450));

    expect(telegram.drafts.some((draft) => draft.text === "Here is the answer.")).toBe(true);
    expect(
      telegram.drafts.findLast((draft) => draft.text === "Here is the answer.")?.options?.entities
    ).toBeUndefined();

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

    const renderedCommentary = commentaryRendered("Inspecting the files");
    expect(telegram.sentMessages).toContainEqual(
      expect.objectContaining({
        text: renderedCommentary.text,
        options: expect.objectContaining({
          entities: renderedCommentary.entities
        })
      })
    );
    const commentaryIndex = telegram.sentMessages.findIndex((message) => message.text === renderedCommentary.text);
    const answerIndex = telegram.sentMessages.findIndex((message) => message.text === "Here is the answer.");
    expect(commentaryIndex).toBeGreaterThanOrEqual(0);
    expect(answerIndex).toBeGreaterThan(commentaryIndex);
    expect(getFinalAnswerMessage(telegram)?.text).toBe("Here is the answer.");
  });

  it("chunks long final assistant output into multiple Telegram messages", async () => {
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

    const partMessages = telegram.sentMessages.filter((message) => message.text.startsWith("Part "));
    expect(partMessages.length).toBeGreaterThan(1);
    expect(partMessages[0]?.text).toContain("Part 1/");
    expect(partMessages[1]?.text).toContain("Part 2/");
  });

  it("truncates oversized streaming draft previews", async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 0));

    const previewDraft = telegram.drafts.find((draft) => draft.text.includes("[preview truncated]"));
    expect(previewDraft).toBeTruthy();
    expect(previewDraft?.text.length).toBeLessThanOrEqual(3500);
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

  it("combines commentary items into one commentary message when the turn finalizes", async () => {
    codex.readTurnSnapshotResult = {
      text: "Final answer",
      assistantText: "Final answer"
    };

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 73,
      updateId: 83,
      userId: 42,
      text: "Narrate the work"
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
        delta: "Inspecting files"
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
          text: "Inspecting files",
          phase: "commentary"
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    codex.emitNotification({
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

    codex.emitNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-2",
        delta: "Planning edits"
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
          id: "item-2",
          text: "Planning edits",
          phase: "commentary"
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(telegram.sentMessages.some((message) => message.text.includes("Inspecting files"))).toBe(false);

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

    const renderedCommentary = commentaryRendered("Inspecting files", "Planning edits");
    expect(telegram.sentMessages).toContainEqual(
      expect.objectContaining({
        text: renderedCommentary.text,
        options: expect.objectContaining({
          entities: renderedCommentary.entities
        })
      })
    );
    expect(getFinalAnswerMessage(telegram)?.text).toBe("Final answer");
  });

  it("streams and persists plan items separately from assistant output", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 788,
      messageId: 300,
      updateId: 400,
      userId: 42,
      text: "Plan the rollout"
    });

    codex.emitNotification({
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
    codex.emitNotification({
      method: "turn/plan/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        explanation: "drafting the rollout",
        plan: [
          {
            step: "Draft the rollout",
            status: "inProgress"
          }
        ]
      }
    });
    codex.emitNotification({
      method: "item/plan/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "plan-1",
        delta: "Draft the rollout"
      }
    });
    await waitForAsyncNotifications();

    expect(telegram.drafts.some((draft) => draft.text === "Plan\n\nDraft the rollout")).toBe(false);

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

    expect(telegram.sentMessages.filter((message) => message.text === "Plan\n\n1. Draft the rollout")).toHaveLength(1);
  });

  it("publishes plan items as Mini App stubs instead of raw plan bubbles when Mini App support is configured", async () => {
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
    const miniAppBridge = new TelegramCodexBridge(miniAppConfig, database, miniAppTelegram, miniAppCodex, mediaStore);

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
    const url =
      (((stub?.options?.reply_markup as { inline_keyboard?: Array<Array<{ web_app?: { url?: string } }>> } | undefined)
        ?.inline_keyboard?.[0]?.[0]?.web_app?.url) ?? null);
    expect(url).toBeTruthy();
    expect(url?.startsWith("https://example.com/mini-app/plan#d=")).toBe(true);
    const encoded = getEncodedMiniAppArtifactFromHash(new URL(url!).hash);
    expect(encoded).toBeTruthy();
    expect(decodeMiniAppArtifact(encoded!)).toEqual({
      v: 1,
      type: MiniAppArtifactType.Plan,
      title: "Plan",
      markdownText: "1. Draft the rollout"
    });
  });

  it("falls back to raw plan bubbles when the Mini App public URL is not https", async () => {
    const invalidMiniAppConfig: AppConfig = {
      ...config,
      telegram: {
        ...config.telegram,
        miniApp: {
          publicUrl: "http://example.com/mini-app"
        }
      }
    };
    const invalidMiniAppCodex = new FakeCodex();
    const invalidMiniAppTelegram = new FakeTelegram();
    const invalidMiniAppBridge = new TelegramCodexBridge(
      invalidMiniAppConfig,
      database,
      invalidMiniAppTelegram,
      invalidMiniAppCodex,
      mediaStore
    );

    await invalidMiniAppBridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 788,
      messageId: 301,
      updateId: 401,
      userId: 42,
      text: "Plan the rollout"
    });

    invalidMiniAppCodex.emitNotification({
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
    invalidMiniAppCodex.emitNotification({
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

    expect(
      invalidMiniAppTelegram.sentMessages.filter((message) => message.text === "Plan\n\n1. Draft the rollout")
    ).toHaveLength(1);
    expect(
      invalidMiniAppTelegram.sentMessages.some((message) => message.text === "Plan is ready")
    ).toBe(false);
  });

  it("publishes an oversize stub instead of Telegram plan bubbles when the Mini App payload is too large", async () => {
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
      mediaStore
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

    expect(
      oversizeMiniAppTelegram.sentMessages.filter((message) => message.text === "Plan ready, but too large for Mini App link.")
    ).toHaveLength(1);
    expect(
      oversizeMiniAppTelegram.sentMessages.some((message) => message.text === "Plan is ready")
    ).toBe(false);
    expect(
      oversizeMiniAppTelegram.sentMessages.some((message) => message.text.startsWith("Plan\n\n"))
    ).toBe(false);
  });

  it("publishes one consolidated commentary message before completed plan artifacts", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 789,
      messageId: 301,
      updateId: 401,
      userId: 42,
      text: "Plan the rollout"
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
    codex.emitNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "Inspecting files"
      }
    });
    codex.emitNotification({
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
    codex.emitNotification({
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
    codex.emitNotification({
      method: "item/plan/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "plan-1",
        delta: "Draft the rollout"
      }
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

    const renderedCommentary = commentaryRendered("Inspecting files");
    expect(telegram.sentMessages.filter((message) => message.text === renderedCommentary.text)).toHaveLength(1);
    expect(
      telegram.sentMessages.find((message) => message.text === renderedCommentary.text)?.options?.entities
    ).toEqual(renderedCommentary.entities);
    const planIndex = telegram.sentMessages.findIndex((message) => message.text.startsWith("Plan"));
    expect(planIndex).toBeGreaterThanOrEqual(0);
    expect(
      telegram.sentMessages.findIndex((message) => message.text === renderedCommentary.text)
    ).toBeLessThan(planIndex);
  });

  it("flushes the latest draft after fast consecutive deltas", async () => {
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
        delta: "Hello"
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    codex.emitNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: " world"
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 450));

    expect(telegram.appliedDrafts.some((draft) => draft.text === "Hello world")).toBe(true);
  });

  it("does not let a stale delayed draft overwrite a newer one", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 10,
      updateId: 20,
      userId: 42,
      text: "Explain the fix"
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const firstDraft = deferred<void>();
    telegram.draftBlocks.push(firstDraft.promise);

    codex.emitNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "Hello"
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    codex.emitNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: " world"
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    firstDraft.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(telegram.appliedDrafts.some((draft) => draft.text === "Hello world")).toBe(true);
  });

  it("retries the latest draft after a retry-after response", async () => {
    telegram.nextDraftError = {
      parameters: {
        retry_after: 0
      }
    } as unknown as Error;

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
        delta: "Retry me"
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(telegram.appliedDrafts.some((draft) => draft.text === "Retry me")).toBe(true);
  });

  it("clears the assistant draft before sending the final persisted message", async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 0));

    codex.emitNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: " world"
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
    await waitForAsyncNotifications();

    expect(telegram.events).toContain("draft:Hello");
    expect(telegram.events.indexOf("draft:")).toBeGreaterThan(telegram.events.indexOf("draft:Hello"));
    expect(telegram.events.indexOf("message:Hello world")).toBeGreaterThan(telegram.events.indexOf("draft:"));
    expect(telegram.appliedDrafts.at(-1)?.text).toBe(EMPTY_DRAFT_TEXT);
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

    expect(
      telegram.drafts.some((draft) => draft.text === "Start from the inside.")
    ).toBe(true);
    expect(telegram.appliedDrafts.at(-1)?.text).toBe(EMPTY_DRAFT_TEXT);
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

    const turn = await database.getTurnById("turn-1");
    expect(turn.streamText).toBe("Hello from the inside.");
  });

  it("updates the temporary status before assistant text arrives", async () => {
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

    expect(
      telegram.drafts.some(
        (draft) => draft.text === "running: npm test · 0s"
      )
    ).toBe(true);
    expect(
      telegram.drafts.some(
        (draft) =>
          draft.text === "running: npm test · 0s" &&
          JSON.stringify(draft.options?.entities) ===
            JSON.stringify([
              {
                type: "code",
                offset: 9,
                length: "npm test".length
              }
            ])
      )
    ).toBe(true);
    expect(telegram.chatActions.some((action) => action.action === "typing")).toBe(true);
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
    expect(telegram.appliedDrafts.at(-1)?.text).toBe(EMPTY_DRAFT_TEXT);
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
    await new Promise((resolve) => setTimeout(resolve, 0));

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
    await new Promise((resolve) => setTimeout(resolve, 0));

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
    expect(telegram.edits.at(-1)?.text).toBe("Queued for next turn:\n- Start the next step");

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

    expect(telegram.sentMessages).toEqual([]);
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
    expect(telegram.sentMessages.at(-1)?.text).toBe("This command is not valid here.");
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
      "Wait for the current response to finish or stop it first before changing modes."
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
    expect(codex.turnCollaborationModes.at(-1)?.collaborationMode).toEqual({
      mode: "default",
      settings: {
        model: "gpt-5-codex",
        reasoning_effort: null,
        developer_instructions: config.codex.developerInstructions ?? null
      }
    });
    expect(telegram.sentMessages.at(-1)?.text).toBe("Exited plan mode.");
    const session = await database.getSessionByTopic(-1001, 784);
    expect(session?.preferredMode).toBe("default");
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
    expect(telegram.sentMessages.at(-1)?.text).toBe("Exited plan mode.");
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
    expect(telegram.sentMessages.at(-1)?.text).toBe("There is no active response to stop right now.");
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

    const interruptedTurn = await database.getTurnById("turn-1");
    expect(interruptedTurn.status).toBe("interrupted");
  });

  it("keeps queued follow-ups queued after an interrupted turn", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 45,
      updateId: 55,
      userId: 42,
      text: "Inspect the current failure"
    });

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 46,
      updateId: 56,
      userId: 42,
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
    expect(telegram.edits.at(-1)?.text).toBe("Queued for next turn:\n- Pending steer\n- Queued follow-up");
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
    expect(telegram.sentMessages.at(-1)?.options?.reply_markup).toEqual({
      inline_keyboard: [[{ text: "Refactor", callback_data: `req:${pending.id}:opt:0` }]]
    });

    await bridge.handleCallbackQuery({
      callbackQueryId: "callback-user-input-1",
      data: `req:${pending.id}:opt:0`,
      chatId: -1001,
      topicId: 786,
      userId: 42
    });

    expect(telegram.edits.at(-1)?.text).toContain("Question 2/2");

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 786,
      messageId: 421,
      updateId: 521,
      userId: 42,
      text: "Keep the diff small"
    });

    expect(codex.userInputs).toEqual([
      {
        id: 90,
        answers: {
          scope: { answers: ["Refactor"] },
          notes: { answers: ["Keep the diff small"] }
        }
      }
    ]);
    expect(telegram.edits.at(-1)?.text).toBe("Sent your answers to Codex.");
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
    expect(telegram.sentMessages.at(-1)?.text).toContain("Sensitive input. Your reply stays visible in this topic.");
    expect(telegram.sentMessages.at(-1)?.text).toContain("Standard: Use the default flow");

    await bridge.handleCallbackQuery({
      callbackQueryId: "callback-user-input-2",
      data: `req:${pending.id}:other`,
      chatId: -1001,
      topicId: 787,
      userId: 42
    });

    expect(telegram.edits.at(-1)?.text).toContain("Reply with your own answer in this topic.");

    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 787,
      messageId: 423,
      updateId: 523,
      userId: 42,
      text: "Use a custom rollout path"
    });

    expect(codex.userInputs).toContainEqual({
      id: 91,
      answers: {
        secret_choice: { answers: ["Use a custom rollout path"] }
      }
    });
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

    await bridge.handleCallbackQuery({
      callbackQueryId: "callback-1",
      data: `req:${pending.id}:accept`,
      chatId: -1001,
      topicId: 101,
      userId: 42
    });

    expect(codex.commandApprovals).toEqual([{ id: 88, decision: "accept" }]);
    const resolved = await database.getPendingRequest(JSON.stringify(88));
    expect(resolved.status).toBe("resolved");
    expect(telegram.edits.at(-1)?.text).toContain("accept");
  });

  it("ignores callback queries from users other than the configured Telegram user", async () => {
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

    expect(codex.interruptCalls).toHaveLength(0);
  });
});

function flattenTextInput(input: UserInput[]): string {
  return input
    .filter((item): item is Extract<UserInput, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}
