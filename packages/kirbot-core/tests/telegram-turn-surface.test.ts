import { describe, expect, it, vi } from "vitest";
import type { MessageEntity } from "grammy/types";

import { createTelegramTurnSurface } from "../src/bridge/telegram-turn-surface";
import { TelegramMessenger, type TelegramApi, type TelegramCreateForumTopicOptions } from "../src/telegram-messenger";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
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

class FakeTelegram implements TelegramApi {
  messageCounter = 0;
  sentMessages: Array<{ chatId: number; text: string; options?: Record<string, unknown> }> = [];
  edits: Array<{ chatId: number; messageId: number; text: string; options?: Record<string, unknown> }> = [];
  deletions: Array<{ chatId: number; messageId: number }> = [];
  chatActions: Array<{ chatId: number; action: "typing" | "upload_document"; options?: { message_thread_id?: number } }> = [];
  editBlocks: Array<Promise<void>> = [];
  deleteBlocks: Array<Promise<void>> = [];
  nextEditMessageTextError: Error | null = null;
  failNextSend = false;
  failNextDelete = false;

  async getForumTopicIconStickers(): Promise<Array<{ custom_emoji_id?: string }>> {
    return [];
  }

  async createForumTopic(
    _chatId: number,
    _name: string,
    _options?: TelegramCreateForumTopicOptions
  ): Promise<{ message_thread_id: number; name: string }> {
    throw new Error("Not implemented");
  }

  async sendMessage(
    chatId: number,
    text: string,
    options?: Record<string, unknown>
  ): Promise<{ message_id: number }> {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error("send failed");
    }

    this.messageCounter += 1;
    this.sentMessages.push(options ? { chatId, text, options } : { chatId, text });
    return { message_id: this.messageCounter };
  }

  async sendMessageDraft(
    _chatId: number,
    _draftId: number,
    _text: string,
    _options?: { message_thread_id?: number; entities?: MessageEntity[] }
  ): Promise<true> {
    return true;
  }

  async sendChatAction(
    chatId: number,
    action: "typing" | "upload_document",
    options?: { message_thread_id?: number }
  ): Promise<true> {
    this.chatActions.push(options ? { chatId, action, options } : { chatId, action });
    return true;
  }

  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    options?: Record<string, unknown>
  ): Promise<unknown> {
    if (this.nextEditMessageTextError) {
      const error = this.nextEditMessageTextError;
      this.nextEditMessageTextError = null;
      throw error;
    }

    this.edits.push(options ? { chatId, messageId, text, options } : { chatId, messageId, text });
    const blocker = this.editBlocks.shift();
    if (blocker) {
      await blocker;
    }
    return true;
  }

  async deleteMessage(chatId: number, messageId: number): Promise<true> {
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error("delete failed");
    }

    this.deletions.push({ chatId, messageId });
    const blocker = this.deleteBlocks.shift();
    if (blocker) {
      await blocker;
    }
    return true;
  }

  async answerCallbackQuery(_callbackQueryId: string, _options?: { text?: string }): Promise<true> {
    return true;
  }

  async downloadFile(_fileId: string): Promise<{ bytes: Uint8Array; filePath?: string }> {
    return { bytes: new Uint8Array() };
  }
}

