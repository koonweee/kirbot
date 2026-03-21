import type { MessageEntity } from "grammy/types";
import type { AssistantRenderUpdate } from "../turn-runtime";
import {
  buildRenderedAssistantMessage,
  renderTelegramAssistantDraft
} from "./presentation";
import { splitFlushablePrefix } from "./stream-boundaries";
import type {
  InlineKeyboardMarkup,
  TelegramMessenger,
  TelegramRenderedMessage
} from "../telegram-messenger";

type TelegramVisibleMessageRenderOptions = {
  disableNotification?: boolean;
  replyMarkup?: InlineKeyboardMarkup;
};

export class TelegramTurnStream {
  #messageId: number | null = null;
  #closed = false;
  #currentRenderedMessage: TelegramRenderedMessage | null = null;
  #latestStatusMessage: TelegramRenderedMessage | null = null;
  #assistantSourceText = "";
  #assistantPublishedText = "";
  #assistantStarted = false;
  #lastEditAt = 0;
  #lastChatActionAt = 0;
  #flushTimer: NodeJS.Timeout | null = null;
  #flushKind: "status" | "assistant" | null = null;
  readonly #statusCooldownMs = 500;
  readonly #assistantCooldownMs = 1000;

  constructor(
    private readonly messenger: TelegramMessenger,
    private readonly chatId: number,
    private readonly topicId: number | null
  ) {}

  async updateStatus(rendered: TelegramRenderedMessage, force = false): Promise<void> {
    if (this.#closed || this.#assistantStarted) {
      return;
    }

    this.#latestStatusMessage = rendered;
    await this.#runExclusive(() => this.#flushStatus(force));
  }

