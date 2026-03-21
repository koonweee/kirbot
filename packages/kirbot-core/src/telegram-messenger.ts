import type { MessageEntity } from "grammy/types";
import type { LoggerLike } from "./logging";

export type TelegramInlineKeyboardButton =
  | {
      text: string;
      callback_data: string;
    }
  | {
      text: string;
      web_app: {
        url: string;
      };
    };

export type InlineKeyboardMarkup = {
  inline_keyboard: Array<Array<TelegramInlineKeyboardButton>>;
};

export type TelegramReplyKeyboardButton =
  | string
  | {
      text: string;
      icon_custom_emoji_id?: string;
      style?: "danger" | "success" | "primary";
    };

export type ReplyKeyboardMarkup = {
  keyboard: Array<Array<TelegramReplyKeyboardButton>>;
  is_persistent?: boolean;
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
  input_field_placeholder?: string;
  selective?: boolean;
};

export type ReplyKeyboardRemove = {
  remove_keyboard: true;
  selective?: boolean;
};

export type TelegramReplyMarkup = InlineKeyboardMarkup | ReplyKeyboardMarkup | ReplyKeyboardRemove;

export type TelegramSendOptions = {
  message_thread_id?: number;
  reply_to_message_id?: number;
  reply_markup?: TelegramReplyMarkup;
  entities?: MessageEntity[];
  disable_notification?: boolean;
};

export type TelegramEditOptions = {
  reply_markup?: InlineKeyboardMarkup;
  entities?: MessageEntity[];
};

export type TelegramDraftOptions = {
  message_thread_id?: number;
  entities?: MessageEntity[];
};

export type TelegramChatAction = "typing" | "upload_document";

export const TELEGRAM_FORUM_TOPIC_ICON_COLORS = [
  0x6fb9f0,
  0xffd67e,
  0xcb86db,
  0x8eee98,
  0xff93b2,
  0xfb6f5f
] as const;

export type TelegramForumTopicIconColor = (typeof TELEGRAM_FORUM_TOPIC_ICON_COLORS)[number];

export type TelegramCreateForumTopicOptions = {
  icon_color?: TelegramForumTopicIconColor;
  icon_custom_emoji_id?: string;
};

export interface TelegramApi {
  getForumTopicIconStickers(): Promise<Array<{ custom_emoji_id?: string }>>;
  createForumTopic(
    chatId: number,
    name: string,
    options?: TelegramCreateForumTopicOptions
  ): Promise<{ message_thread_id: number; name: string }>;
  sendMessage(chatId: number, text: string, options?: TelegramSendOptions): Promise<{ message_id: number }>;
  sendMessageDraft(chatId: number, draftId: number, text: string, options?: TelegramDraftOptions): Promise<true>;
  sendChatAction(
    chatId: number,
    action: "typing" | "upload_document",
    options?: {
      message_thread_id?: number;
    }
  ): Promise<true>;
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    options?: TelegramEditOptions
  ): Promise<unknown>;
  deleteMessage(chatId: number, messageId: number): Promise<true>;
  answerCallbackQuery(callbackQueryId: string, options?: { text?: string }): Promise<true>;
  downloadFile(fileId: string): Promise<{ bytes: Uint8Array; filePath?: string }>;
}

export type TelegramRenderedMessage = {
  text: string;
  entities?: MessageEntity[];
};

type TelegramPersistentMessageOptions = {
  disableNotification?: boolean;
};

export class TelegramMessenger {
  constructor(
    private readonly telegram: TelegramApi,
    private readonly logger: LoggerLike = console
  ) {}

