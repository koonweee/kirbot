import { Bot } from "grammy";
import type { Message } from "grammy/types";

import { createKirbotRuntime, type TelegramApi, type TelegramCommandApi } from "@kirbot/core";
import { loadConfig } from "./config";

async function main(): Promise<void> {
  const config = loadConfig();
  const bot = new Bot(config.telegram.botToken);
  const telegramApi: TelegramApi = {
    createForumTopic: (chatId, name) => bot.api.createForumTopic(chatId, name),
    sendMessage: (chatId, text, options) => bot.api.sendMessage(chatId, text, options),
    sendMessageDraft: (chatId, draftId, text, options) => bot.api.sendMessageDraft(chatId, draftId, text, options),
    sendChatAction: (chatId, action, options) => bot.api.sendChatAction(chatId, action, options),
    editMessageText: (chatId, messageId, text, options) => bot.api.editMessageText(chatId, messageId, text, options),
    deleteMessage: (chatId, messageId) => bot.api.deleteMessage(chatId, messageId),
    answerCallbackQuery: (callbackQueryId, options) => bot.api.answerCallbackQuery(callbackQueryId, options),
    downloadFile: async (fileId) => {
      const file = await bot.api.getFile(fileId);
      if (!file.file_path) {
        throw new Error(`Telegram did not return a file path for ${fileId}`);
      }

      const response = await fetch(`https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`);
      if (!response.ok) {
        throw new Error(`Telegram file download failed with status ${response.status}`);
      }

      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        filePath: file.file_path
      };
    }
  };
  const telegramCommandApi: TelegramCommandApi = {
    setMyCommands: (commands, options) => bot.api.setMyCommands(commands, options),
    deleteMyCommands: (options) => bot.api.deleteMyCommands(options),
    setChatMenuButton: (options) => bot.api.setChatMenuButton(options)
  };

  const runtime = await createKirbotRuntime({
    config,
    telegramApi,
    telegramCommandApi
  });
  const { bridge } = runtime;
  bot.catch((error) => {
    console.error("Telegram bot update handling failed", error.error);
  });

  bot.on("message:text", async (context) => {
    if (!context.message.from) {
      return;
    }

    if (context.message.from.id !== config.telegram.userId) {
      return;
    }

    const topicId = getMessageTopicId(context.message);

    await bridge.handleUserTextMessage({
      chatId: context.chat.id,
      topicId,
      messageId: context.message.message_id,
      updateId: context.update.update_id,
      userId: context.message.from.id,
      text: context.message.text
    });
  });

  bot.on("message:photo", async (context) => {
    if (!context.message.from) {
      return;
    }

    if (context.message.from.id !== config.telegram.userId) {
      return;
    }

    const photo = pickLargestPhoto(context.message.photo);
    const topicId = getMessageTopicId(context.message);
    await bridge.handleUserMessage({
      chatId: context.chat.id,
      topicId,
      messageId: context.message.message_id,
      updateId: context.update.update_id,
      userId: context.message.from.id,
      text: context.message.caption ?? "",
      input: buildImageMessageInput(context.message.caption ?? "", {
        fileId: photo.file_id,
        fileName: "telegram-photo.jpg",
        mimeType: "image/jpeg"
      })
    });
  });

  bot.on("message:document", async (context) => {
    if (!context.message.from || !isImageDocument(context.message.document)) {
      return;
    }

    if (context.message.from.id !== config.telegram.userId) {
      return;
    }

    const topicId = getMessageTopicId(context.message);
    await bridge.handleUserMessage({
      chatId: context.chat.id,
      topicId,
      messageId: context.message.message_id,
      updateId: context.update.update_id,
      userId: context.message.from.id,
      text: context.message.caption ?? "",
      input: buildImageMessageInput(context.message.caption ?? "", {
        fileId: context.message.document.file_id,
        ...(context.message.document.file_name ? { fileName: context.message.document.file_name } : {}),
        ...(context.message.document.mime_type ? { mimeType: context.message.document.mime_type } : {})
      })
    });
  });

  bot.on("message", async (context) => {
    const topicId = context.message.message_thread_id;
    if (!topicId) {
      return;
    }

    if (context.message.forum_topic_closed) {
      await bridge.handleTopicClosed({
        chatId: context.chat.id,
        topicId
      });
    }
  });

  bot.on("callback_query:data", async (context) => {
    if (context.callbackQuery.from.id !== config.telegram.userId) {
      return;
    }

    const message = context.callbackQuery.message;
    const topicId =
      message && "message_thread_id" in message && typeof message.message_thread_id === "number"
        ? message.message_thread_id
        : null;

    await bridge.handleCallbackQuery({
      callbackQueryId: context.callbackQuery.id,
      data: context.callbackQuery.data,
      chatId: context.chat?.id ?? config.telegram.userId,
      topicId,
      userId: context.callbackQuery.from.id
    });
  });

  const shutdown = async (): Promise<void> => {
    await bot.stop();
    await runtime.shutdown();
  };

  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  await bot.start();
}

function buildImageMessageInput(
  text: string,
  image: { fileId: string; fileName?: string | null; mimeType?: string | null }
): Array<
  | { type: "text"; text: string; text_elements: [] }
  | { type: "telegramImage"; fileId: string; fileName?: string | null; mimeType?: string | null }
> {
  const input: Array<
    | { type: "text"; text: string; text_elements: [] }
    | { type: "telegramImage"; fileId: string; fileName?: string | null; mimeType?: string | null }
  > = [];
  if (text.trim().length > 0) {
    input.push({
      type: "text",
      text,
      text_elements: []
    });
  }
  input.push({
    type: "telegramImage",
    fileId: image.fileId,
    ...(image.fileName !== undefined ? { fileName: image.fileName } : {}),
    ...(image.mimeType !== undefined ? { mimeType: image.mimeType } : {})
  });
  return input;
}

function pickLargestPhoto(photos: Message.PhotoMessage["photo"]): Message.PhotoMessage["photo"][number] {
  const largest = photos.at(-1);
  if (!largest) {
    throw new Error("Telegram photo message did not include any photo sizes");
  }

  return largest;
}

function isImageDocument(document: Message.DocumentMessage["document"]): boolean {
  return typeof document.mime_type === "string" && document.mime_type.startsWith("image/");
}

function getMessageTopicId(message: Message.ServiceMessage): number | null {
  return message.is_topic_message ? (message.message_thread_id ?? null) : null;
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