describe("Telegram turn surfaces", () => {
  it("uses a dedicated status bubble in the default mode", async () => {
    const telegram = new FakeTelegram();
    const surface = createTelegramTurnSurface({
      messenger: new TelegramMessenger(telegram),
      chatId: -1001,
      topicId: 777
    });

    await surface.updateStatus({ text: "thinking" }, true);
    await surface.updateStatus({ text: "running" }, true);

    expect(telegram.sentMessages).toHaveLength(1);
    expect(telegram.sentMessages[0]?.text).toBe("thinking");
    expect(telegram.edits).toEqual([
      {
        chatId: -1001,
        messageId: 1,
        text: "running"
      }
    ]);
  });

  it("does not expose assistant streaming updates in the default mode", async () => {
    const telegram = new FakeTelegram();
    const surface = createTelegramTurnSurface({
      messenger: new TelegramMessenger(telegram),
      chatId: -1001,
      topicId: 777
    });

    expect("applyAssistantRenderUpdate" in surface).toBe(false);
  });

  it("sends a final assistant bubble and deletes the status bubble on success", async () => {
    const telegram = new FakeTelegram();
    const surface = createTelegramTurnSurface({
      messenger: new TelegramMessenger(telegram),
      chatId: -1001,
      topicId: 777
    });

    await surface.updateStatus({ text: "thinking" }, true);

    const messageId = await surface.publishFinalAssistantMessage(
      { text: "Final answer" },
      {
        disableNotification: false,
        replyMarkup: {
          inline_keyboard: [[{ text: "Response", callback_data: "response" }]]
        }
      }
    );

    expect(messageId).toBe(2);
    expect(telegram.sentMessages.map((entry) => entry.text)).toEqual(["thinking", "Final answer"]);
    expect(telegram.deletions).toEqual([{ chatId: -1001, messageId: 1 }]);
  });

  it("keeps and edits the status bubble when completion has no publishable assistant message", async () => {
    const telegram = new FakeTelegram();
    const surface = createTelegramTurnSurface({
      messenger: new TelegramMessenger(telegram),
      chatId: -1001,
      topicId: 777
    });

    await surface.updateStatus({ text: "planning" }, true);
    const messageId = await surface.publishTerminalStatus({ text: "completed" });

    expect(messageId).toBe(1);
    expect(telegram.sentMessages).toHaveLength(1);
    expect(telegram.edits).toEqual([
      {
        chatId: -1001,
        messageId: 1,
        text: "completed"
      }
    ]);
    expect(telegram.deletions).toHaveLength(0);
  });

  it("preserves the status bubble if final assistant send fails", async () => {
    const telegram = new FakeTelegram();
    const surface = createTelegramTurnSurface({
      messenger: new TelegramMessenger(telegram),
      chatId: -1001,
      topicId: 777
    });

    await surface.updateStatus({ text: "thinking" }, true);
    telegram.failNextSend = true;

    const messageId = await surface.publishFinalAssistantMessage({ text: "Final answer" });

    expect(messageId).toBeNull();
    expect(telegram.sentMessages).toHaveLength(1);
    expect(telegram.deletions).toHaveLength(0);
    expect(telegram.edits.at(-1)?.text).toBe("failed");
  });

  it("treats status deletion as best effort after final assistant send", async () => {
    const telegram = new FakeTelegram();
    const surface = createTelegramTurnSurface({
      messenger: new TelegramMessenger(telegram),
      chatId: -1001,
      topicId: 777
    });

    await surface.updateStatus({ text: "thinking" }, true);
    telegram.failNextDelete = true;

    const messageId = await surface.publishFinalAssistantMessage({ text: "Final answer" });

    expect(messageId).toBe(2);
    expect(telegram.sentMessages.map((entry) => entry.text)).toEqual(["thinking", "Final answer"]);
    expect(telegram.deletions).toHaveLength(0);
  });

  it("collapses multiple rapid status updates to the latest pending edit", async () => {
    const telegram = new FakeTelegram();
    const surface = createTelegramTurnSurface({
      messenger: new TelegramMessenger(telegram),
      chatId: -1001,
      topicId: 777
    });

    await surface.updateStatus({ text: "thinking" }, true);

    const blockedEdit = deferred();
    telegram.editBlocks.push(blockedEdit.promise);

    const firstUpdate = surface.updateStatus({ text: "running" }, true);
    await waitForCondition(() => telegram.edits.some((edit) => edit.text === "running"));
    const secondUpdate = surface.updateStatus({ text: "searching" }, true);
    const thirdUpdate = surface.updateStatus({ text: "editing" }, true);

    blockedEdit.resolve();
    await Promise.all([firstUpdate, secondUpdate, thirdUpdate]);

    expect(telegram.edits.map((edit) => edit.text)).toEqual(["running", "editing"]);
  });

  it("lets final assistant publish supersede queued intermediate status edits", async () => {
    const telegram = new FakeTelegram();
    const surface = createTelegramTurnSurface({
      messenger: new TelegramMessenger(telegram),
      chatId: -1001,
      topicId: 777
    });

    await surface.updateStatus({ text: "thinking" }, true);

    const blockedEdit = deferred();
    telegram.editBlocks.push(blockedEdit.promise);

    const runningUpdate = surface.updateStatus({ text: "running" }, true);
    await waitForCondition(() => telegram.edits.some((edit) => edit.text === "running"));
    const searchingUpdate = surface.updateStatus({ text: "searching" }, true);
    const finalPublish = surface.publishFinalAssistantMessage({ text: "Final answer" });

    blockedEdit.resolve();
    const [, , finalMessageId] = await Promise.all([runningUpdate, searchingUpdate, finalPublish]);

    expect(finalMessageId).toBe(2);
    expect(telegram.edits.map((edit) => edit.text)).toEqual(["running"]);
    expect(telegram.sentMessages.map((entry) => entry.text)).toEqual(["thinking", "Final answer"]);
  });

  it("keeps terminal status after an older blocked status edit completes", async () => {
    const telegram = new FakeTelegram();
    const surface = createTelegramTurnSurface({
      messenger: new TelegramMessenger(telegram),
      chatId: -1001,
      topicId: 777
    });

    await surface.updateStatus({ text: "thinking" }, true);

    const blockedEdit = deferred();
    telegram.editBlocks.push(blockedEdit.promise);

    const runningUpdate = surface.updateStatus({ text: "running" }, true);
    await waitForCondition(() => telegram.edits.some((edit) => edit.text === "running"));

    const terminalPublish = surface.publishTerminalStatus({ text: "completed" });
    blockedEdit.resolve();

    const [, messageId] = await Promise.all([runningUpdate, terminalPublish]);

    expect(messageId).toBe(1);
    expect(telegram.edits.map((edit) => edit.text)).toEqual(["running", "completed"]);
    expect(telegram.edits.at(-1)?.text).toBe("completed");
  });

  it("keeps failed fallback after an older blocked status edit completes", async () => {
    const telegram = new FakeTelegram();
    const surface = createTelegramTurnSurface({
      messenger: new TelegramMessenger(telegram),
      chatId: -1001,
      topicId: 777
    });

    await surface.updateStatus({ text: "thinking" }, true);

    const blockedEdit = deferred();
    telegram.editBlocks.push(blockedEdit.promise);

    const runningUpdate = surface.updateStatus({ text: "running" }, true);
    await waitForCondition(() => telegram.edits.some((edit) => edit.text === "running"));

    telegram.failNextSend = true;
    const finalPublish = surface.publishFinalAssistantMessage({ text: "Final answer" });
    blockedEdit.resolve();

    const [, messageId] = await Promise.all([runningUpdate, finalPublish]);

    expect(messageId).toBeNull();
    expect(telegram.edits.map((edit) => edit.text)).toEqual(["running", "failed"]);
    expect(telegram.edits.at(-1)?.text).toBe("failed");
  });

  it("does not let a retried 429 status edit delay final assistant publish", async () => {
    vi.useFakeTimers();
    try {
      const telegram = new FakeTelegram();
      const surface = createTelegramTurnSurface({
        messenger: new TelegramMessenger(telegram, console, {
          visibleSendSpacingMs: 0,
          visibleEditSpacingMs: 0,
          deleteSpacingMs: 0
        }),
        chatId: -1001,
        topicId: 777
      });

      await surface.updateStatus({ text: "thinking" }, true);
      telegram.nextEditMessageTextError = rateLimitError(1);

      const staleStatusUpdate = surface.updateStatus({ text: "running" }, true);
      await Promise.resolve();

      const finalPublish = surface.publishFinalAssistantMessage({ text: "Final answer" });
      const publishResult = await Promise.race([
        finalPublish.then((messageId) => ({ kind: "final" as const, messageId })),
        vi.advanceTimersByTimeAsync(100).then(() => ({ kind: "timeout" as const }))
      ]);

      expect(publishResult).toEqual({
        kind: "final",
        messageId: 2
      });
      expect(telegram.sentMessages.map((entry) => entry.text)).toEqual(["thinking", "Final answer"]);
      await expect(staleStatusUpdate).resolves.toBeUndefined();

      await vi.advanceTimersByTimeAsync(5_000);
      await vi.runOnlyPendingTimersAsync();
      expect(telegram.edits).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips chat actions when a visible status bubble already exists", async () => {
    vi.useFakeTimers();
    try {
      const telegram = new FakeTelegram();
      const surface = createTelegramTurnSurface({
        messenger: new TelegramMessenger(telegram),
        chatId: -1001,
        topicId: 777
      });

      await surface.updateStatus({ text: "thinking" }, true);
      vi.advanceTimersByTime(4_000);

      await surface.updateStatus({ text: "running" }, true);

      expect(telegram.chatActions).toEqual([
        {
          chatId: -1001,
          action: "typing",
          options: { message_thread_id: 777 }
        }
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not repeat chat actions when only low-value churn is happening", async () => {
    vi.useFakeTimers();
    try {
      const telegram = new FakeTelegram();
      const surface = createTelegramTurnSurface({
        messenger: new TelegramMessenger(telegram),
        chatId: -1001,
        topicId: 777
      });

      await surface.updateStatus({ text: "thinking" }, true);
      vi.advanceTimersByTime(4_000);

      await surface.updateStatus({ text: "thinking" }, false);

      expect(telegram.chatActions).toHaveLength(1);
      expect(telegram.edits).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
