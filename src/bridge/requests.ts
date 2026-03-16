import type { RequestId } from "../generated/codex/RequestId";
import type { CommandExecutionApprovalDecision } from "../generated/codex/v2/CommandExecutionApprovalDecision";
import type { CommandExecutionRequestApprovalParams } from "../generated/codex/v2/CommandExecutionRequestApprovalParams";
import type { FileChangeApprovalDecision } from "../generated/codex/v2/FileChangeApprovalDecision";
import type { FileChangeRequestApprovalParams } from "../generated/codex/v2/FileChangeRequestApprovalParams";
import type { ToolRequestUserInputResponse } from "../generated/codex/v2/ToolRequestUserInputResponse";
import type { InlineKeyboardMarkup } from "../telegram-messenger";
import type { UserInputServerRequest } from "../codex";

export function buildApprovalKeyboard(
  requestId: number,
  availableDecisions: ReadonlyArray<unknown> | null
): InlineKeyboardMarkup {
  const allows = (decision: string): boolean =>
    availableDecisions ? availableDecisions.some((value) => typeof value === "string" && value === decision) : true;

  const approveRow = [
    allows("accept") ? { text: "Approve", callback_data: `req:${requestId}:accept` } : null,
    allows("acceptForSession")
      ? { text: "Approve Session", callback_data: `req:${requestId}:acceptForSession` }
      : null
  ].filter((value): value is { text: string; callback_data: string } => value !== null);

  const denyRow = [
    allows("decline") ? { text: "Deny", callback_data: `req:${requestId}:decline` } : null,
    allows("cancel") ? { text: "Interrupt", callback_data: `req:${requestId}:cancel` } : null
  ].filter((value): value is { text: string; callback_data: string } => value !== null);

  return {
    inline_keyboard: [approveRow, denyRow].filter((row) => row.length > 0)
  };
}

export function formatCommandApprovalPrompt(params: CommandExecutionRequestApprovalParams): string {
  const command = params.command ?? "(unknown command)";
  const cwd = params.cwd ?? "(unknown cwd)";
  const reason = params.reason ? `Reason: ${params.reason}` : "Reason: not provided";

  return ["Codex requested command approval.", `Command: ${command}`, `Cwd: ${cwd}`, reason].join("\n");
}

export function formatFileChangeApprovalPrompt(params: FileChangeRequestApprovalParams): string {
  return ["Codex requested file-change approval.", `Turn: ${params.turnId}`, `Item: ${params.itemId}`].join("\n");
}

export function parseUserInputResponse(
  text: string,
  questions: UserInputServerRequest["params"]["questions"]
): ToolRequestUserInputResponse {
  if (questions.length === 1) {
    const question = questions[0];
    if (!question) {
      throw new Error("Expected a single question for user input parsing");
    }

    return {
      answers: {
        [question.id]: {
          answers: [text.trim()]
        }
      }
    };
  }

  const parsed = JSON.parse(text) as Record<string, string | Array<string>>;
  const answers = Object.fromEntries(
    questions.map((question) => {
      const value = parsed[question.id];
      const normalized = Array.isArray(value) ? value : value ? [value] : [];
      return [question.id, { answers: normalized }];
    })
  );

  return { answers };
}

export function parseRequestId(value: string): RequestId {
  return JSON.parse(value) as RequestId;
}

export function normalizeCommandApprovalDecision(action: string): CommandExecutionApprovalDecision {
  switch (action) {
    case "accept":
      return "accept";
    case "acceptForSession":
      return "acceptForSession";
    case "decline":
      return "decline";
    case "cancel":
    default:
      return "cancel";
  }
}

export function normalizeFileApprovalDecision(action: string): FileChangeApprovalDecision {
  switch (action) {
    case "accept":
      return "accept";
    case "acceptForSession":
      return "acceptForSession";
    case "decline":
      return "decline";
    case "cancel":
    default:
      return "cancel";
  }
}
