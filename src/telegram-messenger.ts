export type InlineKeyboardMarkup = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
};

export type TelegramParseMode = "HTML";

export type TelegramSendOptions = {
  message_thread_id?: number;
  reply_markup?: InlineKeyboardMarkup;
  parse_mode?: TelegramParseMode;
};

export type TelegramDraftOptions = {
  message_thread_id?: number;
  parse_mode?: TelegramParseMode;
};

export type TelegramChatAction = "typing" | "upload_document";

export interface TelegramApi {
  createForumTopic(chatId: number, name: string): Promise<{ message_thread_id: number; name: string }>;
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
    options?: TelegramSendOptions
  ): Promise<unknown>;
  deleteMessage(chatId: number, messageId: number): Promise<true>;
  answerCallbackQuery(callbackQueryId: string, options?: { text?: string }): Promise<true>;
  downloadFile(fileId: string): Promise<{ bytes: Uint8Array; filePath?: string }>;
}

export type TelegramRenderedMessage = {
  text: string;
  parseMode?: TelegramParseMode;
};

type DraftSessionState = {
  pending: TelegramRenderedMessage | null;
  flushTimer: NodeJS.Timeout | null;
  retryTimer: NodeJS.Timeout | null;
  inFlight: Promise<void> | null;
  lastText: string | null;
  lastParseMode?: TelegramParseMode;
  lastUpdateAt: number;
  lastChatActionAt: number;
  closed: boolean;
};

const DEFAULT_DRAFT_THROTTLE_MS = 400;
const DEFAULT_CHAT_ACTION_THROTTLE_MS = 3000;
const EMPTY_DRAFT_TEXT = "";

export class TelegramMessenger {
  constructor(private readonly telegram: TelegramApi) {}

  async sendMessage(input: {
    chatId: number;
    topicId?: number | null;
    text: string;
    parseMode?: TelegramParseMode;
    replyMarkup?: InlineKeyboardMarkup;
  }): Promise<{ messageId: number }> {
    const message = await this.telegram.sendMessage(input.chatId, input.text, {
      ...(input.topicId !== null && input.topicId !== undefined ? { message_thread_id: input.topicId } : {}),
      ...(input.replyMarkup ? { reply_markup: input.replyMarkup } : {}),
      ...withTelegramParseMode(input.parseMode)
    });
    return { messageId: message.message_id };
  }

