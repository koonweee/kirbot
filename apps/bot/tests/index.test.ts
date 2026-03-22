import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridgeSpies = {
  handleUserTextMessage: vi.fn(async () => undefined),
  handleUserMessage: vi.fn(async () => undefined),
  handleTopicClosed: vi.fn(async () => undefined),
  handleCallbackQuery: vi.fn(async () => undefined)
};
const answerCallbackQuery = vi.fn(async () => true);

type BotHandler = (context: any) => Promise<void>;

class FakeBot {
  static instances: FakeBot[] = [];

  readonly handlers = new Map<string, BotHandler>();
  readonly api = {
    getForumTopicIconStickers: vi.fn(),
    createForumTopic: vi.fn(),
    sendMessage: vi.fn(async () => true),
    sendMessageDraft: vi.fn(),
    sendChatAction: vi.fn(),
    editMessageText: vi.fn(),
    deleteMessage: vi.fn(),
    answerCallbackQuery,
    getFile: vi.fn(),
    setMyCommands: vi.fn(),
    deleteMyCommands: vi.fn(),
    setChatMenuButton: vi.fn()
  };

  constructor(_token: string) {
    FakeBot.instances.push(this);
  }

  catch(_handler: (error: unknown) => void): void {}

  on(filter: string, handler: BotHandler): void {
    this.handlers.set(filter, handler);
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}
}

vi.mock("grammy", () => ({
  Bot: FakeBot
}));

vi.mock("@kirbot/core", () => ({
  createKirbotRuntime: vi.fn(async () => ({
    bridge: bridgeSpies,
    shutdown: vi.fn(async () => undefined)
  }))
}));

vi.mock("../src/config", () => ({
  loadConfig: vi.fn(() => ({
    telegram: {
      botToken: "token",
      workspaceChatId: -1001
    }
  }))
}));

vi.mock("../src/message-input", () => ({
  buildImageDocumentMessageInput: vi.fn(),
  buildPhotoMessageInput: vi.fn()
}));

vi.mock("../src/restart-kirbot", () => ({
  restartKirbotProductionSession: vi.fn(async () => undefined)
}));

async function loadHandlers(): Promise<Map<string, BotHandler>> {
  await import("../src/index");
  const bot = FakeBot.instances.at(-1);
  expect(bot).toBeDefined();
  return bot!.handlers;
}

function buildTextMessageContext(chatId: number, chatType: string, userId: number, text: string) {
  return {
    chat: {
      id: chatId,
      type: chatType
    },
    update: {
      update_id: 900
    },
    message: {
      from: {
        id: userId
      },
      text,
      message_id: 901,
      is_topic_message: false
    }
  };
}

describe("bot entrypoint routing", () => {
  beforeEach(() => {
    FakeBot.instances = [];
    answerCallbackQuery.mockClear();
    for (const spy of Object.values(bridgeSpies)) {
      spy.mockClear();
    }
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("accepts workspace chat text messages regardless of sender id", async () => {
    const handlers = await loadHandlers();

    await handlers.get("message:text")?.(buildTextMessageContext(-1001, "supergroup", 99, "Investigate this"));

    expect(bridgeSpies.handleUserTextMessage).toHaveBeenCalledWith({
      chatId: -1001,
      topicId: null,
      messageId: 901,
      updateId: 900,
      userId: 99,
      text: "Investigate this"
    });
    expect(FakeBot.instances.at(-1)?.api.sendMessage).not.toHaveBeenCalled();
  });

  it("redirects direct messages instead of forwarding them as workspace traffic", async () => {
    const handlers = await loadHandlers();

    await handlers.get("message:text")?.(buildTextMessageContext(123, "private", 55, "Help from DM"));

    expect(bridgeSpies.handleUserTextMessage).not.toHaveBeenCalled();
    expect(FakeBot.instances.at(-1)?.api.sendMessage).toHaveBeenCalledWith(
      123,
      "Use Kirbot from the configured workspace forum chat."
    );
  });

  it("rejects non-workspace group messages without forwarding or redirecting", async () => {
    const handlers = await loadHandlers();

    await handlers.get("message:text")?.(buildTextMessageContext(-2002, "supergroup", 77, "Wrong chat"));

    expect(bridgeSpies.handleUserTextMessage).not.toHaveBeenCalled();
    expect(FakeBot.instances.at(-1)?.api.sendMessage).not.toHaveBeenCalled();
  });

  it("accepts callback queries from the workspace chat regardless of sender id", async () => {
    const handlers = await loadHandlers();

    await handlers.get("callback_query:data")?.({
      chat: {
        id: -1001
      },
      callbackQuery: {
        id: "callback-workspace",
        data: "turn:turn-1:sendNow",
        from: {
          id: 77
        },
        message: {
          message_thread_id: 777
        }
      }
    });

    expect(bridgeSpies.handleCallbackQuery).toHaveBeenCalledWith({
      callbackQueryId: "callback-workspace",
      data: "turn:turn-1:sendNow",
      chatId: -1001,
      topicId: 777,
      userId: 77
    });
    expect(answerCallbackQuery).not.toHaveBeenCalled();
  });

  it("rejects callback queries that do not include chat context", async () => {
    const handlers = await loadHandlers();

    await handlers.get("callback_query:data")?.({
      callbackQuery: {
        id: "callback-no-chat",
        data: "turn:turn-1:sendNow",
        from: {
          id: 99
        }
      },
      chat: undefined
    });

    expect(bridgeSpies.handleCallbackQuery).not.toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledWith("callback-no-chat", {
      text: "Use Kirbot from the configured workspace forum chat."
    });
  });

  it("rejects callback queries from the wrong chat", async () => {
    const handlers = await loadHandlers();

    await handlers.get("callback_query:data")?.({
      chat: {
        id: -2002
      },
      callbackQuery: {
        id: "callback-wrong-chat",
        data: "turn:turn-1:sendNow",
        from: {
          id: 44
        }
      }
    });

    expect(bridgeSpies.handleCallbackQuery).not.toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledWith("callback-wrong-chat", {
      text: "Use Kirbot from the configured workspace forum chat."
    });
  });
});
