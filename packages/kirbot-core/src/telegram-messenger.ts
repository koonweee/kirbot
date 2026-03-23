import type { MessageEntity } from "grammy/types";
import type { LoggerLike } from "./logging";
import {
  TelegramDeliveryScheduler,
  type TelegramDeliveryClass,
  type TelegramDeliveryPolicy as TelegramDeliveryPolicyConfig,
  type TelegramDeliverySupersededResult
} from "./telegram-delivery-scheduler";

export type { TelegramDeliveryClass, TelegramDeliveryPolicy } from "./telegram-delivery-scheduler";

export type TelegramInlineKeyboardButton =
  | {
      text: string;
      callback_data: string;
    }
  | {
      text: string;
      url: string;
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

export type TelegramDeliveryHints = {
  deliveryClass?: TelegramDeliveryClass;
  coalesceKey?: string;
  replacePending?: boolean;
};

export type TelegramPhotoSendInput = {
  chatId: number;
  topicId?: number | null;
  bytes: Uint8Array;
  fileName?: string | null;
  mimeType?: string | null;
  disableNotification?: boolean;
};

export interface TelegramApi {
  getForumTopicIconStickers(): Promise<Array<{ custom_emoji_id?: string }>>;
  createForumTopic(
    chatId: number,
    name: string,
    options?: TelegramCreateForumTopicOptions
  ): Promise<{ message_thread_id: number; name: string }>;
  sendMessage(chatId: number, text: string, options?: TelegramSendOptions): Promise<{ message_id: number }>;
  sendPhoto(input: TelegramPhotoSendInput): Promise<{ message_id: number }>;
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
  readonly #scheduler: TelegramDeliveryScheduler;

  constructor(
    private readonly telegram: TelegramApi,
    private readonly logger: LoggerLike = console,
    deliveryPolicy?: Partial<TelegramDeliveryPolicyConfig>
  ) {
    this.#scheduler = new TelegramDeliveryScheduler(deliveryPolicy, {
      onSuperseded: event => {
        this.logger.info("Telegram delivery superseded", event);
      },
      onFailure: event => {
        this.logger.warn("Telegram delivery failed", event);
      }
    });
  }

  async createForumTopic(input: {
    chatId: number;
    name: string;
    options?: TelegramCreateForumTopicOptions;
  }): Promise<{ topicId: number; name: string }> {
    const topic = await this.scheduleTelegramRequest("create forum topic", "topic_create", () =>
      this.telegram.createForumTopic(input.chatId, input.name, input.options)
    );
    if (isTelegramDeliverySupersededResult(topic)) {
      throw new Error("Unexpected telegram delivery superseded result for topic creation");
    }
    return {
      topicId: topic.message_thread_id,
      name: topic.name
    };
  }

  async sendMessage(input: {
    chatId: number;
    topicId?: number | null;
    text: string;
    entities?: MessageEntity[];
    replyToMessageId?: number;
    replyMarkup?: TelegramReplyMarkup;
    disableNotification?: boolean;
  }): Promise<{ messageId: number }> {
    const message = await this.scheduleTelegramRequest("send message", "visible_send", () =>
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
    if (isTelegramDeliverySupersededResult(message)) {
      throw new Error("Unexpected telegram delivery superseded result for message send");
    }
    return { messageId: message.message_id };
  }

  sendPhoto = async (input: TelegramPhotoSendInput): Promise<{ messageId: number }> => {
    const photo = await this.scheduleTelegramRequest("send photo", "visible_send", () =>
      this.telegram.sendPhoto({
        ...input,
        disableNotification: input.disableNotification ?? true
      })
    );
    if (isTelegramDeliverySupersededResult(photo)) {
      throw new Error("Unexpected telegram delivery superseded result for photo send");
    }
    return { messageId: photo.message_id };
  };

  async editMessageText(input: {
    chatId: number;
    messageId: number;
    text: string;
    entities?: MessageEntity[];
    replyMarkup?: InlineKeyboardMarkup;
  } & TelegramDeliveryHints): Promise<unknown> {
    return this.unwrapSuperseded(
      await this.scheduleTelegramRequest(
        "edit message",
        input.deliveryClass ?? "visible_edit",
        () =>
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
          ),
        {
          ...(input.coalesceKey !== undefined ? { coalesceKey: input.coalesceKey } : {}),
          ...(input.replacePending !== undefined ? { replacePending: input.replacePending } : {})
        }
      )
    );
  }

  async sendChatAction(
    chatId: number,
    action: TelegramChatAction,
    options?: {
      message_thread_id?: number;
    } & TelegramDeliveryHints
  ): Promise<true> {
    return this.unwrapSuperseded(
      await this.scheduleTelegramRequest(
        "send chat action",
        options?.deliveryClass ?? "chat_action",
        () =>
          this.telegram.sendChatAction(
            chatId,
            action,
            options?.message_thread_id !== undefined
              ? {
                  message_thread_id: options.message_thread_id
                }
              : undefined
          ),
        {
          ...(options?.coalesceKey !== undefined ? { coalesceKey: options.coalesceKey } : {}),
          ...(options?.replacePending !== undefined ? { replacePending: options.replacePending } : {})
        }
      )
    );
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
    return this.unwrapSuperseded(
      await this.scheduleTelegramRequest("delete message", "delete", async () => {
        try {
          return await this.telegram.deleteMessage(chatId, messageId);
        } catch (error) {
          if (getTelegramRetryAfterMs(error) !== null) {
            throw error;
          }

          this.logger.warn("Telegram delete message failed; continuing", error);
          return true;
        }
      })
    );
  }

  async answerCallbackQuery(callbackQueryId: string, options?: { text?: string }): Promise<true> {
    return this.unwrapSuperseded(
      await this.scheduleTelegramRequest("answer callback query", "callback_answer", () =>
        this.telegram.answerCallbackQuery(callbackQueryId, options)
      )
    );
  }

  async downloadFile(fileId: string): Promise<{ bytes: Uint8Array; filePath?: string }> {
    return this.telegram.downloadFile(fileId);
  }

  cancelPendingDelivery(deliveryClass: TelegramDeliveryClass, coalescingKey: string): boolean {
    return this.#scheduler.supersede(deliveryClass, coalescingKey);
  }

  private async scheduleTelegramRequest<T>(
    action: string,
    deliveryClass: TelegramDeliveryClass,
    operation: () => Promise<T>,
    hints?: {
      coalesceKey?: string;
      replacePending?: boolean;
    }
  ): Promise<T | TelegramDeliverySupersededResult> {
    return this.#scheduler.enqueue({
      deliveryClass,
      execute: async () => {
        try {
          return await operation();
        } catch (error) {
          const retryAfterMs = getTelegramRetryAfterMs(error);
          if (retryAfterMs !== null) {
            this.logger.warn(`Telegram ${action} rate limited; retrying in ${retryAfterMs}ms`, error);
          }
          throw error;
        }
      },
      replaceable: hints?.replacePending ?? false,
      ...(hints?.coalesceKey !== undefined ? { coalescingKey: hints.coalesceKey } : {})
    });
  }

  private unwrapSuperseded<T>(value: T | TelegramDeliverySupersededResult): T {
    if (!isTelegramDeliverySupersededResult(value)) {
      return value;
    }

    return true as T;
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

function isTelegramDeliverySupersededResult(value: unknown): value is TelegramDeliverySupersededResult {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { kind?: unknown }).kind === "telegram_delivery_superseded"
  );
}

export function getTelegramRetryAfterMs(error: unknown): number | null {
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
  if (!match) {
    return null;
  }

  const retryAfter = Number(match[1]);
  if (!Number.isFinite(retryAfter) || retryAfter <= 0) {
    return null;
  }

  return retryAfter * 1000;
}
