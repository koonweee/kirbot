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
  nextCreateForumTopicError: TelegramError | null = null;
  nextSendMessageError: TelegramError | null = null;
  nextSendPhotoError: TelegramError | null = null;
  nextEditMessageTextError: TelegramError | null = null;
  nextDeleteMessageError: Error | null = null;
  operationLog: string[] = [];
  createdTopics: Array<{ chatId: number; name: string; options?: TelegramCreateForumTopicOptions }> = [];
  sentMessages: Array<{ chatId: number; text: string; options?: TelegramSendOptions }> = [];
  sentPhotos: Array<{
    chatId: number;
    photo: Uint8Array;
    options?: {
      message_thread_id?: number;
      disable_notification?: boolean;
      file_name?: string;
      mime_type?: string;
    };
  }> = [];
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
    chatId: number,
    name: string,
    options?: TelegramCreateForumTopicOptions
  ): Promise<{ message_thread_id: number; name: string }> {
    if (this.nextCreateForumTopicError) {
      const error = this.nextCreateForumTopicError;
      this.nextCreateForumTopicError = null;
      throw error;
    }

    this.operationLog.push(`topic:${name}`);
    this.createdTopics.push(options ? { chatId, name, options } : { chatId, name });
    return { message_thread_id: 1, name };
  }

  async sendMessage(chatId: number, text: string, options?: TelegramSendOptions): Promise<{ message_id: number }> {
    if (this.nextSendMessageError) {
      const error = this.nextSendMessageError;
      this.nextSendMessageError = null;
      throw error;
    }

    this.messageCounter += 1;
    this.operationLog.push(`send:${text}`);
    this.sentMessages.push(options ? { chatId, text, options } : { chatId, text });
    return { message_id: this.messageCounter };
  }

  async sendPhoto(
    chatId: number,
    photo: Uint8Array,
    options?: {
      message_thread_id?: number;
      disable_notification?: boolean;
      file_name?: string;
      mime_type?: string;
    }
  ): Promise<{ message_id: number }> {
    if (this.nextSendPhotoError) {
      const error = this.nextSendPhotoError;
      this.nextSendPhotoError = null;
      throw error;
    }

    this.messageCounter += 1;
    this.operationLog.push(`photo:${photo.length}`);
    this.sentPhotos.push(options ? { chatId, photo, options } : { chatId, photo });
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
    this.operationLog.push(`chat-action:${action}`);
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

    this.operationLog.push(`edit:${messageId}:${text}`);
    this.edits.push(options ? { chatId, messageId, text, options } : { chatId, messageId, text });
    return true;
  }

  async deleteMessage(chatId: number, messageId: number): Promise<true> {
    this.operationLog.push(`delete:${chatId}:${messageId}`);
    if (this.nextDeleteMessageError) {
      const error = this.nextDeleteMessageError;
      this.nextDeleteMessageError = null;
      throw error;
    }
    return true;
  }

  async answerCallbackQuery(callbackQueryId: string): Promise<true> {
    this.operationLog.push(`callback:${callbackQueryId}`);
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

  it("sends standalone photos with topic routing, file hints, and muted notifications", async () => {
    const telegram = new FakeTelegram();
    const messenger = new TelegramMessenger(telegram);
    const sendPhoto = (messenger as unknown as {
      sendPhoto?: (input: {
        chatId: number;
        topicId?: number | null;
        bytes: Uint8Array;
        fileName?: string | null;
        mimeType?: string | null;
      }) => Promise<{ messageId: number }>;
    }).sendPhoto;

    expect(sendPhoto).toBeTypeOf("function");

    await sendPhoto!({
      chatId: 1,
      topicId: 2,
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "generated-image.png",
      mimeType: "image/png"
    });

    expect(telegram.sentPhotos).toEqual([
      {
        chatId: 1,
        photo: new Uint8Array([1, 2, 3]),
        options: {
          message_thread_id: 2,
          disable_notification: true,
          file_name: "generated-image.png",
          mime_type: "image/png"
        }
      }
    ]);
  });

  it("sends root-surface photos with muted visible-send behavior and no thread id shortcut", async () => {
    const telegram = new FakeTelegram();
    const messenger = new TelegramMessenger(telegram);
    const sendPhoto = (messenger as unknown as {
      sendPhoto?: (input: {
        chatId: number;
        topicId?: number | null;
        bytes: Uint8Array;
        fileName?: string | null;
        mimeType?: string | null;
      }) => Promise<{ messageId: number }>;
    }).sendPhoto;

    expect(sendPhoto).toBeTypeOf("function");

    await sendPhoto!({
      chatId: 1,
      topicId: null,
      bytes: new Uint8Array([4, 5, 6]),
      fileName: "root-image.jpg",
      mimeType: "image/jpeg"
    });

    expect(telegram.sentPhotos).toEqual([
      {
        chatId: 1,
        photo: new Uint8Array([4, 5, 6]),
        options: {
          disable_notification: true,
          file_name: "root-image.jpg",
          mime_type: "image/jpeg"
        }
      }
    ]);
  });

  it("retries rate-limited photo sends using Telegram retry_after", async () => {
    vi.useFakeTimers();

    try {
      const telegram = new FakeTelegram();
      const messenger = new TelegramMessenger(telegram);
      telegram.nextSendPhotoError = rateLimitError(1);
      const sendPhoto = (messenger as unknown as {
        sendPhoto?: (input: {
          chatId: number;
          topicId?: number | null;
          bytes: Uint8Array;
          fileName?: string | null;
          mimeType?: string | null;
        }) => Promise<{ messageId: number }>;
      }).sendPhoto;

      expect(sendPhoto).toBeTypeOf("function");

      const promise = sendPhoto!({
        chatId: 1,
        topicId: 2,
        bytes: new Uint8Array([7, 8, 9]),
        fileName: "retry-photo.png",
        mimeType: "image/png"
      });

      await Promise.resolve();
      expect(telegram.sentPhotos).toEqual([]);

      await vi.advanceTimersByTimeAsync(5000);
      await expect(promise).resolves.toEqual({ messageId: 1 });
      expect(telegram.sentPhotos).toEqual([
        {
          chatId: 1,
          photo: new Uint8Array([7, 8, 9]),
          options: {
            message_thread_id: 2,
            disable_notification: true,
            file_name: "retry-photo.png",
            mime_type: "image/png"
          }
        }
      ]);
    } finally {
      vi.useRealTimers();
    }
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

      await vi.advanceTimersByTimeAsync(5000);
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

      await vi.advanceTimersByTimeAsync(5000);
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

  it("routes topic creation through the scheduler retry path", async () => {
    vi.useFakeTimers();

    try {
      const telegram = new FakeTelegram();
      const messenger = new TelegramMessenger(telegram);
      telegram.nextCreateForumTopicError = rateLimitError(1);

      const promise = messenger.createForumTopic({
        chatId: 1,
        name: "Release Plan"
      });

      await Promise.resolve();
      expect(telegram.createdTopics).toEqual([]);

      await vi.advanceTimersByTimeAsync(10000);
      await expect(promise).resolves.toEqual({
        topicId: 1,
        name: "Release Plan"
      });
      expect(telegram.createdTopics).toEqual([
        {
          chatId: 1,
          name: "Release Plan"
        }
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prioritizes callback answers over queued low-priority deliveries", async () => {
    const telegram = new FakeTelegram();
    const messenger = new TelegramMessenger(telegram);

    const deletePromise = messenger.deleteMessage(1, 10);
    const actionPromise = messenger.sendChatAction(1, "typing");
    const callbackPromise = messenger.answerCallbackQuery("callback-1", {
      text: "Done"
    });

    await Promise.all([deletePromise, actionPromise, callbackPromise]);

    expect(telegram.operationLog.slice(0, 3)).toEqual([
      "callback:callback-1",
      "delete:1:10",
      "chat-action:typing"
    ]);
  });

  it("keeps deleteMessage best effort and lower priority than visible sends", async () => {
    const telegram = new FakeTelegram();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const messenger = new TelegramMessenger(telegram, logger);
    telegram.nextDeleteMessageError = new Error("message already gone");

    const deletePromise = messenger.deleteMessage(1, 10);
    const sendPromise = messenger.sendMessage({
      chatId: 1,
      topicId: 2,
      text: "Keep going"
    });

    await expect(deletePromise).resolves.toBe(true);
    await expect(sendPromise).resolves.toEqual({ messageId: 1 });
    expect(telegram.operationLog.slice(0, 2)).toEqual([
      "send:Keep going",
      "delete:1:10"
    ]);
    expect(logger.warn).toHaveBeenCalledWith("Telegram delete message failed; continuing", expect.any(Error));
  });

  it("logs scheduled retries after Telegram 429 responses", async () => {
    vi.useFakeTimers();

    try {
      const telegram = new FakeTelegram();
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      };
      const messenger = new TelegramMessenger(telegram, logger);
      telegram.nextSendMessageError = rateLimitError(1);

      const promise = messenger.sendMessage({
        chatId: 1,
        topicId: 2,
        text: "Retry with logging"
      });

      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5000);
      await expect(promise).resolves.toEqual({ messageId: 1 });
      expect(logger.warn).toHaveBeenCalledWith(
        "Telegram send message rate limited; retrying in 1000ms",
        expect.objectContaining({
          error_code: 429
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs superseded low-value deliveries when a replaceable edit is coalesced", async () => {
    const telegram = new FakeTelegram();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const messenger = new TelegramMessenger(telegram, logger);

    const first = messenger.editMessageText({
      chatId: 1,
      messageId: 7,
      text: "First",
      coalesceKey: "status:1:7",
      replacePending: true
    });
    const second = messenger.editMessageText({
      chatId: 1,
      messageId: 7,
      text: "Second",
      coalesceKey: "status:1:7",
      replacePending: true
    });

    await Promise.all([first, second]);

    expect(logger.info).toHaveBeenCalledWith("Telegram delivery superseded", {
      deliveryClass: "visible_edit",
      coalescingKey: "status:1:7"
    });
  });

  it("logs non-429 terminal delivery failures", async () => {
    const telegram = new FakeTelegram();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const messenger = new TelegramMessenger(telegram, logger);
    telegram.nextSendMessageError = new Error("boom");

    await expect(
      messenger.sendMessage({
        chatId: 1,
        topicId: 2,
        text: "Fail me"
      })
    ).rejects.toThrow("boom");

    expect(logger.warn).toHaveBeenCalledWith("Telegram delivery failed", {
      deliveryClass: "visible_send",
      error: expect.any(Error)
    });
  });

  it("keeps conservative default pacing for visible sends", async () => {
    vi.useFakeTimers();

    try {
      const telegram = new FakeTelegram();
      const messenger = new TelegramMessenger(telegram);

      const first = messenger.sendMessage({
        chatId: 1,
        topicId: 2,
        text: "First"
      });
      const second = messenger.sendMessage({
        chatId: 1,
        topicId: 2,
        text: "Second"
      });

      await Promise.resolve();
      await expect(first).resolves.toEqual({ messageId: 1 });
      expect(telegram.sentMessages).toEqual([
        {
          chatId: 1,
          text: "First",
          options: {
            message_thread_id: 2,
            disable_notification: true
          }
        }
      ]);

      await vi.advanceTimersByTimeAsync(249);
      expect(telegram.sentMessages).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      await expect(second).resolves.toEqual({ messageId: 2 });
      expect(telegram.sentMessages).toEqual([
        {
          chatId: 1,
          text: "First",
          options: {
            message_thread_id: 2,
            disable_notification: true
          }
        },
        {
          chatId: 1,
          text: "Second",
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
