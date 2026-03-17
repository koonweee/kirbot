import type { UserTurnMessage } from "./domain";
import type { MessagePhase } from "./generated/codex/MessagePhase";
import type { ThreadItem } from "./generated/codex/v2/ThreadItem";
import type { TelegramStatusDraftHandle, TelegramStreamMessageHandle } from "./telegram-messenger";
import {
  BridgeTurnRuntime,
  type AssistantDraftKind,
  type AssistantRenderUpdate,
  type PendingSteerDrain,
  type QueueStateSnapshot,
  type RuntimeTurn
} from "./turn-runtime";

export type TurnPhase = "submitting" | "active" | "finalizing" | "completed" | "failed" | "interrupted";

export type TurnTerminalStatus = Extract<TurnPhase, "completed" | "failed" | "interrupted">;

export type TurnStatusState =
  | "thinking"
  | "planning"
  | "using tool"
  | "running"
  | "editing"
  | "searching"
  | "streaming"
  | "waiting"
  | "done"
  | "failed"
  | "interrupted";

export type TurnStatusDraft = {
  state: TurnStatusState;
  emoji: string;
  details: string | null;
};

export type CommentaryStreamState = {
  handle: TelegramStreamMessageHandle;
  text: string;
};

export type TurnContext = {
  chatId: number;
  topicId: number;
  threadId: string;
  turnId: string;
  draftId: number;
  phase: TurnPhase;
  statusDraft: TurnStatusDraft | null;
  lastStatusUpdateAt: number;
  statusHandle: TelegramStatusDraftHandle;
  finalStream: TelegramStreamMessageHandle;
  commentaryStreams: Map<string, CommentaryStreamState>;
  submitPendingSteersAfterInterrupt: boolean;
};

export type ActivateTurnInput = {
  chatId: number;
  topicId: number;
  threadId: string;
  turnId: string;
  draftId: number;
  statusDraft: TurnStatusDraft | null;
  lastStatusUpdateAt: number;
  statusHandle: TelegramStatusDraftHandle;
  finalStream: TelegramStreamMessageHandle;
};

export type AssistantLifecycleUpdate = {
  context: TurnContext;
  update: AssistantRenderUpdate;
};

export type QueuedSteerAttachment = {
  context: TurnContext;
  localId: string;
  queueState: QueueStateSnapshot;
};

export type InterruptedTurnPreparation = {
  context: TurnContext;
  submitPendingSteers: boolean;
  pendingSteers: PendingSteerDrain | null;
};

export type FinalizedTurn = {
  context: TurnContext;
  queueState: QueueStateSnapshot | null;
};

export type AssistantDraftSnapshot = {
  text: string;
  kind: AssistantDraftKind | null;
};

export class TurnLifecycle {
  readonly #runtime: BridgeTurnRuntime;
  readonly #turns = new Map<string, TurnContext>();

  constructor(runtime = new BridgeTurnRuntime()) {
    this.#runtime = runtime;
  }