  async applyAssistantRenderUpdate(update: AssistantRenderUpdate, options?: { commit?: boolean; force?: boolean }): Promise<void> {
    if (this.#closed || update.draftKind !== "assistant") {
      return;
    }

    this.#assistantStarted = true;
    this.#clearFlushTimer();
    this.#latestStatusMessage = null;
    this.#assistantSourceText = options?.commit ? update.finalText : update.draftText;

    await this.#runExclusive(() => this.#flushAssistant({
      force: options?.force ?? false,
      commit: options?.commit ?? false
    }));
  }

  async finalize(
    rendered: TelegramRenderedMessage,
    options?: TelegramVisibleMessageRenderOptions
  ): Promise<number> {
    return this.#runExclusive(async () => {
      this.#assistantStarted = true;
      this.#closed = true;
      this.#clearFlushTimer();
      this.#latestStatusMessage = null;
      this.#assistantSourceText = "";
      this.#assistantPublishedText = rendered.text;

      if (this.#messageId === null) {
        const message = await this.messenger.sendMessage({
          chatId: this.chatId,
          topicId: this.topicId,
          text: rendered.text,
          disableNotification: options?.disableNotification ?? false,
          ...(rendered.entities ? { entities: rendered.entities } : {}),
          ...(options?.replyMarkup ? { replyMarkup: options.replyMarkup } : {})
        });
        this.#messageId = message.messageId;
        this.#currentRenderedMessage = rendered;
        return message.messageId;
      }

      if (!sameRenderedMessage(this.#currentRenderedMessage, rendered)) {
        await this.messenger.editMessageText({
          chatId: this.chatId,
          messageId: this.#messageId,
          text: rendered.text,
          ...(rendered.entities ? { entities: rendered.entities } : {}),
          ...(options?.replyMarkup ? { replyMarkup: options.replyMarkup } : {})
        });
        this.#currentRenderedMessage = rendered;
      }

      return this.#messageId;
    });
  }

  async clear(): Promise<void> {
    this.#clearFlushTimer();
    this.#closed = true;
  }

  async #flushStatus(force: boolean): Promise<void> {
    if (this.#closed || this.#assistantStarted || !this.#latestStatusMessage) {
      return;
    }

    await this.#maybeSendTypingAction();
    const rendered = this.#latestStatusMessage;
    if (sameRenderedMessage(this.#currentRenderedMessage, rendered)) {
      return;
    }

    const canEditNow = force || this.#messageId === null || this.#cooldownElapsed(this.#statusCooldownMs);
    if (!canEditNow) {
      this.#scheduleFlush("status", this.#remainingCooldownMs(this.#statusCooldownMs));
      return;
    }

    try {
      await this.#publishRendered(rendered, { disableNotification: true });
    } catch (error) {
      console.warn("Failed to publish Telegram status update", error);
    }
  }

  async #flushAssistant(options: { force: boolean; commit: boolean }): Promise<void> {
    if (this.#closed || !this.#assistantStarted || this.#assistantSourceText.length === 0) {
      return;
    }

    await this.#maybeSendTypingAction();
    const nextText = this.#chooseAssistantTextToPublish(options.force, options.commit);
    if (!nextText) {
      this.#scheduleFlush("assistant", this.#remainingCooldownMs(this.#assistantCooldownMs));
      return;
    }

    if (nextText === this.#assistantPublishedText && sameRenderedMessage(this.#currentRenderedMessage, renderTelegramAssistantDraft(nextText))) {
      return;
    }

    const rendered = options.commit
      ? buildRenderedAssistantMessage(nextText)
      : renderTelegramAssistantDraft(nextText);
    try {
      await this.#publishRendered(rendered, { disableNotification: true });
      this.#assistantPublishedText = nextText;
    } catch (error) {
      console.warn("Failed to publish Telegram assistant update", error);
    }
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

  #chooseAssistantTextToPublish(force: boolean, commit: boolean): string | null {
    const source = this.#assistantSourceText;
    if (source.length === 0) {
      return null;
    }

    if (commit) {
      return source;
    }

    const [flushablePrefix] = splitFlushablePrefix(source);
    const canEditNow = force || this.#messageId === null || this.#cooldownElapsed(this.#assistantCooldownMs);
    if (!canEditNow) {
      return null;
    }

    if (flushablePrefix.length > this.#assistantPublishedText.length) {
      return flushablePrefix;
    }

    if (source.length > this.#assistantPublishedText.length) {
      return source;
    }

    return null;
  }

  async #publishRendered(
    rendered: TelegramRenderedMessage,
    options?: TelegramVisibleMessageRenderOptions
  ): Promise<void> {
    if (this.#messageId === null) {
      const message = await this.messenger.sendMessage({
        chatId: this.chatId,
        topicId: this.topicId,
        text: rendered.text,
        ...(rendered.entities ? { entities: rendered.entities } : {}),
        disableNotification: options?.disableNotification ?? true,
        ...(options?.replyMarkup ? { replyMarkup: options.replyMarkup } : {})
      });
      this.#messageId = message.messageId;
    } else {
      await this.messenger.editMessageText({
        chatId: this.chatId,
        messageId: this.#messageId,
        text: rendered.text,
        ...(rendered.entities ? { entities: rendered.entities } : {}),
        ...(options?.replyMarkup ? { replyMarkup: options.replyMarkup } : {})
      });
    }

    this.#currentRenderedMessage = rendered;
    this.#lastEditAt = Date.now();
    this.#clearFlushTimer();
  }

  #scheduleFlush(kind: "status" | "assistant", delayMs: number): void {
    if (this.#closed) {
      return;
    }

    this.#clearFlushTimer();
    this.#flushKind = kind;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      const flushKind = this.#flushKind;
      this.#flushKind = null;
      if (!flushKind) {
        return;
      }

      void this.#runExclusive(async () => {
        if (flushKind === "status") {
          await this.#flushStatus(true);
        } else {
          await this.#flushAssistant({ force: true, commit: false });
        }
      });
    }, Math.max(0, delayMs));
    this.#flushTimer.unref?.();
  }

  #clearFlushTimer(): void {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    this.#flushKind = null;
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
