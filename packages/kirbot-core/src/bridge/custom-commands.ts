export type CustomCommandAction = "add" | "update" | "delete";

export type ParsedCustomCommandManagerRequest =
  | {
      kind: "help";
    }
  | {
      kind: "invalid";
      message: string;
    }
  | {
      kind: "action";
      action: "add" | "update";
      commandName: string;
      prompt: string;
    }
  | {
      kind: "action";
      action: "delete";
      commandName: string;
    };

export type ParsedCustomCommandCallback =
  | {
      pendingId: number;
      action: "confirm";
    }
  | {
      pendingId: number;
      action: "cancel";
    };

const CUSTOM_COMMAND_NAME_PATTERN = /^[a-z]+(?:[-_][a-z]+)*$/;

const CMD_ADD_USAGE_TEXT = "Usage: /cmd add <command> <prompt>";
const CMD_UPDATE_USAGE_TEXT = "Usage: /cmd update <command> <prompt>";
const CMD_DELETE_USAGE_TEXT = "Usage: /cmd delete <command>";

export function buildCustomCommandHelpText(): string {
  return [
    "Manage custom thread commands.",
    CMD_ADD_USAGE_TEXT,
    CMD_UPDATE_USAGE_TEXT,
    CMD_DELETE_USAGE_TEXT,
    "Custom commands are typed-only and only work in topics."
  ].join("\n");
}

export function parseCustomCommandManagerRequest(argsText: string): ParsedCustomCommandManagerRequest {
  const trimmed = argsText.trim();
  if (!trimmed) {
    return {
      kind: "help"
    };
  }

  const [subcommandToken, ...rest] = trimmed.split(/\s+/);
  const subcommand = subcommandToken?.toLowerCase();

  if (subcommand === "add" || subcommand === "update") {
    const [commandToken, ...promptParts] = rest;
    if (!commandToken || promptParts.length === 0) {
      return {
        kind: "invalid",
        message: subcommand === "add" ? CMD_ADD_USAGE_TEXT : CMD_UPDATE_USAGE_TEXT
      };
    }

    return {
      kind: "action",
      action: subcommand,
      commandName: commandToken,
      prompt: promptParts.join(" ")
    };
  }

  if (subcommand === "delete") {
    if (rest.length !== 1) {
      return {
        kind: "invalid",
        message: CMD_DELETE_USAGE_TEXT
      };
    }

    return {
      kind: "action",
      action: "delete",
      commandName: rest[0] ?? ""
    };
  }

  return {
    kind: "invalid",
    message: buildCustomCommandHelpText()
  };
}

export function normalizeCustomCommandName(commandName: string): string {
  return commandName.trim().toLowerCase();
}

export function validateCustomCommandName(commandName: string): string | null {
  if (!CUSTOM_COMMAND_NAME_PATTERN.test(commandName)) {
    return 'Command names must use lowercase letters with optional internal "-" or "_" separators.';
  }

  return null;
}

export function validateCustomCommandPrompt(prompt: string): string | null {
  if (!prompt.trim()) {
    return "Prompt cannot be empty";
  }

  return null;
}

export function buildCustomCommandConfirmationText(commandName: string, prompt: string): string {
  return `Add custom command /${commandName}?\n\nPrompt:\n${prompt}`;
}

export function buildCustomCommandAddedText(commandName: string): string {
  return `Added /${commandName}`;
}

export function buildCustomCommandUpdatedText(commandName: string): string {
  return `Updated /${commandName}`;
}

export function buildCustomCommandDeletedText(commandName: string): string {
  return `Deleted /${commandName}`;
}

export function buildCustomCommandCanceledText(commandName: string): string {
  return `Canceled adding /${commandName}`;
}

export function buildCustomCommandDuplicateText(commandName: string): string {
  return `/${commandName} already exists`;
}

export function buildCustomCommandReservedText(commandName: string): string {
  return `/${commandName} is reserved`;
}

export function buildMissingCustomCommandText(commandName: string): string {
  return `/${commandName} does not exist`;
}

export function buildPendingCustomCommandCallbackData(
  pendingId: number,
  action: ParsedCustomCommandCallback["action"]
): string {
  return `customcmd:${pendingId}:${action}`;
}

export function parsePendingCustomCommandCallbackData(data: string): ParsedCustomCommandCallback | null {
  if (!data.startsWith("customcmd:")) {
    return null;
  }

  const [, pendingIdText, action] = data.split(":");
  const pendingId = Number.parseInt(pendingIdText ?? "", 10);
  if (Number.isNaN(pendingId) || (action !== "confirm" && action !== "cancel")) {
    return null;
  }

  return {
    pendingId,
    action
  };
}

export function expandCustomCommandPrompt(prompt: string, argsText: string): string {
  const trimmedArgs = argsText.trim();
  if (!trimmedArgs) {
    return prompt;
  }

  return `${prompt}\n\n${trimmedArgs}`;
}
