import type { MessageEntity } from "grammy/types";

import type {
  InlineKeyboardMarkup,
  TelegramApi,
  TelegramChatAction,
  TelegramDraftOptions,
  TelegramSendOptions
} from "@kirbot/core";

export type HarnessTelegramEvent =
  | {
      timestamp: string;
      type: "telegram.createForumTopic";
      chatId: number;
      topicId: number;
      name: string;
    }
  | {
      timestamp: string;
      type: "telegram.sendMessage";
      chatId: number;
      messageId: number;
      text: string;
      options?: TelegramSendOptions;
    }
  | {
      timestamp: string;
      type: "telegram.sendMessageDraft";
      chatId: number;
      draftId: number;
      text: string;
      options?: TelegramDraftOptions;
    }
  | {
      timestamp: string;
      type: "telegram.sendChatAction";
      chatId: number;
      action: TelegramChatAction;
      options?: { message_thread_id?: number };
    }
  | {
      timestamp: string;
      type: "telegram.editMessageText";
      chatId: number;
      messageId: number;
      text: string;
      options?: TelegramSendOptions;
    }
  | {
      timestamp: string;
      type: "telegram.deleteMessage";
      chatId: number;
      messageId: number;
    }
  | {
      timestamp: string;
      type: "telegram.answerCallbackQuery";
      callbackQueryId: string;
      options?: { text?: string };
    };

export type HarnessTranscriptMessage = {
  actor: "user" | "bot";
  messageId: number;
  text: string;
  entities?: MessageEntity[];
  replyToMessageId?: number;
  buttons?: InlineKeyboardMarkup["inline_keyboard"];
};

export type HarnessTranscriptTopic = {
  chatId: number;
  topicId: number;
  title: string;
  messages: HarnessTranscriptMessage[];
};

export type HarnessDraftState = {
  chatId: number;
  topicId: number;
  draftId: number;
  text: string;
  entities?: MessageEntity[];
};

export type HarnessTranscript = {
  root: {
    chatId: number;
    messages: HarnessTranscriptMessage[];
  };
  topics: HarnessTranscriptTopic[];
  drafts: HarnessDraftState[];
};

type TranscriptStore = {
  rootMessages: HarnessTranscriptMessage[];
  topics: Map<number, HarnessTranscriptTopic>;
  drafts: Map<string, HarnessDraftState>;
};