  activateTurn(input: ActivateTurnInput): TurnContext {
    const context: TurnContext = {
      chatId: input.chatId,
      topicId: input.topicId,
      threadId: input.threadId,
      turnId: input.turnId,
      draftId: input.draftId,
      phase: "active",
      statusDraft: input.statusDraft,
      lastStatusUpdateAt: input.lastStatusUpdateAt,
      statusHandle: input.statusHandle,
      finalStream: input.finalStream,
      commentaryStreams: new Map(),
      submitPendingSteersAfterInterrupt: false
    };

    this.#turns.set(context.turnId, context);
    this.#runtime.registerTurn({
      chatId: context.chatId,
      topicId: context.topicId,
      threadId: context.threadId,
      turnId: context.turnId,
      draftId: context.draftId
    });
    return context;
  }

  getContext(turnId: string): TurnContext | undefined {
    return this.#turns.get(turnId);
  }

  getRuntimeTurn(turnId: string): RuntimeTurn | undefined {
    return this.#runtime.getTurn(turnId);
  }

  getActiveTurnByTopic(chatId: number, topicId: number): TurnContext | undefined {
    const runtimeTurn = this.#runtime.getActiveTurnByTopic(chatId, topicId);
    return runtimeTurn ? this.#turns.get(runtimeTurn.turnId) : undefined;
  }

  getQueueState(chatId: number, topicId: number): QueueStateSnapshot {
    return this.#runtime.getQueueState(chatId, topicId);
  }

  peekNextQueuedFollowUp(chatId: number, topicId: number): UserTurnMessage | undefined {
    return this.#runtime.peekNextQueuedFollowUp(chatId, topicId);
  }

  shiftNextQueuedFollowUp(chatId: number, topicId: number): UserTurnMessage | undefined {
    return this.#runtime.shiftNextQueuedFollowUp(chatId, topicId);
  }

  prependQueuedFollowUp(chatId: number, topicId: number, message: UserTurnMessage): QueueStateSnapshot {
    return this.#runtime.prependQueuedFollowUp(chatId, topicId, message);
  }

  queuePendingSteer(turnId: string, message: UserTurnMessage): QueuedSteerAttachment | null {
    const context = this.#turns.get(turnId);
    if (!context || context.phase !== "active") {
      return null;
    }

    const runtimeTurn = this.#runtime.getTurn(turnId);
    if (!runtimeTurn) {
      return null;
    }

    const pending = this.#runtime.queuePendingSteer(runtimeTurn, message);
    return {
      context,
      localId: pending.localId,
      queueState: pending.queueState
    };
  }

  movePendingSteerToQueued(chatId: number, topicId: number, localId: string): QueueStateSnapshot {
    return this.#runtime.movePendingSteerToQueued(chatId, topicId, localId);
  }

  dropPendingSteer(chatId: number, topicId: number, localId: string): QueueStateSnapshot {
    return this.#runtime.dropPendingSteer(chatId, topicId, localId);
  }

  acknowledgeCommittedUserItem(turnId: string, item: Extract<ThreadItem, { type: "userMessage" }>): QueueStateSnapshot | null {
    return this.#runtime.acknowledgeCommittedUserItem(turnId, item);
  }

  requestSubmitPendingSteersAfterInterrupt(turnId: string): boolean {
    const context = this.#turns.get(turnId);
    if (!context || context.phase !== "active") {
      return false;
    }

    context.submitPendingSteersAfterInterrupt = true;
    return true;
  }

  shouldSubmitPendingSteersAfterInterrupt(turnId: string): boolean {
    return this.#turns.get(turnId)?.submitPendingSteersAfterInterrupt ?? false;
  }

  clearPendingInterruptSubmission(turnId: string): void {
    const context = this.#turns.get(turnId);
    if (context) {
      context.submitPendingSteersAfterInterrupt = false;
    }
  }

  prepareInterruptedFinalization(turnId: string, submitPendingSteers = this.shouldSubmitPendingSteersAfterInterrupt(turnId)):
    InterruptedTurnPreparation | null {
    const context = this.#turns.get(turnId);
    if (!context || context.phase !== "active") {
      return null;
    }

    const pendingSteers = submitPendingSteers ? this.#runtime.drainPendingSteers(context.chatId, context.topicId) : null;
    if (!submitPendingSteers) {
      this.#runtime.movePendingSteersToQueued(context.chatId, context.topicId);
    }
    context.submitPendingSteersAfterInterrupt = false;

    return {
      context,
      submitPendingSteers,
      pendingSteers
    };
  }

  registerAssistantItem(turnId: string, itemId: string, phase: MessagePhase | null): void {
    this.#runtime.registerAssistantItem(turnId, itemId, phase);
  }

  appendAssistantDelta(turnId: string, itemId: string, delta: string): AssistantLifecycleUpdate | null {
    const context = this.#turns.get(turnId);
    if (!context || context.phase !== "active") {
      return null;
    }

    const update = this.#runtime.appendAssistantDelta(turnId, itemId, delta);
    if (!update) {
      return null;
    }

    return {
      context,
      update
    };
  }

  commitAssistantItem(turnId: string, itemId: string, text: string, phase: MessagePhase | null): AssistantLifecycleUpdate | null {
    const context = this.#turns.get(turnId);
    if (!context || context.phase !== "active") {
      return null;
    }

    const update = this.#runtime.commitAssistantItem(turnId, itemId, text, phase);
    if (!update) {
      return null;
    }

    return {
      context,
      update
    };
  }

  renderAssistantItems(turnId: string): string {
    return this.#runtime.renderAssistantItems(turnId);
  }

  renderAssistantDraft(turnId: string): AssistantDraftSnapshot {
    return this.#runtime.renderAssistantDraft(turnId);
  }

  hasAssistantText(turnId: string): boolean {
    return this.#runtime.getTurn(turnId)?.hasAssistantText ?? false;
  }

  beginFinalization(turnId: string): TurnContext | null {
    const context = this.#turns.get(turnId);
    if (!context || context.phase !== "active") {
      return null;
    }

    context.phase = "finalizing";
    return context;
  }

  finalizeTurn(turnId: string, terminalStatus: TurnTerminalStatus): FinalizedTurn | null {
    const context = this.#turns.get(turnId);
    if (!context || (context.phase !== "active" && context.phase !== "finalizing")) {
      return null;
    }

    context.phase = terminalStatus;
    const queueState = this.#runtime.finalizeTurn(turnId);
    this.#turns.delete(turnId);

    return {
      context,
      queueState
    };
  }
}
