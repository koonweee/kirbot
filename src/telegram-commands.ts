export type TelegramCommandSurface = "global" | "root" | "topic";

export type TelegramBotCommand = {
  command: string;
  description: string;
};

type TelegramCommandName = "stop";

type TelegramCommandDefinition = TelegramBotCommand & {
  surfaces: readonly TelegramCommandSurface[];
};

const COMMAND_DEFINITIONS: Readonly<Record<TelegramCommandName, TelegramCommandDefinition>> = {
  stop: {
    command: "stop",
    description: "Stop the current response",
    surfaces: ["topic"]
  }
};

const GLOBAL_COMMAND_ALLOWLIST: readonly TelegramCommandName[] = [];
const ROOT_COMMAND_ALLOWLIST: readonly TelegramCommandName[] = [];
const TOPIC_COMMAND_ALLOWLIST: readonly TelegramCommandName[] = ["stop"];

const GLOBAL_COMMANDS = buildTelegramCommands(GLOBAL_COMMAND_ALLOWLIST);
const ROOT_COMMANDS = buildTelegramCommands(ROOT_COMMAND_ALLOWLIST);
const TOPIC_COMMANDS = buildTelegramCommands(TOPIC_COMMAND_ALLOWLIST);
const ALL_VISIBLE_COMMANDS = buildTelegramCommands([
  ...GLOBAL_COMMAND_ALLOWLIST,
  ...ROOT_COMMAND_ALLOWLIST,
  ...TOPIC_COMMAND_ALLOWLIST
]);

const ROOT_COMMAND_SET = new Set(ROOT_COMMANDS.map((command) => command.command));
const TOPIC_COMMAND_SET = new Set(TOPIC_COMMANDS.map((command) => command.command));

export function getTelegramCommandsForSurface(surface: TelegramCommandSurface): readonly TelegramBotCommand[] {
  if (surface === "global") {
    return GLOBAL_COMMANDS;
  }

  if (surface === "root") {
    return ROOT_COMMANDS;
  }

  return TOPIC_COMMANDS;
}

export function getVisibleTelegramCommands(): readonly TelegramBotCommand[] {
  return ALL_VISIBLE_COMMANDS;
}

export function isAllowedRootCommand(command: string): boolean {
  return ROOT_COMMAND_SET.has(command);
}

export function isAllowedTopicCommand(command: string): boolean {
  return TOPIC_COMMAND_SET.has(command);
}

function buildTelegramCommands(allowlist: readonly TelegramCommandName[]): readonly TelegramBotCommand[] {
  return allowlist
    .map((name) => COMMAND_DEFINITIONS[name])
    .filter((definition, index, definitions) => {
      if (!definition.surfaces.length) {
        return false;
      }

      return definitions.findIndex((candidate) => candidate.command === definition.command) === index;
    })
    .map(({ command, description }) => ({ command, description }));
}
