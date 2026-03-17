import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TelegramCodexBridge, type BridgeCodexApi } from "../src/bridge";
import type { AppConfig } from "../src/config";
import { BridgeDatabase } from "../src/db";
import type { UserInput } from "../src/generated/codex/v2/UserInput";
import { TemporaryImageStore } from "../src/media-store";
import type { ServerNotification } from "../src/generated/codex/ServerNotification";
import type { ServerRequest } from "../src/generated/codex/ServerRequest";
import type { CommandExecutionApprovalDecision } from "../src/generated/codex/v2/CommandExecutionApprovalDecision";
import type { FileChangeApprovalDecision } from "../src/generated/codex/v2/FileChangeApprovalDecision";
import type { ToolRequestUserInputResponse } from "../src/generated/codex/v2/ToolRequestUserInputResponse";
import { JsonRpcMethodError } from "../src/rpc";
import type { TelegramApi } from "../src/telegram-messenger";

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

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function codeBlock(text: string, language?: string): string {
  if (language) {
    return `<pre><code class="language-${escapeHtml(language)}">${escapeHtml(text)}</code></pre>`;
  }

  return `<pre><code>${escapeHtml(text)}</code></pre>`;
}

function combinedDraft(...parts: string[]): string {
  return parts.join("\n\n");
}

class FakeCodex implements BridgeCodexApi {
  createdThreads: string[] = [];
  ensuredThreads: string[] = [];
  turns: Array<{ threadId: string; text: string; input: UserInput[]; turnId: string }> = [];
  steerCalls: Array<{ threadId: string; expectedTurnId: string; text: string; input: UserInput[] }> = [];
  interruptCalls: Array<{ threadId: string; turnId: string }> = [];
  commandApprovals: Array<{ id: string | number; decision: CommandExecutionApprovalDecision }> = [];
  fileApprovals: Array<{ id: string | number; decision: FileChangeApprovalDecision }> = [];
  userInputs: Array<{ id: string | number; answers: ToolRequestUserInputResponse["answers"] }> = [];
  unsupported: Array<{ id: string | number; message: string }> = [];
  readTurnMessagesResult = "";
  nextSteerError: Error | null = null;
  nextInterruptError: Error | null = null;

  #notificationListeners = new Set<(notification: ServerNotification) => void>();
  #requestListeners = new Set<(request: ServerRequest) => void>();

  async createThread(title: string): Promise<string> {
    this.createdThreads.push(title);
    return "thread-1";
  }

  async ensureThreadLoaded(threadId: string): Promise<void> {
    this.ensuredThreads.push(threadId);
  }

  async sendTurn(threadId: string, input: UserInput[]): Promise<{ id: string }> {
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

  async readTurnMessages(): Promise<string> {
    return this.readTurnMessagesResult;
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

  onNotification(listener: (notification: ServerNotification) => void): void {
    this.#notificationListeners.add(listener);
  }

  onServerRequest(listener: (request: ServerRequest) => void): void {
    this.#requestListeners.add(listener);
  }

  emitNotification(notification: ServerNotification): void {
    for (const listener of this.#notificationListeners) {
      listener(notification);
    }
  }

  emitRequest(request: ServerRequest): void {
    for (const listener of this.#requestListeners) {
      listener(request);
    }
  }
}

class FakeTelegram implements TelegramApi {
  topicCounter = 100;
  messageCounter = 500;
  nextChatActionError: Error | null = null;
  nextDraftError: Error | null = null;
  draftBlocks: Array<Promise<void>> = [];
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
    options?: {
      message_thread_id?: number;
      reply_to_message_id?: number;
      reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
      parse_mode?: "HTML";
    };
  }> = [];
  drafts: Array<{
    chatId: number;
    draftId: number;
    text: string;
    options?: { message_thread_id?: number; parse_mode?: "HTML" };
  }> = [];
  appliedDrafts: Array<{
    chatId: number;
    draftId: number;
    text: string;
    options?: { message_thread_id?: number; parse_mode?: "HTML" };
  }> = [];
  edits: Array<{ chatId: number; messageId: number; text: string }> = [];
  editOptions: Array<{
    chatId: number;
    messageId: number;
    options?: {
      message_thread_id?: number;
      reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
      parse_mode?: "HTML";
    };
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
    options?: {
      message_thread_id?: number;
      reply_to_message_id?: number;
      reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
      parse_mode?: "HTML";
    }
  ): Promise<{ message_id: number }> {
    this.messageCounter += 1;
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
    options?: { message_thread_id?: number; parse_mode?: "HTML" }
  ): Promise<true> {
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
    options?: {
      message_thread_id?: number;
      reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
      parse_mode?: "HTML";
    }
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
        chatId: -1001,
        allowedUserIds: new Set([42]),
        mediaTempDir: join(tempDir, "telegram-media")
      },
      database: {
        path: join(tempDir, "bridge.sqlite")
      },
      codex: {
        appServerUrl: "ws://127.0.0.1:8787",
        spawnAppServer: false,
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

    const session = await database.getSessionByTopic(-1001, 101);
    expect(session?.status).toBe("active");
    expect(session?.codexThreadId).toBe("thread-1");
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
    expect(telegram.drafts.at(-1)?.text).toBe("thinking");
    expect(telegram.chatActions.some((action) => action.action === "typing")).toBe(true);
  });

  it("downloads Telegram images into temp storage and forwards them as local images", async () => {
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
    expect(localImage && "path" in localImage ? existsSync(localImage.path) : true).toBe(false);
  });

