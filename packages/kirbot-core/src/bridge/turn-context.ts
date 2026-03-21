import type { TurnStatusDraft } from "./presentation";
import type { SessionMode } from "../domain";
import type { ThreadTokenUsage } from "@kirbot/codex-client/generated/codex/v2/ThreadTokenUsage";
import type { ReasoningEffort } from "@kirbot/codex-client/generated/codex/ReasoningEffort";
import type { ServiceTier } from "@kirbot/codex-client/generated/codex/ServiceTier";
import type { TelegramTurnStream } from "./telegram-streaming";

export type TurnPhase = "submitting" | "active" | "finalizing" | "completed" | "failed" | "interrupted";
export type TerminalTurnStatus = Extract<TurnPhase, "completed" | "failed" | "interrupted">;

export type TurnDraftMode = "status" | "assistant";

export type TurnContext = {
  chatId: number;
  topicId: number | null;
  threadId: string;
  turnId: string;
  phase: TurnPhase;
  stopRequested: boolean;
  submitPendingSteersAfterInterrupt: boolean;
  startedAtMs: number;
  draftMode: TurnDraftMode;
  statusDraft: TurnStatusDraft | null;
  lastStatusUpdateAt: number;
  visibleMessageHandle: TelegramTurnStream;
  statusElapsedTimer: NodeJS.Timeout | null;
  compactionNoticeSent: boolean;
  publishedPlanMessages: number;
  changedFilePaths: Set<string>;
  mode: SessionMode;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  serviceTier: ServiceTier | null;
  tokenUsage: ThreadTokenUsage | null;
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
