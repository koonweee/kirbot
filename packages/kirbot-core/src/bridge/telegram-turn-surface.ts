import type { MessageEntity } from "grammy/types";
import type { AssistantRenderUpdate } from "../turn-runtime";
import type {
  InlineKeyboardMarkup,
  TelegramMessenger,
  TelegramRenderedMessage
} from "../telegram-messenger";

export type TelegramVisibleMessageRenderOptions = {
  disableNotification?: boolean;
  replyMarkup?: InlineKeyboardMarkup;
};

export interface TelegramTurnSurface {
  updateStatus(rendered: TelegramRenderedMessage, force?: boolean): Promise<void>;
  applyAssistantRenderUpdate(
    update: AssistantRenderUpdate,
    options?: { commit?: boolean; force?: boolean }
  ): Promise<void>;
  publishFinalAssistantMessage(
    rendered: TelegramRenderedMessage,
    options?: TelegramVisibleMessageRenderOptions
  ): Promise<number | null>;
  publishTerminalStatus(rendered: TelegramRenderedMessage, force?: boolean): Promise<number | null>;
  clear(): Promise<void>;
}

export function createTelegramTurnSurface(input: {
  messenger: TelegramMessenger;
  chatId: number;
  topicId: number | null;
}): TelegramTurnSurface {
  return new TelegramStatusBubbleTurnSurface(input.messenger, input.chatId, input.topicId);
}

class TelegramStatusBubbleTurnSurface implements TelegramTurnSurface {
  #statusMessageId: number | null = null;
  #closed = false;
  #currentStatusMessage: TelegramRenderedMessage | null = null;
  #latestStatusMessage: TelegramRenderedMessage | null = null;
  #lastEditAt = 0;
  #lastChatActionAt = 0;
  #flushTimer: NodeJS.Timeout | null = null;

  readonly #statusCooldownMs = 500;

  constructor(
    private readonly messenger: TelegramMessenger,
    private readonly chatId: number,
    private readonly topicId: number | null
  ) {}

  async updateStatus(rendered: TelegramRenderedMessage, force = false): Promise<void> {
    if (this.#closed) {
      return;
    }

    this.#latestStatusMessage = rendered;
    await this.#runExclusive(() => this.#flushStatus(force));
  }

  async applyAssistantRenderUpdate(
    _update: AssistantRenderUpdate,
    _options?: { commit?: boolean; force?: boolean }
  ): Promise<void> {
    return;
  }

