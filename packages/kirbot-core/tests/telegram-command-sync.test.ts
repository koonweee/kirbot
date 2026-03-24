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
  it("cleans up the default command scope and configures only General-safe commands for the workspace chat", async () => {
    const telegram = new FakeTelegramCommandApi();
    const sync = new TelegramCommandSync(telegram, 42);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await sync.initialize();

    expect(telegram.deleteMyCommandsCalls).toEqual([
      {
        options: {
          scope: {
            type: "default"
          }
        }
      }
    ]);
    expect(telegram.setMyCommandsCalls).toEqual([
      {
        commands: [
          {
            command: "plan",
            description: "Switch this topic into plan mode"
          },
          {
            command: "thread",
            description: "Start a new topic thread"
          },
          {
            command: "restart",
            description: "Rebuild and restart kirbot"
          },
          {
            command: "cmd",
            description: "Manage custom thread commands"
          },
          {
            command: "model",
            description: "Choose the current session model"
          },
          {
            command: "fast",
            description: "Toggle fast mode for the current session"
          },
          {
            command: "compact",
            description: "Compact the current thread"
          },
          {
            command: "clear",
            description: "Start a fresh Codex thread"
          },
          {
            command: "permissions",
            description: "Set permissions for the current session"
          },
          {
            command: "commands",
            description: "Show the command keyboard"
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
    expect(telegram.setChatMenuButtonCalls).toEqual([]);
    expect(infoSpy.mock.calls).toEqual([
      ["Telegram command sync: starting clear commands for default scope."],
      ["Telegram command sync: completed clear commands for default scope."],
      ["Telegram command sync: starting set visible commands for workspace chat 42."],
      ["Telegram command sync: completed set visible commands for workspace chat 42."]
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
