import { describe, expect, it } from "vitest";

import { TelegramCommandSync, type TelegramCommandApi } from "../src/telegram-command-sync";

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
            description: "Implement the latest plan in this topic"
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
            description: "Implement the latest plan in this topic"
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
  });
});