  async publishFinalAssistantMessage(
    rendered: TelegramRenderedMessage,
    options?: TelegramVisibleMessageRenderOptions
  ): Promise<number | null> {
    return this.#runExclusive(async () => {
      if (this.#closed) {
        return null;
      }

      this.#closed = true;
      this.#clearFlushTimer();

      try {
        const message = await this.messenger.sendMessage({
          chatId: this.chatId,
          topicId: this.topicId,
          text: rendered.text,
          ...(rendered.entities ? { entities: rendered.entities } : {}),
          disableNotification: options?.disableNotification ?? false,
          ...(options?.replyMarkup ? { replyMarkup: options.replyMarkup } : {})
        });

        if (this.#statusMessageId !== null) {
          try {
            await this.messenger.deleteMessage(this.chatId, this.#statusMessageId);
          } catch (error) {
            console.warn("Failed to delete Telegram status message after final assistant publish", error);
          }
        }

        return message.messageId;
      } catch (error) {
        if (this.#statusMessageId !== null) {
          try {
            await this.messenger.editMessageText({
              chatId: this.chatId,
              messageId: this.#statusMessageId,
              text: "failed"
            });
          } catch (editError) {
            console.warn("Failed to publish Telegram terminal fallback after final assistant send failure", editError);
          }
        }

        console.warn("Failed to publish Telegram final assistant message", error);
        return null;
      }
    });
  }

  async publishTerminalStatus(rendered: TelegramRenderedMessage, force = true): Promise<number | null> {
    return this.#runExclusive(async () => {
      this.#closed = true;
      this.#clearFlushTimer();
      return this.#publishStatusMessage(rendered, force, false);
    });
  }

  async clear(): Promise<void> {
    this.#clearFlushTimer();
    this.#closed = true;
  }

  async #flushStatus(force: boolean): Promise<void> {
    if (this.#closed || !this.#latestStatusMessage) {
      return;
    }

    await this.#maybeSendTypingAction();
    const rendered = this.#latestStatusMessage;
    if (sameRenderedMessage(this.#currentStatusMessage, rendered)) {
      return;
    }

    const canEditNow = force || this.#statusMessageId === null || this.#cooldownElapsed(this.#statusCooldownMs);
    if (!canEditNow) {
      this.#scheduleFlush(this.#remainingCooldownMs(this.#statusCooldownMs));
      return;
    }

    await this.#publishStatusMessage(rendered, true, true);
  }

  async #publishStatusMessage(
    rendered: TelegramRenderedMessage,
    _force: boolean,
    sendTypingAction: boolean
  ): Promise<number> {
    if (sendTypingAction) {
      await this.#maybeSendTypingAction();
    }

    if (this.#statusMessageId === null) {
      const message = await this.messenger.sendMessage({
        chatId: this.chatId,
        topicId: this.topicId,
        text: rendered.text,
        ...(rendered.entities ? { entities: rendered.entities } : {}),
        disableNotification: true
      });
      this.#statusMessageId = message.messageId;
    } else if (!sameRenderedMessage(this.#currentStatusMessage, rendered)) {
      await this.messenger.editMessageText({
        chatId: this.chatId,
        messageId: this.#statusMessageId,
        text: rendered.text,
        ...(rendered.entities ? { entities: rendered.entities } : {})
      });
    }

    this.#currentStatusMessage = rendered;
    this.#lastEditAt = Date.now();
    this.#latestStatusMessage = rendered;
    this.#clearFlushTimer();
    return this.#statusMessageId;
  }

  async #maybeSendTypingAction(force = false): Promise<void> {
    if (this.#closed) {
      return;
    }

    const now = Date.now();
    if (!force && this.#lastChatActionAt !== 0 && now - this.#lastChatActionAt < 3000) {
      return;
    }

    this.#lastChatActionAt = now;
    await this.messenger.sendChatAction(this.chatId, "typing", {
      ...(this.topicId !== null ? { message_thread_id: this.topicId } : {})
    });
  }

  #scheduleFlush(delayMs: number): void {
    if (this.#closed) {
      return;
    }

    this.#clearFlushTimer();
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      void this.#runExclusive(() => this.#flushStatus(true));
    }, Math.max(0, delayMs));
    this.#flushTimer.unref?.();
  }

  #clearFlushTimer(): void {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
  }

  #cooldownElapsed(cooldownMs: number): boolean {
    if (this.#lastEditAt === 0) {
      return true;
    }

    return Date.now() - this.#lastEditAt >= cooldownMs;
  }

  #remainingCooldownMs(cooldownMs: number): number {
    if (this.#lastEditAt === 0) {
      return 0;
    }

    return Math.max(0, cooldownMs - (Date.now() - this.#lastEditAt));
  }

  #runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(() => task(), () => task());
    this.#queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  #queue: Promise<void> = Promise.resolve();
}

function sameRenderedMessage(left: TelegramRenderedMessage | null, right: TelegramRenderedMessage | null): boolean {
  if (!left || !right) {
    return left === right;
  }

  return left.text === right.text && sameEntities(left.entities, right.entities);
}

function sameEntities(left: MessageEntity[] | undefined, right: MessageEntity[] | undefined): boolean {
  if (left === right) {
    return true;
  }

  if (!left || !right || left.length !== right.length) {
    return false;
  }

  return left.every((entity, index) => sameEntity(entity, right[index] ?? null));
}

function sameEntity(left: MessageEntity, right: MessageEntity | null): boolean {
  if (!right) {
    return false;
  }

  return JSON.stringify(left) === JSON.stringify(right);
}