  statusDraft(input: {
    chatId: number;
    topicId: number;
    draftId: number;
    throttleMs?: number;
    chatAction?: TelegramChatAction | false;
    chatActionThrottleMs?: number;
  }): TelegramStatusDraftHandle {
    return new TelegramStatusDraftHandle(
      this.telegram,
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
    topicId: number;
    draftId: number;
    throttleMs?: number;
    chatAction?: TelegramChatAction | false;
    chatActionThrottleMs?: number;
  }): TelegramStreamMessageHandle {
    return new TelegramStreamMessageHandle(
      this.telegram,
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
    chatId: number,
    topicId: number,
    draftId: number,
    throttleMs = DEFAULT_DRAFT_THROTTLE_MS,
    chatAction: TelegramChatAction | false = "typing",
    chatActionThrottleMs = DEFAULT_CHAT_ACTION_THROTTLE_MS
  ) {
    this.#session = new TelegramDraftSession(
      telegram,
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
    private readonly chatId: number,
    private readonly topicId: number,
    draftId: number,
    throttleMs = DEFAULT_DRAFT_THROTTLE_MS,
    chatAction: TelegramChatAction | false = "typing",
    chatActionThrottleMs = DEFAULT_CHAT_ACTION_THROTTLE_MS
  ) {
    this.#session = new TelegramDraftSession(
      telegram,
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

  async finalize(rendered: TelegramRenderedMessage | TelegramRenderedMessage[]): Promise<number | null> {
    const outputs = Array.isArray(rendered) ? rendered : [rendered];
    let firstMessageId: number | null = null;

    for (const output of outputs) {
      const message = await this.telegram.sendMessage(this.chatId, output.text, {
        message_thread_id: this.topicId,
        ...withTelegramParseMode(output.parseMode)
      });
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
    lastUpdateAt: 0,
    lastChatActionAt: 0,
    closed: false
  };

  constructor(
    private readonly telegram: TelegramApi,
    private readonly chatId: number,
    private readonly topicId: number,
    private readonly draftId: number,
    private readonly throttleMs: number,
    private readonly chatAction: TelegramChatAction | false,
    private readonly chatActionThrottleMs: number
  ) {}

  async update(rendered: TelegramRenderedMessage, force = false): Promise<void> {
    if (this.#state.closed) {
      return;
    }

    if (
      !force &&
      this.#state.pending === null &&
      this.#state.lastText === rendered.text &&
      this.#state.lastParseMode === rendered.parseMode
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

    this.cancelTimers();
    if (this.#state.inFlight) {
      await this.#state.inFlight;
    }

    await this.clearDraftBestEffort();
    this.#state.pending = null;
    this.#state.lastText = null;
    this.#state.lastParseMode = undefined;
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

  private scheduleFlush(delayMs: number): void {
    if (this.#state.closed || this.#state.inFlight || this.#state.retryTimer) {
      return;
    }

    if (this.#state.flushTimer) {
      clearTimeout(this.#state.flushTimer);
    }

    if (delayMs === 0) {
      this.#state.flushTimer = null;
      this.#state.inFlight = this.flushPending().finally(() => {
        this.#state.inFlight = null;
        if (!this.#state.closed && this.#state.pending) {
          this.scheduleFlush(0);
        }
      });
      return;
    }

    this.#state.flushTimer = setTimeout(() => {
      this.#state.flushTimer = null;
      this.#state.inFlight = this.flushPending().finally(() => {
        this.#state.inFlight = null;
        if (!this.#state.closed && this.#state.pending) {
          this.scheduleFlush(0);
        }
      });
    }, delayMs);
  }

  private async flushPending(): Promise<void> {
    const pending = this.#state.pending;
    if (!pending || this.#state.closed) {
      return;
    }

    this.#state.pending = null;
    if (pending.text === this.#state.lastText && pending.parseMode === this.#state.lastParseMode) {
      return;
    }

    try {
      await this.maybeSendChatAction();
      await this.sendDraft(pending);
      this.#state.lastText = pending.text;
      this.#state.lastParseMode = pending.parseMode;
      this.#state.lastUpdateAt = Date.now();
    } catch (error) {
      if (isRetryAfterError(error)) {
        this.#state.pending = pending;
        const retryDelayMs = getRetryAfterDelayMs(error);
        this.#state.retryTimer = setTimeout(() => {
          this.#state.retryTimer = null;
          if (!this.#state.closed && this.#state.pending) {
            this.scheduleFlush(0);
          }
        }, retryDelayMs);
        return;
      }

      if (pending.parseMode) {
        await this.sendDraft({
          text: pending.text
        });
        this.#state.lastText = pending.text;
        this.#state.lastParseMode = undefined;
        this.#state.lastUpdateAt = Date.now();
        return;
      }

      throw error;
    }
  }

  private async sendDraft(rendered: TelegramRenderedMessage): Promise<void> {
    await this.telegram.sendMessageDraft(this.chatId, this.draftId, rendered.text, {
      message_thread_id: this.topicId,
      ...withTelegramParseMode(rendered.parseMode)
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
        message_thread_id: this.topicId
      });
      this.#state.lastChatActionAt = now;
    } catch (error) {
      if (!isRetryAfterError(error)) {
        console.warn("Failed to send Telegram chat action", error);
      }
    }
  }
}

function withTelegramParseMode(parseMode?: TelegramParseMode): { parse_mode?: TelegramParseMode } {
  return parseMode ? { parse_mode: parseMode } : {};
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
