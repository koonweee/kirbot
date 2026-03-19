export type TelegramBotCommand = {
  command: string;
  description: string;
};

export type KirbotSlashCommand = "stop" | "plan" | "implement";
export type CodexSlashCommand = "model" | "fast" | "approvals" | "permissions";
export type SlashCommandName = KirbotSlashCommand | CodexSlashCommand;
export type SlashCommandKind = "kirbot" | "codex";
export type SlashCommandScope = "root" | "topic";

export type ParsedSlashCommand = {
  command: SlashCommandName;
  argsText: string;
  definition: SlashCommandDefinition;
};

type SlashCommandDefinition = {
  command: SlashCommandName;
  description: string;
  kind: SlashCommandKind;
  visible: boolean;
  allowInRoot: boolean;
  allowInTopic: boolean;
};

const SLASH_COMMAND_DEFINITIONS = [
  {
    command: "stop",
    description: "Stop the current response",
    kind: "kirbot",
    visible: true,
    allowInRoot: false,
    allowInTopic: true
  },
  {
    command: "plan",
    description: "Switch this topic into plan mode",
    kind: "kirbot",
    visible: true,
    allowInRoot: true,
    allowInTopic: true
  },
  {
    command: "implement",
    description: "Implement the plan in this topic",
    kind: "kirbot",
    visible: true,
    allowInRoot: false,
    allowInTopic: true
  },
  {
    command: "model",
    description: "Choose the model for this topic",
    kind: "codex",
    visible: true,
    allowInRoot: false,
    allowInTopic: true
  },
  {
    command: "fast",
    description: "Toggle fast mode for this topic",
    kind: "codex",
    visible: true,
    allowInRoot: false,
    allowInTopic: true
  },
  {
    command: "permissions",
    description: "Set Codex permissions for this topic",
    kind: "codex",
    visible: true,
    allowInRoot: false,
    allowInTopic: true
  },
  {
    command: "approvals",
    description: "Alias for /permissions",
    kind: "codex",
    visible: false,
    allowInRoot: false,
    allowInTopic: true
  }
] satisfies readonly SlashCommandDefinition[];

const SLASH_COMMAND_BY_NAME = new Map(
  SLASH_COMMAND_DEFINITIONS.map((definition) => [definition.command, definition])
);

const ROOT_COMMAND_SET: ReadonlySet<string> = new Set(
  SLASH_COMMAND_DEFINITIONS.filter((definition) => definition.allowInRoot).map((definition) => definition.command)
);
const TOPIC_COMMAND_SET: ReadonlySet<string> = new Set(
  SLASH_COMMAND_DEFINITIONS.filter((definition) => definition.allowInTopic).map((definition) => definition.command)
);

export function getVisibleSlashCommands(): readonly TelegramBotCommand[] {
  return SLASH_COMMAND_DEFINITIONS
    .filter((definition) => definition.visible)
    .map((definition) => ({
      command: definition.command,
      description: definition.description
    }));
}

export function isAllowedSlashCommandInScope(command: string, scope: SlashCommandScope): boolean {
  return scope === "root" ? ROOT_COMMAND_SET.has(command as SlashCommandName) : TOPIC_COMMAND_SET.has(command as SlashCommandName);
}

export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const [token, ...rest] = trimmed.split(/\s+/);
  if (!token || token.length < 2) {
    return null;
  }

  const command = token
    .slice(1)
    .split("@", 1)[0]
    ?.toLowerCase() as SlashCommandName | undefined;
  if (!command) {
    return null;
  }

  const definition = SLASH_COMMAND_BY_NAME.get(command);
  if (!definition) {
    return null;
  }

  return {
    command,
    argsText: rest.join(" ").trim(),
    definition
  };
}

export function isCodexSlashCommand(command: SlashCommandName): command is CodexSlashCommand {
  return command === "model" || command === "fast" || command === "approvals" || command === "permissions";
}
