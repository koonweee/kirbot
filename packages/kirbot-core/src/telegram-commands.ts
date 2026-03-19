export type { TelegramBotCommand } from "./bridge/slash-commands";
export {
  getVisibleSlashCommands as getVisibleTelegramCommands,
  isAllowedSlashCommandInScope as isAllowedTelegramCommandInScope
} from "./bridge/slash-commands";
