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

function buildTextMessageContext(
  chatId: number,
  chatType: string,
  userId: number,
  text: string,
  username?: string
) {
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
        id: userId,
        ...(username ? { username } : {})
      },
      text,
      message_id: 901,
      is_topic_message: false
    }
  };
}

function buildPhotoMessageContext(
  chatId: number,
  chatType: string,
  userId: number,
  caption: string,
  username?: string
) {
  return {
    chat: {
      id: chatId,
      type: chatType
    },
    update: {
      update_id: 901
    },
    message: {
      from: {
        id: userId,
        ...(username ? { username } : {})
      },
      caption,
      message_id: 902,
      is_topic_message: false,
      photo: [{ file_id: "photo-file" }]
    }
  };
}

function buildDocumentMessageContext(
  chatId: number,
  chatType: string,
  userId: number,
  caption: string,
  username?: string
) {
  return {
    chat: {
      id: chatId,
      type: chatType
    },
    update: {
      update_id: 902
    },
    message: {
      from: {
        id: userId,
        ...(username ? { username } : {})
      },
      caption,
      message_id: 903,
      is_topic_message: false,
      document: {
        file_id: "document-file",
        file_name: "diagram.png",
        mime_type: "image/png"
      }
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

  it("forwards telegram usernames from workspace text, photo, and document ingress", async () => {
    const handlers = await loadHandlers();
    const photoMessageInput = {
      text: "Photo caption",
      input: [
        {
          type: "telegramImage",
          fileId: "photo-file",
          fileName: null,
          mimeType: "image/jpeg"
        }
      ]
    };
    const documentMessageInput = {
      text: "Document caption",
      input: [
        {
          type: "telegramImage",
          fileId: "document-file",
          fileName: "diagram.png",
          mimeType: "image/png"
        }
      ]
    };
    const photoInputMock = vi.mocked(await import("../src/message-input")).buildPhotoMessageInput;
    const documentInputMock = vi.mocked(await import("../src/message-input")).buildImageDocumentMessageInput;
    photoInputMock.mockReturnValue(photoMessageInput as never);
    documentInputMock.mockReturnValue(documentMessageInput as never);

    await handlers.get("message:text")?.(buildTextMessageContext(-1001, "supergroup", 99, "Investigate this", "Jeremy"));
    await handlers.get("message:photo")?.(
      buildPhotoMessageContext(-1001, "supergroup", 99, "Photo caption", "Jeremy")
    );
    await handlers.get("message:document")?.(
      buildDocumentMessageContext(-1001, "supergroup", 99, "Document caption", "Jeremy")
    );

    expect(bridgeSpies.handleUserTextMessage).toHaveBeenCalledWith({
      chatId: -1001,
      topicId: null,
      messageId: 901,
      updateId: 900,
      userId: 99,
      actorLabel: "Jeremy",
      telegramUsername: "Jeremy",
      text: "Investigate this"
    });
    expect(bridgeSpies.handleUserMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        chatId: -1001,
        topicId: null,
        messageId: 902,
        updateId: 901,
        userId: 99,
        telegramUsername: "Jeremy",
        text: "Photo caption",
        input: photoMessageInput.input
      })
    );
    expect(bridgeSpies.handleUserMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        chatId: -1001,
        topicId: null,
        messageId: 903,
        updateId: 902,
        userId: 99,
        telegramUsername: "Jeremy",
        text: "Document caption",
        input: documentMessageInput.input
      })
    );
  });

  it("omits telegram usernames when Telegram does not provide one", async () => {
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
    expect(bridgeSpies.handleUserTextMessage.mock.calls[0]?.[0]).not.toHaveProperty("telegramUsername");
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
