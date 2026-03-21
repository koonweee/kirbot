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

type DraftSessionState = {
  pending: TelegramRenderedMessage | null;
  flushTimer: NodeJS.Timeout | null;
  retryTimer: NodeJS.Timeout | null;
  inFlight: Promise<void> | null;
  lastText: string | null;
  lastEntities: MessageEntity[] | undefined;
  lastUpdateAt: number;
  lastChatActionAt: number;
  frozen: boolean;
  closed: boolean;
};

const DEFAULT_DRAFT_THROTTLE_MS = 400;
const DEFAULT_CHAT_ACTION_THROTTLE_MS = 3000;
const EMPTY_DRAFT_TEXT = "";

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
    const message = await this.telegram.sendMessage(
      input.chatId,
      input.text,
      buildTelegramSendOptions({
        ...(input.topicId !== undefined ? { topicId: input.topicId } : {}),
        ...(input.replyToMessageId !== undefined ? { replyToMessageId: input.replyToMessageId } : {}),
        ...(input.replyMarkup ? { replyMarkup: input.replyMarkup } : {}),
        ...(input.entities ? { entities: input.entities } : {}),
        ...(input.disableNotification !== undefined ? { disableNotification: input.disableNotification } : {})
      })
    );
    return { messageId: message.message_id };
  }

  statusDraft(input: {
    chatId: number;
    topicId: number | null;
    draftId: number;
    throttleMs?: number;
    chatAction?: TelegramChatAction | false;
    chatActionThrottleMs?: number;
  }): TelegramStatusDraftHandle {
    return new TelegramStatusDraftHandle(
      this.telegram,
      this.logger,
      input.chatId,
      input.topicId,
      input.draftId,
      input.throttleMs,
      input.chatAction,
      input.chatActionThrottleMs
    );
  }

  streamMessage(input: {
    chatId: number;
    topicId: number | null;
    draftId: number;
    throttleMs?: number;
    chatAction?: TelegramChatAction | false;
    chatActionThrottleMs?: number;
  }): TelegramStreamMessageHandle {
    return new TelegramStreamMessageHandle(
      this.telegram,
      this.logger,
      input.chatId,
      input.topicId,
      input.draftId,
      input.throttleMs,
      input.chatAction,
      input.chatActionThrottleMs
    );
  }
}

export class TelegramStatusDraftHandle {
  readonly #session: TelegramDraftSession;

  constructor(
    telegram: TelegramApi,
    logger: LoggerLike,
    chatId: number,
    topicId: number | null,
    draftId: number,
    throttleMs = DEFAULT_DRAFT_THROTTLE_MS,
    chatAction: TelegramChatAction | false = "typing",
    chatActionThrottleMs = DEFAULT_CHAT_ACTION_THROTTLE_MS
  ) {
    this.#session = new TelegramDraftSession(
      telegram,
      logger,
      chatId,
      topicId,
      draftId,
      throttleMs,
      chatAction,
      chatActionThrottleMs
    );
  }

  async set(rendered: TelegramRenderedMessage | null, force = false): Promise<void> {
    if (!rendered) {
      await this.#session.clear();
      return;
    }

    await this.#session.update(rendered, force);
  }

  async clear(): Promise<void> {
    await this.#session.clear();
  }

  async close(): Promise<void> {
    await this.#session.close();
  }
}

export class TelegramStreamMessageHandle {
  readonly #session: TelegramDraftSession;

