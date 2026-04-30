export type { TelegramBotCommand } from "./bridge/slash-commands";
import type { CodexProfilesConfig } from "./codex-profiles";
export {
  getSurfaceableTopicSlashCommands,
  isAllowedSlashCommandInScope as isAllowedTelegramCommandInScope
} from "./bridge/slash-commands";
import { getVisibleSlashCommands } from "./bridge/slash-commands";

export function getVisibleTelegramCommands(
  profileCommands: CodexProfilesConfig["profileCommands"] = {}
) {
  return getVisibleSlashCommands("general", profileCommands);
}
