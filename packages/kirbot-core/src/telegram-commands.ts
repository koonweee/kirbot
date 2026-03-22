export type { TelegramBotCommand } from "./bridge/slash-commands";
export {
  getSurfaceableTopicSlashCommands,
  isAllowedSlashCommandInScope as isAllowedTelegramCommandInScope
} from "./bridge/slash-commands";
import { getVisibleSlashCommands } from "./bridge/slash-commands";

export function getVisibleTelegramCommands() {
  return getVisibleSlashCommands("general");
}
