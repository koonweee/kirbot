import { Bot } from "grammy";
import type { Message } from "grammy/types";

import { createKirbotRuntime, type TelegramApi, type TelegramCommandApi } from "@kirbot/core";
import { loadConfig } from "./config";
import { buildImageDocumentMessageInput, buildPhotoMessageInput } from "./message-input";
import { restartKirbotProductionSession } from "./restart-kirbot";

const WORKSPACE_CHAT_ONLY_TEXT = "Use Kirbot from the configured workspace forum chat.";

async function main(): Promise<void> {
  const config = loadConfig();
  const bot = new Bot(config.telegram.botToken);
  const workspaceChatId = config.telegram.workspaceChatId;
  const telegramApi: TelegramApi = {
    getForumTopicIconStickers: () => bot.api.getForumTopicIconStickers(),
    createForumTopic: (chatId, name, options) => bot.api.createForumTopic(chatId, name, options),
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
    telegramCommandApi,
    restartKirbot: restartKirbotProductionSession
  });
  const { bridge } = runtime;
  bot.catch((error) => {
    console.error("Telegram bot update handling failed", error.error);
  });

  bot.on("message:text", async (context) => {
    if (!context.message.from) {
      return;
    }

    if (!(await ensureWorkspaceMessage(context.chat.id, context.chat.type, bot, workspaceChatId))) {
      return;
    }

    const topicId = getMessageTopicId(context.message);
    const actorLabel = getTelegramActorLabel(context.message.from);
    const telegramUsername = getTelegramUsername(context.message.from);

    await bridge.handleUserTextMessage({
      chatId: context.chat.id,
      topicId,
      messageId: context.message.message_id,
      updateId: context.update.update_id,
      userId: context.message.from.id,
      ...(actorLabel ? { actorLabel } : {}),
      ...(telegramUsername ? { telegramUsername } : {}),
      text: context.message.text
    });
  });

  bot.on("message:photo", async (context) => {
    if (!context.message.from) {
      return;
    }

    if (!(await ensureWorkspaceMessage(context.chat.id, context.chat.type, bot, workspaceChatId))) {
      return;
    }

    const topicId = getMessageTopicId(context.message);
    const input = buildPhotoMessageInput(context.message.caption, context.message.photo);
    const actorLabel = getTelegramActorLabel(context.message.from);
    const telegramUsername = getTelegramUsername(context.message.from);
    await bridge.handleUserMessage({
      chatId: context.chat.id,
      topicId,
      messageId: context.message.message_id,
      updateId: context.update.update_id,
      userId: context.message.from.id,
      ...(actorLabel ? { actorLabel } : {}),
      ...(telegramUsername ? { telegramUsername } : {}),
      text: input.text,
      input: input.input
    });
  });

  bot.on("message:document", async (context) => {
    if (!context.message.from) {
      return;
    }

    if (!(await ensureWorkspaceMessage(context.chat.id, context.chat.type, bot, workspaceChatId))) {
      return;
    }

    const input = buildImageDocumentMessageInput(context.message.caption, context.message.document);
    if (!input) {
      return;
    }

    const topicId = getMessageTopicId(context.message);
    const actorLabel = getTelegramActorLabel(context.message.from);
    const telegramUsername = getTelegramUsername(context.message.from);
    await bridge.handleUserMessage({
      chatId: context.chat.id,
      topicId,
      messageId: context.message.message_id,
      updateId: context.update.update_id,
      userId: context.message.from.id,
      ...(actorLabel ? { actorLabel } : {}),
      ...(telegramUsername ? { telegramUsername } : {}),
      text: input.text,
      input: input.input
    });
  });

  bot.on("message", async (context) => {
    if (context.chat.id !== workspaceChatId) {
      return;
    }

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
    const callbackChatId = context.chat?.id;
    if (callbackChatId === undefined || callbackChatId !== workspaceChatId) {
      await bot.api.answerCallbackQuery(context.callbackQuery.id, {
        text: WORKSPACE_CHAT_ONLY_TEXT
      });
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
      chatId: callbackChatId,
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

function getMessageTopicId(message: Message.ServiceMessage): number | null {
  return message.is_topic_message ? (message.message_thread_id ?? null) : null;
}

function getTelegramActorLabel(user: {
  first_name: string;
  last_name?: string;
  username?: string;
}): string | undefined {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  if (name.length > 0) {
    return name;
  }

  const username = user.username?.trim();
  return username?.length ? username : undefined;
}

function getTelegramUsername(user: {
  username?: string;
}): string | undefined {
  const username = user.username?.trim();
  return username?.length ? username : undefined;
}

async function ensureWorkspaceMessage(
  chatId: number,
  chatType: string,
  bot: Bot,
  workspaceChatId: number
): Promise<boolean> {
  if (chatId === workspaceChatId) {
    return true;
  }

  if (chatType === "private") {
    await bot.api.sendMessage(chatId, WORKSPACE_CHAT_ONLY_TEXT);
  }

  return false;
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
