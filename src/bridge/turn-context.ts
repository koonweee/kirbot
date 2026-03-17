import type { TurnStatusDraft } from "./presentation";
import type { TelegramStatusDraftHandle, TelegramStreamMessageHandle } from "../telegram-messenger";

export type TurnPhase = "submitting" | "active" | "finalizing" | "completed" | "failed" | "interrupted";
export type TerminalTurnStatus = Extract<TurnPhase, "completed" | "failed" | "interrupted">;

export type CommentaryStreamState = {
  handle: TelegramStreamMessageHandle;
  text: string;
};

export type TurnContext = {
  chatId: number;
  topicId: number;
  threadId: string;
  turnId: string;
  phase: TurnPhase;
  stopRequested: boolean;
  submitPendingSteersAfterInterrupt: boolean;
  statusDraft: TurnStatusDraft | null;
  lastStatusUpdateAt: number;
  statusHandle: TelegramStatusDraftHandle;
  finalStream: TelegramStreamMessageHandle;
  commentaryStreams: Map<string, CommentaryStreamState>;
};

export function transitionTurnPhase(context: TurnContext, nextPhase: TurnPhase): void {
  if (!isAllowedTransition(context.phase, nextPhase)) {
    throw new Error(`Illegal turn phase transition: ${context.phase} -> ${nextPhase}`);
  }

  context.phase = nextPhase;
}

export function isTerminalTurnPhase(phase: TurnPhase): phase is TerminalTurnStatus {
  return phase === "completed" || phase === "failed" || phase === "interrupted";
}

function isAllowedTransition(current: TurnPhase, next: TurnPhase): boolean {
  switch (current) {
    case "submitting":
      return next === "active";
    case "active":
      return next === "finalizing";
    case "finalizing":
      return next === "completed" || next === "failed" || next === "interrupted";
    case "completed":
    case "failed":
    case "interrupted":
      return false;
  }
}
