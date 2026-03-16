import type { JsonRpcMethodError } from "../rpc";

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

type SteerErrorClassification =
  | {
      kind: "stale_or_missing_active_turn";
    }
  | {
      kind: "invalid_input";
      userMessage: string;
    }
  | {
      kind: "fatal";
    };

export function classifySteerError(error: unknown): SteerErrorClassification {
  if (isJsonRpcMethodError(error) && error.method === "turn/steer") {
    const structured = isRecord(error.data) ? error.data : null;
    if (structured && "input_error_code" in structured) {
      const maxChars = typeof structured.max_chars === "number" ? structured.max_chars : null;
      const actualChars = typeof structured.actual_chars === "number" ? structured.actual_chars : null;
      const limitMessage =
        maxChars !== null && actualChars !== null
          ? `Codex rejected the follow-up because it exceeds the maximum input length (${actualChars}/${maxChars} characters).`
          : `Codex rejected the follow-up: ${error.message}`;
      return {
        kind: "invalid_input",
        userMessage: limitMessage
      };
    }

    if (error.code === -32600 && isSteerRaceMessage(error.message, structured)) {
      return {
        kind: "stale_or_missing_active_turn"
      };
    }
  }

  if (isSteerRaceMessage(error instanceof Error ? error.message : String(error))) {
    return {
      kind: "stale_or_missing_active_turn"
    };
  }

  return {
    kind: "fatal"
  };
}

type InterruptErrorClassification =
  | {
      kind: "stale_or_missing_active_turn";
    }
  | {
      kind: "fatal";
    };

export function classifyInterruptError(error: unknown): InterruptErrorClassification {
  if (isJsonRpcMethodError(error) && error.method === "turn/interrupt") {
    const structured = isRecord(error.data) ? error.data : null;
    if (error.code === -32600 && isInterruptRaceMessage(error.message, structured)) {
      return {
        kind: "stale_or_missing_active_turn"
      };
    }
  }

  if (isInterruptRaceMessage(error instanceof Error ? error.message : String(error))) {
    return {
      kind: "stale_or_missing_active_turn"
    };
  }

  return {
    kind: "fatal"
  };
}

function isJsonRpcMethodError(error: unknown): error is JsonRpcMethodError {
  return typeof error === "object" && error !== null && error.constructor?.name === "JsonRpcMethodError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isInterruptRaceMessage(message: string, structured?: Record<string, unknown> | null): boolean {
  if (structured?.kind === "invalid_active_turn") {
    return true;
  }

  const normalized = message.toLowerCase();
  return (
    normalized.includes("no active turn") ||
    normalized.includes("not the active turn") ||
    normalized.includes("already ended") ||
    normalized.includes("already completed")
  );
}

function isSteerRaceMessage(messageText: string, data?: Record<string, unknown> | null): boolean {
  const message = messageText.toLowerCase();
  const dataKind = typeof data?.kind === "string" ? data.kind.toLowerCase() : "";
  return [
    "expectedturnid",
    "active turn",
    "not active",
    "no active turn",
    "does not match",
    "mismatch",
    "precondition",
    "stale",
    "invalid_active_turn"
  ].some((needle) => message.includes(needle) || dataKind.includes(needle));
}