export class RecordingTelegram implements TelegramApi {
  readonly #events: HarnessTelegramEvent[] = [];
  readonly #transcript: TranscriptStore = {
    rootMessages: [],
    topics: new Map(),
    drafts: new Map()
  };

  #topicCounter = 100;
  #messageCounter = 500;
  #lastActivityAt = Date.now();

  constructor(private readonly chatId: number) {}

  get lastActivityAt(): number {
    return this.#lastActivityAt;
  }

  recordUserTextMessage(message: {
    chatId: number;
    topicId: number | null;
    messageId: number;
    text: string;
  }): void {
    this.#touch();
    this.#getMessageStore(message.topicId).push({
      actor: "user",
      messageId: message.messageId,
      text: message.text
    });
  }

  getEvents(): HarnessTelegramEvent[] {
    return structuredClone(this.#events);
  }

  getTranscript(): HarnessTranscript {
    return {
      root: {
        chatId: this.chatId,
        messages: structuredClone(this.#transcript.rootMessages)
      },
      topics: Array.from(this.#transcript.topics.values())
        .map((topic) => structuredClone(topic))
        .sort((left, right) => left.topicId - right.topicId),
      drafts: Array.from(this.#transcript.drafts.values())
        .map((draft) => structuredClone(draft))
        .sort((left, right) => left.draftId - right.draftId)
    };
  }

  findMessage(messageId: number): HarnessTranscriptMessage | undefined {
    const rootMessage = this.#transcript.rootMessages.find((message) => message.messageId === messageId);
    if (rootMessage) {
      return structuredClone(rootMessage);
    }

    for (const topic of this.#transcript.topics.values()) {
      const topicMessage = topic.messages.find((message) => message.messageId === messageId);
      if (topicMessage) {
        return structuredClone(topicMessage);
      }
    }

    return undefined;
  }

  findMessageLocation(messageId: number): { chatId: number; topicId: number | null } | null {
    if (this.#transcript.rootMessages.some((message) => message.messageId === messageId)) {
      return { chatId: this.chatId, topicId: null };
    }

    for (const topic of this.#transcript.topics.values()) {
      if (topic.messages.some((message) => message.messageId === messageId)) {
        return {
          chatId: topic.chatId,
          topicId: topic.topicId
        };
      }
    }

    return null;
  }

  async createForumTopic(chatId: number, name: string): Promise<{ message_thread_id: number; name: string }> {
    this.#topicCounter += 1;
    const topicId = this.#topicCounter;
    this.#transcript.topics.set(topicId, {
      chatId,
      topicId,
      title: name,
      messages: []
    });
    this.#recordEvent({
      timestamp: now(),
      type: "telegram.createForumTopic",
      chatId,
      topicId,
      name
    });
    return {
      message_thread_id: topicId,
      name
    };
  }

  async sendMessage(chatId: number, text: string, options?: TelegramSendOptions): Promise<{ message_id: number }> {
    this.#messageCounter += 1;
    const message = {
      actor: "bot" as const,
      messageId: this.#messageCounter,
      text,
      ...(options?.entities ? { entities: options.entities } : {}),
      ...(options?.reply_to_message_id ? { replyToMessageId: options.reply_to_message_id } : {}),
      ...(options?.reply_markup ? { buttons: options.reply_markup.inline_keyboard } : {})
    };
    this.#getMessageStore(options?.message_thread_id ?? null).push(message);
    this.#recordEvent({
      timestamp: now(),
      type: "telegram.sendMessage",
      chatId,
      messageId: this.#messageCounter,
      text,
      ...(options ? { options } : {})
    });
    return { message_id: this.#messageCounter };
  }

  async sendMessageDraft(chatId: number, draftId: number, text: string, options?: TelegramDraftOptions): Promise<true> {
    const topicId = options?.message_thread_id;
    if (topicId === undefined) {
      throw new Error("Harness drafts require a message thread id");
    }

    const key = draftKey(chatId, topicId, draftId);
    if (text.length === 0) {
      this.#transcript.drafts.delete(key);
    } else {
      this.#transcript.drafts.set(key, {
        chatId,
        topicId,
        draftId,
        text,
        ...(options?.entities ? { entities: options.entities } : {})
      });
    }

    this.#recordEvent({
      timestamp: now(),
      type: "telegram.sendMessageDraft",
      chatId,
      draftId,
      text,
      ...(options ? { options } : {})
    });
    return true;
  }

  async sendChatAction(
    chatId: number,
    action: TelegramChatAction,
    options?: { message_thread_id?: number }
  ): Promise<true> {
    this.#recordEvent({
      timestamp: now(),
      type: "telegram.sendChatAction",
      chatId,
      action,
      ...(options ? { options } : {})
    });
    return true;
  }

  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    options?: TelegramSendOptions
  ): Promise<unknown> {
    const message = this.#locateMessage(messageId);
    if (!message) {
      throw new Error(`Could not find Telegram message ${messageId} to edit`);
    }

    message.text = text;
    if (options?.entities) {
      message.entities = options.entities;
    } else {
      delete message.entities;
    }
    if (options?.reply_markup) {
      message.buttons = options.reply_markup.inline_keyboard;
    } else {
      delete message.buttons;
    }
    if (options?.reply_to_message_id) {
      message.replyToMessageId = options.reply_to_message_id;
    } else {
      delete message.replyToMessageId;
    }

    this.#recordEvent({
      timestamp: now(),
      type: "telegram.editMessageText",
      chatId,
      messageId,
      text,
      ...(options ? { options } : {})
    });
    return true;
  }

  async deleteMessage(chatId: number, messageId: number): Promise<true> {
    const store = this.#locateMessageStore(messageId);
    if (store) {
      const index = store.findIndex((message) => message.messageId === messageId);
      if (index !== -1) {
        store.splice(index, 1);
      }
    }

    this.#recordEvent({
      timestamp: now(),
      type: "telegram.deleteMessage",
      chatId,
      messageId
    });
    return true;
  }

  async answerCallbackQuery(callbackQueryId: string, options?: { text?: string }): Promise<true> {
    this.#recordEvent({
      timestamp: now(),
      type: "telegram.answerCallbackQuery",
      callbackQueryId,
      ...(options ? { options } : {})
    });
    return true;
  }

  async downloadFile(fileId: string): Promise<{ bytes: Uint8Array; filePath?: string }> {
    throw new Error(`Harness does not support Telegram file downloads yet: ${fileId}`);
  }

  #recordEvent(event: HarnessTelegramEvent): void {
    this.#events.push(event);
    this.#touch();
  }

  #touch(): void {
    this.#lastActivityAt = Date.now();
  }

  #getMessageStore(topicId: number | null): HarnessTranscriptMessage[] {
    if (topicId === null) {
      return this.#transcript.rootMessages;
    }

    return this.#ensureTopic(topicId).messages;
  }

  #ensureTopic(topicId: number): HarnessTranscriptTopic {
    const existing = this.#transcript.topics.get(topicId);
    if (existing) {
      return existing;
    }

    const created: HarnessTranscriptTopic = {
      chatId: this.chatId,
      topicId,
      title: `Topic ${topicId}`,
      messages: []
    };
    this.#transcript.topics.set(topicId, created);
    return created;
  }

  #locateMessage(messageId: number): HarnessTranscriptMessage | undefined {
    for (const store of [this.#transcript.rootMessages, ...Array.from(this.#transcript.topics.values()).map((topic) => topic.messages)]) {
      const existing = store.find((message) => message.messageId === messageId);
      if (existing) {
        return existing;
      }
    }

    return undefined;
  }

  #locateMessageStore(messageId: number): HarnessTranscriptMessage[] | undefined {
    const stores = [this.#transcript.rootMessages, ...Array.from(this.#transcript.topics.values()).map((topic) => topic.messages)];
    return stores.find((store) => store.some((message) => message.messageId === messageId));
  }
}

function draftKey(chatId: number, topicId: number, draftId: number): string {
  return `${chatId}:${topicId}:${draftId}`;
}

function now(): string {
  return new Date().toISOString();
}
