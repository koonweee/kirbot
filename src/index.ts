import { Bot } from "grammy";

import { TelegramCodexBridge, type TelegramApi } from "./bridge";
import { CodexGateway, spawnCodexAppServer } from "./codex";
import { loadConfig } from "./config";
import { BridgeDatabase } from "./db";
import { CodexRpcClient, WebSocketRpcTransport } from "./rpc";

async function connectWithRetry(transport: WebSocketRpcTransport, attempts = 30): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await transport.connect();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function main(): Promise<void> {
  const config = loadConfig();
  const database = new BridgeDatabase(config.database.path);
  await database.migrate();
  const expiredPendingRequests = await database.expirePendingRequests(
    JSON.stringify({
      reason: "expired_on_startup",
      message: "Pending request expired because the Telegram bridge restarted."
    })
  );
  if (expiredPendingRequests > 0) {
    console.warn(`Expired ${expiredPendingRequests} pending Codex request(s) from a previous run.`);
  }

  const spawnedAppServer = config.codex.spawnAppServer
    ? await spawnCodexAppServer({
        url: config.codex.appServerUrl
      })
    : null;

  const transport = new WebSocketRpcTransport(config.codex.appServerUrl);
  await connectWithRetry(transport);

  const rpcClient = new CodexRpcClient(transport);
  const codex = new CodexGateway(rpcClient, config.codex);
  await codex.initialize();

  const bot = new Bot(config.telegram.botToken);
  const telegramApi: TelegramApi = {
    createForumTopic: (chatId, name) => bot.api.createForumTopic(chatId, name),
    sendMessage: (chatId, text, options) => bot.api.sendMessage(chatId, text, options),
    sendMessageDraft: (chatId, draftId, text, options) => bot.api.sendMessageDraft(chatId, draftId, text, options),
    sendChatAction: (chatId, action, options) => bot.api.sendChatAction(chatId, action, options),
    editMessageText: (chatId, messageId, text, options) => bot.api.editMessageText(chatId, messageId, text, options),
    deleteMessage: (chatId, messageId) => bot.api.deleteMessage(chatId, messageId),
    answerCallbackQuery: (callbackQueryId, options) => bot.api.answerCallbackQuery(callbackQueryId, options)
  };

  const bridge = new TelegramCodexBridge(config, database, telegramApi, codex);
  bot.catch((error) => {
    console.error("Telegram bot update handling failed", error.error);
  });

  bot.on("message:text", async (context) => {
    if (!context.message.from) {
      return;
    }

    await bridge.handleUserTextMessage({
      chatId: context.chat.id,
      topicId: context.message.message_thread_id ?? null,
      messageId: context.message.message_id,
      updateId: context.update.update_id,
      userId: context.message.from.id,
      text: context.message.text
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
    const message = context.callbackQuery.message;
    const topicId =
      message && "message_thread_id" in message && typeof message.message_thread_id === "number"
        ? message.message_thread_id
        : null;

    await bridge.handleCallbackQuery({
      callbackQueryId: context.callbackQuery.id,
      data: context.callbackQuery.data,
      chatId: context.chat?.id ?? config.telegram.chatId,
      topicId
    });
  });

  const shutdown = async (): Promise<void> => {
    await bot.stop();
    await rpcClient.close();
    if (spawnedAppServer) {
      await spawnedAppServer.stop();
    }
    await database.close();
  };

  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  await bot.start();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
