import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TelegramCommandSync,
  initializeTelegramCommandSyncFailOpen,
  type TelegramCommandApi
} from "../src/telegram-command-sync";

class FakeTelegramCommandApi implements TelegramCommandApi {
  setMyCommandsCalls: Array<{
    commands: ReadonlyArray<{ command: string; description: string }>;
    options?: {
      scope?: {
        type: "default";
      } | {
        type: "chat";
        chat_id: number;
      };
    };
  }> = [];
  deleteMyCommandsCalls: Array<{
    options?: {
      scope?: {
        type: "default";
      } | {
        type: "chat";
        chat_id: number;
      };
    };
  }> = [];
  setChatMenuButtonCalls: Array<{
    options?: {
      chat_id?: number;
      menu_button?: {
        type: "commands";
      };
    };
  }> = [];

  async setMyCommands(
    commands: ReadonlyArray<{ command: string; description: string }>,
    options?: {
      scope?: {
        type: "default";
      } | {
        type: "chat";
        chat_id: number;
      };
    }
  ): Promise<true> {
    this.setMyCommandsCalls.push(options ? { commands, options } : { commands });
    return true;
  }

  async deleteMyCommands(options?: {
    scope?: {
      type: "default";
    } | {
      type: "chat";
      chat_id: number;
    };
  }): Promise<true> {
    this.deleteMyCommandsCalls.push(options ? { options } : {});
    return true;
  }

  async setChatMenuButton(options?: {
    chat_id?: number;
    menu_button?: {
      type: "commands";
    };
  }): Promise<true> {
    this.setChatMenuButtonCalls.push(options ? { options } : {});
    return true;
  }
}

describe("TelegramCommandSync", () => {
  it("configures the commands menu and a single visible command list at startup", async () => {
    const telegram = new FakeTelegramCommandApi();
    const sync = new TelegramCommandSync(telegram, 42);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await sync.initialize();

    expect(telegram.deleteMyCommandsCalls).toEqual([]);
    expect(telegram.setMyCommandsCalls).toEqual([
      {
        commands: [
          {
            command: "stop",
            description: "Stop the current response"
          },
          {
            command: "plan",
            description: "Switch this topic into plan mode"
          },
          {
            command: "implement",
            description: "Implement the plan in this topic"
          },
          {
            command: "model",
            description: "Choose the global model"
          },
          {
            command: "fast",
            description: "Toggle global fast mode"
          },
          {
            command: "permissions",
            description: "Set global Codex permissions"
          }
        ],
        options: {
          scope: {
            type: "default"
          }
        }
      },
      {
        commands: [
          {
            command: "stop",
            description: "Stop the current response"
          },
          {
            command: "plan",
            description: "Switch this topic into plan mode"
          },
          {
            command: "implement",
            description: "Implement the plan in this topic"
          },
          {
            command: "model",
            description: "Choose the global model"
          },
          {
            command: "fast",
            description: "Toggle global fast mode"
          },
          {
            command: "permissions",
            description: "Set global Codex permissions"
          }
        ],
        options: {
          scope: {
            type: "chat",
            chat_id: 42
          }
        }
      }
    ]);
    expect(telegram.setChatMenuButtonCalls).toEqual([
      {
        options: {
          menu_button: {
            type: "commands"
          }
        }
      },
      {
        options: {
          chat_id: 42,
          menu_button: {
            type: "commands"
          }
        }
      }
    ]);
    expect(infoSpy.mock.calls).toEqual([
      ["Telegram command sync: starting set visible commands for default scope."],
      ["Telegram command sync: completed set visible commands for default scope."],
      ["Telegram command sync: starting set commands menu button for default scope."],
      ["Telegram command sync: completed set commands menu button for default scope."],
      ["Telegram command sync: starting set commands menu button for private chat 42."],
      ["Telegram command sync: completed set commands menu button for private chat 42."],
      ["Telegram command sync: starting set visible commands for private chat 42."],
      ["Telegram command sync: completed set visible commands for private chat 42."]
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs and continues when startup command sync fails", async () => {
    const warning = new Error("setMyCommands timed out");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const commandSync = {
      initialize: async () => {
        throw warning;
      }
    };

    await expect(initializeTelegramCommandSyncFailOpen(commandSync)).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      "Telegram command sync failed during startup; continuing without updating command menus.",
      warning
    );
  });
});