  constructor(
    private readonly telegram: TelegramApi,
    logger: LoggerLike,
    private readonly chatId: number,
    private readonly topicId: number | null,
    draftId: number,
    throttleMs = DEFAULT_DRAFT_THROTTLE_MS,
    chatAction: TelegramChatAction | false = "typing",
    chatActionThrottleMs = DEFAULT_CHAT_ACTION_THROTTLE_MS
  ) {
    this.#session = new TelegramDraftSession(
      telegram,
      logger,
      chatId,
      topicId,
      draftId,
      throttleMs,
      chatAction,
      chatActionThrottleMs
    );
  }

  async update(rendered: TelegramRenderedMessage, force = false): Promise<void> {
    await this.#session.update(rendered, force);
  }

  async finalize(
    rendered: TelegramRenderedMessage | TelegramRenderedMessage[],
    options?: {
      firstMessageReplyMarkup?: TelegramReplyMarkup;
      disableNotification?: boolean;
    }
  ): Promise<number | null> {
    const outputs = Array.isArray(rendered) ? rendered : [rendered];
    let firstMessageId: number | null = null;

    await this.#session.prepareForFinalize();

    for (const output of outputs) {
      const message = await this.telegram.sendMessage(
        this.chatId,
        output.text,
        buildTelegramSendOptions({
          topicId: this.topicId,
          ...(firstMessageId === null && options?.firstMessageReplyMarkup
            ? { replyMarkup: options.firstMessageReplyMarkup }
            : {}),
          ...(output.entities ? { entities: output.entities } : {}),
          ...(options?.disableNotification !== undefined
            ? { disableNotification: options.disableNotification }
            : {})
        })
      );
      if (firstMessageId === null) {
        firstMessageId = message.message_id;
      }
    }

    await this.#session.clear();
    await this.#session.close();

    return firstMessageId;
  }

  async clear(): Promise<void> {
    await this.#session.clear();
    await this.#session.close();
  }
}

