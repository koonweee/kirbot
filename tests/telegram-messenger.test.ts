import { describe, expect, it, vi } from "vitest";
import type { MessageEntity } from "grammy/types";

import {
  TelegramMessenger,
  type TelegramApi,
  type TelegramDraftOptions,
  type TelegramSendOptions
} from "../src/telegram-messenger";

const EMPTY_DRAFT_TEXT = "";

class FakeTelegram implements TelegramApi {
  messageCounter = 0;
  rejectEmptyDrafts = false;
  rejectEntityDrafts = false;
  sentMessages: Array<{ chatId: number; text: string; options?: TelegramSendOptions }> = [];
  drafts: Array<{ chatId: number; draftId: number; text: string; options?: TelegramDraftOptions }> = [];
  chatActions: Array<{
    chatId: number;
    action: "typing" | "upload_document";
    options?: { message_thread_id?: number };
  }> = [];
  nextChatActionError: Error | null = null;

  async createForumTopic(chatId: number, name: string): Promise<{ message_thread_id: number; name: string }> {
    return { message_thread_id: 1, name };
  }

  async sendMessage(chatId: number, text: string, options?: TelegramSendOptions): Promise<{ message_id: number }> {
    this.messageCounter += 1;
    this.sentMessages.push(options ? { chatId, text, options } : { chatId, text });
    return { message_id: this.messageCounter };
  }

  async sendMessageDraft(
    chatId: number,
    draftId: number,
    text: string,
    options?: TelegramDraftOptions
  ): Promise<true> {
    this.drafts.push(options ? { chatId, draftId, text, options } : { chatId, draftId, text });
    if (this.rejectEmptyDrafts && text === "") {
      throw new Error("text must be non-empty");
    }
    if (this.rejectEntityDrafts && options?.entities?.length) {
      throw new Error("can't parse entities");
    }
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

  async editMessageText(): Promise<unknown> {
    return true;
  }

  async deleteMessage(): Promise<true> {
    return true;
  }

  async answerCallbackQuery(): Promise<true> {
    return true;
  }

  async downloadFile(): Promise<{ bytes: Uint8Array; filePath?: string }> {
    return { bytes: new Uint8Array() };
  }
}

describe("TelegramMessenger", () => {
  it("sends messages with topic and entities", async () => {
    const telegram = new FakeTelegram();
    const messenger = new TelegramMessenger(telegram);
    const entities: MessageEntity[] = [{ type: "bold", offset: 0, length: 5 }];

    const message = await messenger.sendMessage({
      chatId: 1,
      topicId: 2,
      text: "Hello",
      entities
    });

    expect(message).toEqual({ messageId: 1 });
    expect(telegram.sentMessages).toEqual([
      {
        chatId: 1,
        text: "Hello",
        options: {
          message_thread_id: 2,
          entities
        }
      }
    ]);
  });

  it("does not send a clear draft for an unused stream", async () => {
    const telegram = new FakeTelegram();
    const messenger = new TelegramMessenger(telegram);
    const stream = messenger.streamMessage({
      chatId: 1,
      topicId: 2,
      draftId: 99
    });

    await stream.clear();

    expect(telegram.drafts).toEqual([]);
  });

  it("streams draft content, finalizes a persistent message, and clears the draft", async () => {
    const telegram = new FakeTelegram();
    const messenger = new TelegramMessenger(telegram);
    const stream = messenger.streamMessage({
      chatId: 1,
      topicId: 2,
      draftId: 100
    });

    await stream.update({ text: "Working" }, true);
    await stream.finalize({ text: "Done" });

    expect(telegram.drafts).toEqual([
      {
        chatId: 1,
        draftId: 100,
        text: "Working",
        options: {
          message_thread_id: 2
        }
      },
      {
        chatId: 1,
        draftId: 100,
        text: EMPTY_DRAFT_TEXT,
        options: {
          message_thread_id: 2
        }
      }
    ]);
    expect(telegram.sentMessages).toEqual([
      {
        chatId: 1,
        text: "Done",
        options: {
          message_thread_id: 2
        }
      }
    ]);
    expect(telegram.chatActions).toEqual([
      {
        chatId: 1,
        action: "typing",
        options: {
          message_thread_id: 2
        }
      }
    ]);
  });

  it("ignores draft clear failures after finalizing the persistent message", async () => {
    const telegram = new FakeTelegram();
    const messenger = new TelegramMessenger(telegram);
    const stream = messenger.streamMessage({
      chatId: 1,
      topicId: 2,
      draftId: 101
    });

    await stream.update({ text: "Working" }, true);
    telegram.rejectEmptyDrafts = true;

    await expect(stream.finalize({ text: "Done" })).resolves.toBe(1);

    expect(telegram.sentMessages).toEqual([
      {
        chatId: 1,
        text: "Done",
        options: {
          message_thread_id: 2
        }
      }
    ]);
  });

  it("throttles repeated chat actions for the same stream handle", async () => {
    const telegram = new FakeTelegram();
    const messenger = new TelegramMessenger(telegram);
    const stream = messenger.streamMessage({
      chatId: 1,
      topicId: 2,
      draftId: 102
    });

    await stream.update({ text: "First" }, true);
    await stream.update({ text: "Second" }, true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(telegram.chatActions).toHaveLength(1);
    expect(telegram.drafts.map((draft) => draft.text)).toEqual(["First", "Second"]);
  });

  it("does not fail draft delivery when chat action is rate limited", async () => {
    const telegram = new FakeTelegram();
    const messenger = new TelegramMessenger(telegram);
    const status = messenger.statusDraft({
      chatId: 1,
      topicId: 2,
      draftId: 103
    });

    telegram.nextChatActionError = {
      parameters: {
        retry_after: 4
      }
    } as unknown as Error;

    await status.set({ text: "thinking" }, true);

    expect(telegram.drafts).toEqual([
      {
        chatId: 1,
        draftId: 103,
        text: "thinking",
        options: {
          message_thread_id: 2
        }
      }
    ]);
    expect(telegram.chatActions).toHaveLength(1);
  });

  it("logs draft send failures instead of mutating the entity payload", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const telegram = new FakeTelegram();
    telegram.rejectEntityDrafts = true;
    const messenger = new TelegramMessenger(telegram);
    const stream = messenger.streamMessage({
      chatId: 1,
      topicId: 2,
      draftId: 104
    });
    const entities: MessageEntity[] = [{ type: "bold", offset: 4, length: 4 }];

    try {
      await stream.update({ text: "Use bold", entities }, true);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(telegram.drafts).toHaveLength(1);
      expect(telegram.drafts[0]).toMatchObject({
        chatId: 1,
        draftId: 104,
        text: "Use bold",
        options: {
          message_thread_id: 2,
          entities
        }
      });
      expect(warnSpy).toHaveBeenCalledWith(
        "Failed to send Telegram draft",
        expect.objectContaining({
          chatId: 1,
          topicId: 2,
          draftId: 104,
          entityCount: 1
        }),
        expect.any(Error)
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