  it("streams turn deltas and publishes the final completion message", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: null,
      messageId: 10,
      updateId: 20,
      userId: 42,
      text: "Explain the fix"
    });
    const stopControlMessageId = telegram.sentMessages.at(-1)?.messageId;

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(telegram.drafts.at(-1)?.text).toBe("thinking");

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
    expect(telegram.deletions).toEqual(
      stopControlMessageId ? [{ chatId: -1001, messageId: stopControlMessageId }] : []
    );
    expect(telegram.sentMessages.at(-1)?.text).toBe("Working on it");
    expect(telegram.appliedDrafts.at(-1)?.text).toBe(EMPTY_DRAFT_TEXT);

    const turn = await database.getTurnById("turn-1");
    expect(turn.status).toBe("completed");
  });

  it("formats assistant markdown as Telegram HTML for drafts and final messages", async () => {
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
      telegram.drafts.some((draft) => draft.text === "Use <b>bold</b> and <code>code</code>.")
    ).toBe(true);
    expect(telegram.chatActions.some((action) => action.action === "typing")).toBe(true);
    expect(telegram.appliedDrafts.at(-1)?.text).toBe(EMPTY_DRAFT_TEXT);
    expect(telegram.sentMessages.at(-1)?.text).toBe(
      "Use <b>bold</b> and <code>code</code>.\n\n<pre><code class=\"language-ts\">const answer = 42;</code></pre>"
    );
    expect(telegram.sentMessages.at(-1)?.options?.parse_mode).toBe("HTML");
  });

  it("streams commentary in its own draft and persists it when the turn finalizes", async () => {
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

    expect(telegram.drafts.at(-1)?.text).toBe(codeBlock("Inspecting the files", "kirbot"));
    expect(telegram.drafts.at(-1)?.options?.parse_mode).toBe("HTML");
    expect(telegram.sentMessages.at(-1)?.text).not.toBe(codeBlock("Inspecting the files", "kirbot"));
    expect(telegram.appliedDrafts.length).toBeGreaterThan(initialDraftCount);
    expect(telegram.appliedDrafts.some((draft) => draft.text === "thinking")).toBe(true);

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

    expect(telegram.drafts.at(-1)?.text).toBe("Here is the answer.");
    expect(telegram.drafts.at(-1)?.options?.parse_mode).toBeUndefined();

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

    expect(telegram.sentMessages.some((message) => message.text === codeBlock("Inspecting the files", "kirbot"))).toBe(true);
    expect(telegram.sentMessages.at(-1)?.text).toBe("Here is the answer.");
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

    expect(telegram.drafts.length).toBeGreaterThan(0);
    expect(telegram.drafts.at(-1)?.text.length).toBeLessThanOrEqual(3500);
    expect(telegram.drafts.at(-1)?.text).toContain("[preview truncated]");
  });

  it("windows oversized commentary drafts inside a code block", async () => {
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
    expect(telegram.drafts.some((draft) => draft.text.startsWith("<pre><code class=\"language-kirbot\">"))).toBe(true);
    expect(telegram.drafts.some((draft) => draft.options?.parse_mode === "HTML")).toBe(true);
  });

  it("persists one commentary message per commentary item on item completion", async () => {
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

    expect(telegram.sentMessages.at(-2)?.text).toBe(codeBlock("Inspecting files", "kirbot"));
    expect(telegram.sentMessages.at(-1)?.text).toBe(codeBlock("Planning edits", "kirbot"));
    expect(telegram.appliedDrafts.some((draft) => draft.text === "thinking")).toBe(true);
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

    expect(telegram.sentMessages.at(-1)?.text).toBe("That setup\n\nYes makes sense");
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
    expect(telegram.sentMessages.at(-1)?.text).toBe("Start from the inside.");
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

    expect(telegram.sentMessages.at(-1)?.text).toBe("Hello from the inside.");

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
        (draft) => draft.text === "running: npm test"
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

    expect(telegram.sentMessages.at(-1)?.text).toBe("Completed without streamed deltas");
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

  it("sends a stop control reply for each active turn", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 400,
      updateId: 500,
      userId: 42,
      text: "Inspect the current failure"
    });

    expect(telegram.sentMessages.at(-1)?.text).toBe(
      "Working on this request. Send another message to steer, or tap Stop."
    );
    expect(telegram.sentMessages.at(-1)?.options).toEqual({
      message_thread_id: 777,
      reply_to_message_id: 400,
      reply_markup: {
        inline_keyboard: [[{ text: "Stop", callback_data: "turn:turn-1:stop" }]]
      }
    });
  });

  it("interrupts the active turn from the stop control and cleans it up on completion", async () => {
    await bridge.handleUserTextMessage({
      chatId: -1001,
      topicId: 777,
      messageId: 401,
      updateId: 501,
      userId: 42,
      text: "Inspect the current failure"
    });

    const stopControlMessageId = telegram.sentMessages.at(-1)?.messageId;

    await bridge.handleCallbackQuery({
      callbackQueryId: "callback-stop",
      data: "turn:turn-1:stop",
      chatId: -1001,
      topicId: 777
    });

    expect(codex.interruptCalls).toEqual([{ threadId: "thread-1", turnId: "turn-1" }]);
    expect(telegram.edits).toContainEqual({
      chatId: -1001,
      messageId: stopControlMessageId ?? -1,
      text: "Stopping this turn…"
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

    expect(telegram.deletions).toContainEqual({
      chatId: -1001,
      messageId: stopControlMessageId ?? -1
    });
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
      topicId: 777
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
      topicId: 777
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
      topicId: 777
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
      topicId: 777
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
      topicId: 101
    });

    expect(codex.commandApprovals).toEqual([{ id: 88, decision: "accept" }]);
    const resolved = await database.getPendingRequest(JSON.stringify(88));
    expect(resolved.status).toBe("resolved");
    expect(telegram.edits.at(-1)?.text).toContain("accept");
  });
});

function flattenTextInput(input: UserInput[]): string {
  return input
    .filter((item): item is Extract<UserInput, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}
