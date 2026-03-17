export type TelegramBotCommand = {
  command: string;
  description: string;
};

type TelegramCommandName = "stop" | "plan" | "implement";

const COMMAND_DEFINITIONS: Readonly<Record<TelegramCommandName, TelegramBotCommand>> = {
  stop: {
    command: "stop",
    description: "Stop the current response"
  },
  plan: {
    command: "plan",
    description: "Switch this topic into plan mode"
  },
  implement: {
    command: "implement",
    description: "Implement the latest plan in this topic"
  }
};

const ROOT_COMMAND_ALLOWLIST: readonly TelegramCommandName[] = [];
const TOPIC_COMMAND_ALLOWLIST: readonly TelegramCommandName[] = ["stop", "plan", "implement"];

const ROOT_COMMANDS = buildTelegramCommands(ROOT_COMMAND_ALLOWLIST);
const TOPIC_COMMANDS = buildTelegramCommands(TOPIC_COMMAND_ALLOWLIST);
const ALL_VISIBLE_COMMANDS = buildTelegramCommands([
  ...ROOT_COMMAND_ALLOWLIST,
  ...TOPIC_COMMAND_ALLOWLIST
]);

const ROOT_COMMAND_SET = new Set(ROOT_COMMANDS.map((command) => command.command));
const TOPIC_COMMAND_SET = new Set(TOPIC_COMMANDS.map((command) => command.command));

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
    .filter((definition, index, definitions) => (
      definitions.findIndex((candidate) => candidate.command === definition.command) === index
    ));
}
