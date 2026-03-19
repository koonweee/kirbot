export type { TelegramBotCommand } from "./bridge/slash-commands";
export {
  getVisibleSlashCommands as getVisibleTelegramCommands,
  getSurfaceableTopicSlashCommands,
  isAllowedSlashCommandInScope as isAllowedTelegramCommandInScope
} from "./bridge/slash-commands";
