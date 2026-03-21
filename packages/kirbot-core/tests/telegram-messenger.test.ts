import { describe, expect, it, vi } from "vitest";
import type { MessageEntity } from "grammy/types";

import {
  TELEGRAM_FORUM_TOPIC_ICON_COLORS,
  TelegramMessenger,
  type InlineKeyboardMarkup,
  type TelegramApi,
  type TelegramCreateForumTopicOptions,
  type TelegramSendOptions
} from "../src/telegram-messenger";

type TelegramError = Error & {
  error_code?: number;
  parameters?: {
    retry_after?: number;
  };
};

class FakeTelegram implements TelegramApi {
  messageCounter = 0;
  nextSendMessageError: TelegramError | null = null;
  nextEditMessageTextError: TelegramError | null = null;
  sentMessages: Array<{ chatId: number; text: string; options?: TelegramSendOptions }> = [];
  edits: Array<{
    chatId: number;
    messageId: number;
    text: string;
    options?: { reply_markup?: InlineKeyboardMarkup; entities?: MessageEntity[] };
  }> = [];
  chatActions: Array<{
    chatId: number;
    action: "typing" | "upload_document";
    options?: { message_thread_id?: number };
  }> = [];

  async getForumTopicIconStickers(): Promise<Array<{ custom_emoji_id?: string }>> {
    return [{ custom_emoji_id: "emoji-1" }];
  }

  async createForumTopic(
    _chatId: number,
    name: string,
    _options?: TelegramCreateForumTopicOptions
  ): Promise<{ message_thread_id: number; name: string }> {
    return { message_thread_id: 1, name };
  }

  async sendMessage(chatId: number, text: string, options?: TelegramSendOptions): Promise<{ message_id: number }> {
    if (this.nextSendMessageError) {
      const error = this.nextSendMessageError;
      this.nextSendMessageError = null;
      throw error;
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
    options?: { reply_markup?: InlineKeyboardMarkup; entities?: MessageEntity[] }
  ): Promise<unknown> {
    if (this.nextEditMessageTextError) {
      const error = this.nextEditMessageTextError;
      this.nextEditMessageTextError = null;
      throw error;
    }

    this.edits.push(options ? { chatId, messageId, text, options } : { chatId, messageId, text });
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

function rateLimitError(retryAfterSeconds: number): TelegramError {
  const error = new Error("Too Many Requests") as TelegramError;
  error.error_code = 429;
  error.parameters = { retry_after: retryAfterSeconds };
  return error;
}

describe("TelegramMessenger", () => {
  it("exports the supported forum topic icon colors", () => {
    expect(TELEGRAM_FORUM_TOPIC_ICON_COLORS).toEqual([0x6fb9f0, 0xffd67e, 0xcb86db, 0x8eee98, 0xff93b2, 0xfb6f5f]);
  });

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
          entities,
          disable_notification: true
        }
      }
    ]);
  });

  it("sends root-surface messages without a thread id", async () => {
    const telegram = new FakeTelegram();
    const messenger = new TelegramMessenger(telegram);

    await messenger.sendMessage({
      chatId: 1,
      topicId: null,
      text: "Root response"
    });

    expect(telegram.sentMessages).toEqual([
      {
        chatId: 1,
        text: "Root response",
        options: {
          disable_notification: true
        }
      }
    ]);
  });

  it("edits messages with markup and entities", async () => {
    const telegram = new FakeTelegram();
    const messenger = new TelegramMessenger(telegram);

    await messenger.editMessageText({
      chatId: 1,
      messageId: 99,
      text: "Updated",
      entities: [{ type: "italic", offset: 0, length: 7 }],
      replyMarkup: {
        inline_keyboard: [[{ text: "Open", callback_data: "open" }]]
      }
    });

    expect(telegram.edits).toEqual([
      {
        chatId: 1,
        messageId: 99,
        text: "Updated",
        options: {
          entities: [{ type: "italic", offset: 0, length: 7 }],
          reply_markup: {
            inline_keyboard: [[{ text: "Open", callback_data: "open" }]]
          }
        }
      }
    ]);
  });

  it("retries rate-limited sends using Telegram retry_after", async () => {
    vi.useFakeTimers();

    try {
      const telegram = new FakeTelegram();
      const messenger = new TelegramMessenger(telegram);
      telegram.nextSendMessageError = rateLimitError(1);

      const promise = messenger.sendMessage({
        chatId: 1,
        topicId: 2,
        text: "Retry me"
      });

      await Promise.resolve();
      expect(telegram.sentMessages).toEqual([]);

      await vi.advanceTimersByTimeAsync(1000);
      await expect(promise).resolves.toEqual({ messageId: 1 });
      expect(telegram.sentMessages).toEqual([
        {
          chatId: 1,
          text: "Retry me",
          options: {
            message_thread_id: 2,
            disable_notification: true
          }
        }
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries rate-limited edits using Telegram retry_after", async () => {
    vi.useFakeTimers();

    try {
      const telegram = new FakeTelegram();
      const messenger = new TelegramMessenger(telegram);
      telegram.nextEditMessageTextError = rateLimitError(1);

      const promise = messenger.editMessageText({
        chatId: 1,
        messageId: 7,
        text: "Retry edit"
      });

      await Promise.resolve();
      expect(telegram.edits).toEqual([]);

      await vi.advanceTimersByTimeAsync(1000);
      await expect(promise).resolves.toBe(true);
      expect(telegram.edits).toEqual([
        {
          chatId: 1,
          messageId: 7,
          text: "Retry edit"
        }
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends topic messages with reply keyboards", async () => {
    const telegram = new FakeTelegram();
    const messenger = new TelegramMessenger(telegram);

    await messenger.sendMessage({
      chatId: 1,
      topicId: 2,
      text: "Thread commands refreshed",
      replyMarkup: {
        keyboard: [["/stop", "/plan"], ["/standup"]],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    });

    expect(telegram.sentMessages).toEqual([
      {
        chatId: 1,
        text: "Thread commands refreshed",
        options: {
          message_thread_id: 2,
          reply_markup: {
            keyboard: [["/stop", "/plan"], ["/standup"]],
            resize_keyboard: true,
            one_time_keyboard: true
          },
          disable_notification: true
        }
      }
    ]);
  });

  it("allows persistent messages to notify when requested", async () => {
    const telegram = new FakeTelegram();
    const messenger = new TelegramMessenger(telegram);

    await messenger.sendMessage({
      chatId: 1,
      topicId: 2,
      text: "Need attention",
      disableNotification: false
    });

    expect(telegram.sentMessages).toEqual([
      {
        chatId: 1,
        text: "Need attention",
        options: {
          message_thread_id: 2
        }
      }
    ]);
  });
});
