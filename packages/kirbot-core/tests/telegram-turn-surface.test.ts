import { describe, expect, it } from "vitest";
import type { MessageEntity } from "grammy/types";

import { createTelegramTurnSurface } from "../src/bridge/telegram-turn-surface";
import { TelegramMessenger, type TelegramApi, type TelegramCreateForumTopicOptions } from "../src/telegram-messenger";

class FakeTelegram implements TelegramApi {
  messageCounter = 0;
  sentMessages: Array<{ chatId: number; text: string; options?: Record<string, unknown> }> = [];
  edits: Array<{ chatId: number; messageId: number; text: string; options?: Record<string, unknown> }> = [];
  deletions: Array<{ chatId: number; messageId: number }> = [];
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
    _chatId: number,
    _action: "typing" | "upload_document",
    _options?: { message_thread_id?: number }
  ): Promise<true> {
    return true;
  }

  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    options?: Record<string, unknown>
  ): Promise<unknown> {
    this.edits.push(options ? { chatId, messageId, text, options } : { chatId, messageId, text });
    return true;
  }

  async deleteMessage(chatId: number, messageId: number): Promise<true> {
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error("delete failed");
    }

    this.deletions.push({ chatId, messageId });
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
});
