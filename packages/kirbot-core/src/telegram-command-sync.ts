import { getVisibleTelegramCommands, type TelegramBotCommand } from "./telegram-commands";
import type { LoggerLike } from "./logging";

type TelegramCommandScope =
  | {
      type: "default";
    }
  | {
      type: "chat";
      chat_id: number;
    };

type TelegramMenuButtonCommands = {
  type: "commands";
};

export interface TelegramCommandApi {
  setMyCommands(
    commands: readonly TelegramBotCommand[],
    options?: {
      scope?: TelegramCommandScope;
    }
  ): Promise<true>;
  deleteMyCommands(options?: {
    scope?: TelegramCommandScope;
  }): Promise<true>;
  setChatMenuButton(options?: {
    chat_id?: number;
    menu_button?: TelegramMenuButtonCommands;
  }): Promise<true>;
}

const COMMANDS_MENU_BUTTON: TelegramMenuButtonCommands = {
  type: "commands"
};

export class TelegramCommandSync {
  constructor(
    private readonly telegram: TelegramCommandApi,
    private readonly privateChatId: number,
    private readonly logger: LoggerLike = console
  ) {}

  async initialize(): Promise<void> {
    await this.runStartupStep("set visible commands for default scope", async () => {
      await this.applyVisibleCommands({
        type: "default"
      });
    });
    await this.runStartupStep("set commands menu button for default scope", async () => {
      await this.telegram.setChatMenuButton({
        menu_button: COMMANDS_MENU_BUTTON
      });
    });
    await this.runStartupStep(`set commands menu button for private chat ${this.privateChatId}`, async () => {
      await this.telegram.setChatMenuButton({
        chat_id: this.privateChatId,
        menu_button: COMMANDS_MENU_BUTTON
      });
    });
    await this.runStartupStep(`set visible commands for private chat ${this.privateChatId}`, async () => {
      await this.applyVisibleCommands({
        type: "chat",
        chat_id: this.privateChatId
      });
    });
  }

  private async applyVisibleCommands(scope: TelegramCommandScope): Promise<void> {
    const commands = getVisibleTelegramCommands();
    if (commands.length === 0) {
      await this.telegram.deleteMyCommands({ scope });
      return;
    }

    await this.telegram.setMyCommands(commands, { scope });
  }

  private async runStartupStep(description: string, operation: () => Promise<void>): Promise<void> {
    this.logger.info(`Telegram command sync: starting ${description}.`);
    await operation();
    this.logger.info(`Telegram command sync: completed ${description}.`);
  }
}

export async function initializeTelegramCommandSyncFailOpen(
  commandSync: Pick<TelegramCommandSync, "initialize">,
  logger: LoggerLike = console
): Promise<void> {
  try {
    await commandSync.initialize();
  } catch (error) {
    logger.warn("Telegram command sync failed during startup; continuing without updating command menus.", error);
  }
}
