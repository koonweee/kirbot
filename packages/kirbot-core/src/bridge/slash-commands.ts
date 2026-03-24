export type TelegramBotCommand = {
  command: string;
  description: string;
};

export type KirbotSlashCommand = "stop" | "plan" | "thread" | "restart" | "implement" | "cmd" | "clear" | "commands";
export type CodexSlashCommand = "model" | "fast" | "compact" | "approvals" | "permissions";
export type SlashCommandName = KirbotSlashCommand | CodexSlashCommand;
export type SlashCommandKind = "kirbot" | "codex";
export type SlashCommandScope = "general" | "topic";

export type ParsedSlashCommandToken = {
  command: string;
  argsText: string;
};

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
  allowInGeneral: boolean;
  allowInTopic: boolean;
};

const SLASH_COMMAND_DEFINITIONS = [
  {
    command: "stop",
    description: "Stop the current response",
    kind: "kirbot",
    visible: true,
    allowInGeneral: false,
    allowInTopic: true
  },
  {
    command: "plan",
    description: "Switch this topic into plan mode",
    kind: "kirbot",
    visible: true,
    allowInGeneral: true,
    allowInTopic: true
  },
  {
    command: "thread",
    description: "Start a new topic thread",
    kind: "kirbot",
    visible: true,
    allowInGeneral: true,
    allowInTopic: false
  },
  {
    command: "restart",
    description: "Rebuild and restart kirbot",
    kind: "kirbot",
    visible: true,
    allowInGeneral: true,
    allowInTopic: false
  },
  {
    command: "implement",
    description: "Implement the plan in this topic",
    kind: "kirbot",
    visible: true,
    allowInGeneral: false,
    allowInTopic: true
  },
  {
    command: "cmd",
    description: "Manage custom thread commands",
    kind: "kirbot",
    visible: true,
    allowInGeneral: true,
    allowInTopic: false
  },
  {
    command: "model",
    description: "Choose the current session model",
    kind: "codex",
    visible: true,
    allowInGeneral: true,
    allowInTopic: true
  },
  {
    command: "fast",
    description: "Toggle fast mode for the current session",
    kind: "codex",
    visible: true,
    allowInGeneral: true,
    allowInTopic: true
  },
  {
    command: "compact",
    description: "Compact the current thread",
    kind: "codex",
    visible: true,
    allowInGeneral: true,
    allowInTopic: true
  },
  {
    command: "clear",
    description: "Start a fresh Codex thread",
    kind: "codex",
    visible: true,
    allowInGeneral: true,
    allowInTopic: true
  },
  {
    command: "permissions",
    description: "Set permissions for the current session",
    kind: "codex",
    visible: true,
    allowInGeneral: true,
    allowInTopic: true
  },
  {
    command: "commands",
    description: "Show the command keyboard",
    kind: "kirbot",
    visible: true,
    allowInGeneral: true,
    allowInTopic: true
  },
  {
    command: "approvals",
    description: "Alias for /permissions",
    kind: "codex",
    visible: false,
    allowInGeneral: true,
    allowInTopic: true
  }
] satisfies readonly SlashCommandDefinition[];

const SLASH_COMMAND_BY_NAME = new Map(
  SLASH_COMMAND_DEFINITIONS.map((definition) => [definition.command, definition])
);

const GENERAL_COMMAND_SET: ReadonlySet<string> = new Set(
  SLASH_COMMAND_DEFINITIONS.filter((definition) => definition.allowInGeneral).map((definition) => definition.command)
);
const TOPIC_COMMAND_SET: ReadonlySet<string> = new Set(
  SLASH_COMMAND_DEFINITIONS.filter((definition) => definition.allowInTopic).map((definition) => definition.command)
);

export function getVisibleSlashCommands(scope?: SlashCommandScope): readonly TelegramBotCommand[] {
  return SLASH_COMMAND_DEFINITIONS
    .filter((definition) => definition.visible)
    .filter((definition) => {
      if (!scope) {
        return true;
      }

      return scope === "general" ? definition.allowInGeneral : definition.allowInTopic;
    })
    .map((definition) => ({
      command: definition.command,
      description: definition.description
    }));
}

export function getSurfaceableTopicSlashCommands(): readonly TelegramBotCommand[] {
  return getVisibleSlashCommands("topic");
}

export function isAllowedSlashCommandInScope(command: string, scope: SlashCommandScope): boolean {
  return scope === "general"
    ? GENERAL_COMMAND_SET.has(command as SlashCommandName)
    : TOPIC_COMMAND_SET.has(command as SlashCommandName);
}

export function parseSlashCommandToken(text: string): ParsedSlashCommandToken | null {
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
    ?.toLowerCase();
  if (!command) {
    return null;
  }

  return {
    command,
    argsText: rest.join(" ").trim()
  };
}

export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const parsed = parseSlashCommandToken(text);
  if (!parsed) {
    return null;
  }

  const definition = SLASH_COMMAND_BY_NAME.get(parsed.command as SlashCommandName);
  if (!definition) {
    return null;
  }

  return {
    command: parsed.command as SlashCommandName,
    argsText: parsed.argsText,
    definition
  };
}

export function isBuiltInSlashCommand(command: string): command is SlashCommandName {
  return SLASH_COMMAND_BY_NAME.has(command as SlashCommandName);
}

export function isCodexSlashCommand(command: SlashCommandName): command is CodexSlashCommand {
  return command === "model" || command === "fast" || command === "compact" || command === "clear" || command === "approvals" || command === "permissions";
}