class TelegramDraftSession {
  readonly #state: DraftSessionState = {
    pending: null,
    flushTimer: null,
    retryTimer: null,
    inFlight: null,
    lastText: null,
    lastEntities: undefined,
    lastUpdateAt: 0,
    lastChatActionAt: 0,
    frozen: false,
    closed: false
  };

  constructor(
    private readonly telegram: TelegramApi,
    private readonly logger: LoggerLike,
    private readonly chatId: number,
    private readonly topicId: number | null,
    private readonly draftId: number,
    private readonly throttleMs: number,
    private readonly chatAction: TelegramChatAction | false,
    private readonly chatActionThrottleMs: number
  ) {}

  async update(rendered: TelegramRenderedMessage, force = false): Promise<void> {
    if (this.#state.closed || this.#state.frozen) {
      return;
    }

    if (
      !force &&
      this.#state.pending === null &&
      areSameRenderedMessages(
        {
          text: this.#state.lastText ?? "",
          ...(this.#state.lastEntities ? { entities: this.#state.lastEntities } : {})
        },
        rendered
      )
    ) {
      return;
    }

    this.#state.pending = rendered;
    const now = Date.now();
    const delayMs = force ? 0 : Math.max(0, this.throttleMs - (now - this.#state.lastUpdateAt));
    this.scheduleFlush(delayMs);
  }

  async clear(): Promise<void> {
    if (this.#state.closed) {
      return;
    }

    if (this.#state.pending === null && this.#state.lastText === null && this.#state.inFlight === null) {
      return;
    }

    this.#state.pending = null;
    this.cancelTimers();
    if (this.#state.inFlight) {
      await this.#state.inFlight;
    }

    if (this.#state.lastText === null) {
      this.#state.lastEntities = undefined;
      this.#state.lastUpdateAt = Date.now();
      return;
    }

    await this.clearDraftBestEffort();
    this.#state.pending = null;
    this.#state.lastText = null;
    this.#state.lastEntities = undefined;
    this.#state.lastUpdateAt = Date.now();
  }

  async close(): Promise<void> {
    this.#state.closed = true;
    this.cancelTimers();
    if (this.#state.inFlight) {
      await this.#state.inFlight;
    }
    this.#state.pending = null;
  }

  async prepareForFinalize(): Promise<void> {
    if (this.#state.closed) {
      return;
    }

    this.#state.frozen = true;
    this.cancelTimers();
    if (this.#state.inFlight) {
      await this.#state.inFlight;
    }
    this.#state.pending = null;
  }

  private scheduleFlush(delayMs: number): void {
    if (this.#state.closed || this.#state.frozen || this.#state.inFlight || this.#state.retryTimer) {
      return;
    }

    if (this.#state.flushTimer) {
      clearTimeout(this.#state.flushTimer);
    }

    if (delayMs === 0) {
      this.#state.flushTimer = null;
      this.#state.inFlight = this.flushPending().finally(() => {
        this.#state.inFlight = null;
        if (!this.#state.closed && !this.#state.frozen && this.#state.pending) {
          this.scheduleFlush(0);
        }
      });
      return;
    }

    this.#state.flushTimer = setTimeout(() => {
      this.#state.flushTimer = null;
      this.#state.inFlight = this.flushPending().finally(() => {
        this.#state.inFlight = null;
        if (!this.#state.closed && !this.#state.frozen && this.#state.pending) {
          this.scheduleFlush(0);
        }
      });
    }, delayMs);
  }

  private async flushPending(): Promise<void> {
    const pending = this.#state.pending;
    if (!pending || this.#state.closed || this.#state.frozen) {
      return;
    }

    this.#state.pending = null;
    if (
      areSameRenderedMessages(
        {
          text: this.#state.lastText ?? "",
          ...(this.#state.lastEntities ? { entities: this.#state.lastEntities } : {})
        },
        pending
      )
    ) {
      return;
    }

    try {
      await this.maybeSendChatAction();
      await this.sendDraft(pending);
      this.#state.lastText = pending.text;
      this.#state.lastEntities = pending.entities;
      this.#state.lastUpdateAt = Date.now();
    } catch (error) {
      if (isRetryAfterError(error)) {
        this.#state.pending = pending;
        const retryDelayMs = getRetryAfterDelayMs(error);
        this.#state.retryTimer = setTimeout(() => {
          this.#state.retryTimer = null;
          if (!this.#state.closed && !this.#state.frozen && this.#state.pending) {
            this.scheduleFlush(0);
          }
        }, retryDelayMs);
        return;
      }

      this.logger.warn("Failed to send Telegram draft", {
        chatId: this.chatId,
        topicId: this.topicId,
        draftId: this.draftId,
        entityCount: pending.entities?.length ?? 0
      }, error);
    }
  }

  private async sendDraft(rendered: TelegramRenderedMessage): Promise<void> {
    await this.telegram.sendMessageDraft(this.chatId, this.draftId, rendered.text, {
      ...(this.topicId !== null ? { message_thread_id: this.topicId } : {}),
      ...(rendered.entities ? { entities: rendered.entities } : {})
    });
  }

  private async clearDraftBestEffort(): Promise<void> {
    try {
      await this.sendDraft({ text: EMPTY_DRAFT_TEXT });
    } catch {
      // Telegram draft clear is cosmetic; finalization should still complete.
    }
  }

  private cancelTimers(): void {
    if (this.#state.flushTimer) {
      clearTimeout(this.#state.flushTimer);
      this.#state.flushTimer = null;
    }

    if (this.#state.retryTimer) {
      clearTimeout(this.#state.retryTimer);
      this.#state.retryTimer = null;
    }
  }

  private async maybeSendChatAction(): Promise<void> {
    if (!this.chatAction) {
      return;
    }

    const now = Date.now();
    if (now - this.#state.lastChatActionAt < this.chatActionThrottleMs) {
      return;
    }

    try {
      await this.telegram.sendChatAction(this.chatId, this.chatAction, {
        ...(this.topicId !== null ? { message_thread_id: this.topicId } : {})
      });
      this.#state.lastChatActionAt = now;
    } catch (error) {
      if (!isRetryAfterError(error)) {
        this.logger.warn("Failed to send Telegram chat action", error);
      }
    }
  }
}

function areSameRenderedMessages(left: TelegramRenderedMessage, right: TelegramRenderedMessage): boolean {
  return left.text === right.text && areSameEntities(left.entities, right.entities);
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

function areSameEntities(left: MessageEntity[] | undefined, right: MessageEntity[] | undefined): boolean {
  if (left === right) {
    return true;
  }

  if (!left || !right || left.length !== right.length) {
    return false;
  }

  return left.every((entity, index) => {
    const other = right[index];
    return JSON.stringify(entity) === JSON.stringify(other);
  });
}

function isRetryAfterError(error: unknown): error is { parameters?: { retry_after?: number } } {
  if (!error || typeof error !== "object") {
    return false;
  }

  return Boolean(
    "parameters" in error &&
      error.parameters &&
      typeof error.parameters === "object" &&
      "retry_after" in error.parameters &&
      typeof error.parameters.retry_after === "number"
  );
}

function getRetryAfterDelayMs(error: { parameters?: { retry_after?: number } }): number {
  return Math.max(0, Math.ceil((error.parameters?.retry_after ?? 0) * 1000));
}
