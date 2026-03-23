import type { MessageEntity } from "grammy/types";
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
  #lastVisibleActivityAt = 0;
  #statusDrain: Promise<void> | null = null;
  #lifecycleQueue: Promise<void> = Promise.resolve();

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
    await this.#ensureStatusDrain(force);
  }

  async publishFinalAssistantMessage(
    rendered: TelegramRenderedMessage,
    options?: TelegramVisibleMessageRenderOptions
  ): Promise<number | null> {
    return this.#runLifecycleExclusive(async () => {
      if (this.#closed) {
        return null;
      }

      this.#closed = true;
      this.#latestStatusMessage = null;
      this.#cancelLowValuePendingWork();
      await this.#awaitStatusDrain();

      try {
        const message = await this.messenger.sendMessage({
          chatId: this.chatId,
          topicId: this.topicId,
          text: rendered.text,
          ...(rendered.entities ? { entities: rendered.entities } : {}),
          disableNotification: options?.disableNotification ?? false,
          ...(options?.replyMarkup ? { replyMarkup: options.replyMarkup } : {})
        });
        this.#markVisibleActivity();

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
    return this.#runLifecycleExclusive(async () => {
      this.#closed = true;
      this.#latestStatusMessage = null;
      this.#cancelLowValuePendingWork();
      await this.#awaitStatusDrain();
      return this.#publishStatusMessage(rendered, force, false, true);
    });
  }

  async clear(): Promise<void> {
    this.#closed = true;
    this.#latestStatusMessage = null;
    this.#cancelLowValuePendingWork();
    await this.#awaitStatusDrain();
  }

  #ensureStatusDrain(force: boolean): Promise<void> {
    if (this.#statusDrain) {
      return this.#statusDrain;
    }

    this.#statusDrain = this.#drainStatusUpdates(force).finally(() => {
      this.#statusDrain = null;
    });
    return this.#statusDrain;
  }

  async #drainStatusUpdates(force: boolean): Promise<void> {
    while (!this.#closed) {
      const rendered = this.#latestStatusMessage;
      if (!rendered || sameRenderedMessage(this.#currentStatusMessage, rendered)) {
        return;
      }

      await this.#publishStatusMessage(rendered, force, true);
    }
  }

  async #publishStatusMessage(
    rendered: TelegramRenderedMessage,
    _force: boolean,
    sendTypingAction: boolean,
    allowClosedCommit = false
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
        ...(rendered.entities ? { entities: rendered.entities } : {}),
        coalesceKey: this.#statusEditCoalesceKey(this.#statusMessageId),
        replacePending: true
      });
    }

    if (this.#closed && !allowClosedCommit) {
      return this.#statusMessageId;
    }

    this.#markVisibleActivity();
    this.#currentStatusMessage = rendered;
    return this.#statusMessageId;
  }

  async #maybeSendTypingAction(force = false): Promise<void> {
    if (this.#closed) {
      return;
    }

    const now = Date.now();
    if (!force && this.#statusMessageId !== null) {
      return;
    }

    if (!force && this.#lastVisibleActivityAt !== 0 && now - this.#lastVisibleActivityAt < 3000) {
      return;
    }

    await this.messenger.sendChatAction(this.chatId, "typing", {
      ...(this.topicId !== null ? { message_thread_id: this.topicId } : {}),
      coalesceKey: this.#chatActionCoalesceKey("typing"),
      replacePending: true
    });
  }

  #statusEditCoalesceKey(messageId: number): string {
    return `status:${this.chatId}:${messageId}`;
  }

  #chatActionCoalesceKey(action: "typing" | "upload_document"): string {
    return `chat-action:${this.chatId}:${this.topicId ?? "root"}:${action}`;
  }

  #markVisibleActivity(): void {
    this.#lastVisibleActivityAt = Date.now();
  }

  #cancelLowValuePendingWork(): void {
    if (this.#statusMessageId !== null) {
      this.messenger.cancelPendingDelivery("visible_edit", this.#statusEditCoalesceKey(this.#statusMessageId));
    }

    this.messenger.cancelPendingDelivery("chat_action", this.#chatActionCoalesceKey("typing"));
  }

  async #awaitStatusDrain(): Promise<void> {
    await this.#statusDrain;
  }

  #runLifecycleExclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#lifecycleQueue.then(() => task(), () => task());
    this.#lifecycleQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
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
