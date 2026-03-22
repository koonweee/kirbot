import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handleCallbackQuery = vi.fn(async () => undefined);
const answerCallbackQuery = vi.fn(async () => true);

type BotHandler = (context: any) => Promise<void>;

class FakeBot {
  static instances: FakeBot[] = [];

  readonly handlers = new Map<string, BotHandler>();
  readonly api = {
    getForumTopicIconStickers: vi.fn(),
    createForumTopic: vi.fn(),
    sendMessage: vi.fn(),
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
    bridge: {
      handleUserTextMessage: vi.fn(),
      handleUserMessage: vi.fn(),
      handleTopicClosed: vi.fn(),
      handleCallbackQuery
    },
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

describe("bot entrypoint callback routing", () => {
  beforeEach(() => {
    FakeBot.instances = [];
    handleCallbackQuery.mockClear();
    answerCallbackQuery.mockClear();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("rejects callback queries that do not include chat context", async () => {
    await import("../src/index");

    const bot = FakeBot.instances.at(-1);
    expect(bot).toBeDefined();

    const callbackHandler = bot?.handlers.get("callback_query:data");
    expect(callbackHandler).toBeDefined();

    await callbackHandler?.({
      callbackQuery: {
        id: "callback-1",
        data: "turn:turn-1:sendNow",
        from: {
          id: 99
        }
      },
      chat: undefined
    });

    expect(handleCallbackQuery).not.toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledWith("callback-1", {
      text: "Use Kirbot from the configured workspace forum chat."
    });
  });
});