  async sendMessage(input: {
    chatId: number;
    topicId?: number | null;
    text: string;
    entities?: MessageEntity[];
    replyToMessageId?: number;
    replyMarkup?: TelegramReplyMarkup;
    disableNotification?: boolean;
  }): Promise<{ messageId: number }> {
    const message = await this.retryTelegramRequest("send message", () =>
      this.telegram.sendMessage(
        input.chatId,
        input.text,
        buildTelegramSendOptions({
          ...(input.topicId !== undefined ? { topicId: input.topicId } : {}),
          ...(input.replyToMessageId !== undefined ? { replyToMessageId: input.replyToMessageId } : {}),
          ...(input.replyMarkup ? { replyMarkup: input.replyMarkup } : {}),
          ...(input.entities ? { entities: input.entities } : {}),
          ...(input.disableNotification !== undefined ? { disableNotification: input.disableNotification } : {})
        })
      )
    );
    return { messageId: message.message_id };
  }

  async editMessageText(input: {
    chatId: number;
    messageId: number;
    text: string;
    entities?: MessageEntity[];
    replyMarkup?: InlineKeyboardMarkup;
  }): Promise<unknown> {
    return this.retryTelegramRequest("edit message", () =>
      this.telegram.editMessageText(
        input.chatId,
        input.messageId,
        input.text,
        input.replyMarkup || input.entities
          ? {
              ...(input.replyMarkup ? { reply_markup: input.replyMarkup } : {}),
              ...(input.entities ? { entities: input.entities } : {})
            }
          : undefined
      )
    );
  }

  async sendChatAction(
    chatId: number,
    action: TelegramChatAction,
    options?: {
      message_thread_id?: number;
    }
  ): Promise<true> {
    return this.telegram.sendChatAction(chatId, action, options);
  }

  async sendMessageDraft(
    chatId: number,
    draftId: number,
    text: string,
    options?: TelegramDraftOptions
  ): Promise<true> {
    return this.telegram.sendMessageDraft(chatId, draftId, text, options);
  }

  async deleteMessage(chatId: number, messageId: number): Promise<true> {
    return this.telegram.deleteMessage(chatId, messageId);
  }

  async answerCallbackQuery(callbackQueryId: string, options?: { text?: string }): Promise<true> {
    return this.telegram.answerCallbackQuery(callbackQueryId, options);
  }

  async downloadFile(fileId: string): Promise<{ bytes: Uint8Array; filePath?: string }> {
    return this.telegram.downloadFile(fileId);
  }

  private async retryTelegramRequest<T>(action: string, operation: () => Promise<T>): Promise<T> {
    while (true) {
      try {
        return await operation();
      } catch (error) {
        const retryAfterMs = getTelegramRetryAfterMs(error);
        if (retryAfterMs === null) {
          throw error;
        }

        this.logger.warn(`Telegram ${action} rate limited; retrying in ${retryAfterMs}ms`, error);
        await delay(retryAfterMs);
      }
    }
  }
}

function buildTelegramSendOptions(input: {
  topicId?: number | null;
  replyToMessageId?: number;
  replyMarkup?: TelegramReplyMarkup;
  entities?: MessageEntity[];
} & TelegramPersistentMessageOptions): TelegramSendOptions {
  const disableNotification = input.disableNotification ?? true;
  return {
    ...(input.topicId !== null && input.topicId !== undefined ? { message_thread_id: input.topicId } : {}),
    ...(input.replyToMessageId !== undefined ? { reply_to_message_id: input.replyToMessageId } : {}),
    ...(input.replyMarkup ? { reply_markup: input.replyMarkup } : {}),
    ...(input.entities ? { entities: input.entities } : {}),
    ...(disableNotification ? { disable_notification: true } : {})
  };
}

function getTelegramRetryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const asRecord = error as Record<string, unknown>;
  const errorCode = Number(asRecord.error_code);
  if (errorCode !== 429) {
    return null;
  }

  const parameters = asRecord.parameters;
  if (parameters && typeof parameters === "object") {
    const retryAfter = Number((parameters as Record<string, unknown>).retry_after);
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      return retryAfter * 1000;
    }
  }

  const message = typeof asRecord.description === "string" ? asRecord.description : "";
  const match = /retry after (\d+)/i.exec(message);
  if (match) {
    const retryAfter = Number(match[1]);
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      return retryAfter * 1000;
    }
  }

  return 1000;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
