import { getVisibleTelegramCommands, type TelegramBotCommand } from "./telegram-commands";

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
    private readonly privateChatId: number
  ) {}

  async initialize(): Promise<void> {
    await this.applyVisibleCommands({
      type: "default"
    });
    await this.telegram.setChatMenuButton({
      menu_button: COMMANDS_MENU_BUTTON
    });
    await this.telegram.setChatMenuButton({
      chat_id: this.privateChatId,
      menu_button: COMMANDS_MENU_BUTTON
    });
    await this.applyVisibleCommands({
      type: "chat",
      chat_id: this.privateChatId
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
}
