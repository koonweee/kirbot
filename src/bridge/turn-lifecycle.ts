import type { UserTurnMessage } from "../domain";
import type { ThreadItem } from "../generated/codex/v2/ThreadItem";
import type { ThreadTokenUsage } from "../generated/codex/v2/ThreadTokenUsage";
import {
  buildRenderedCommentaryMessage,
  buildStableDraftId,
  buildStatusDraft,
  buildStatusDraftForItem,
  isSameStatusDraft,
  renderTelegramAssistantDraft,
  renderTelegramCommentaryDraft,
  renderTelegramStatusDraft,
  type TurnStatusDraft
} from "./presentation";
import { type AssistantRenderUpdate, type QueueStateSnapshot } from "../turn-runtime";
import { type TurnContext, transitionTurnPhase } from "./turn-context";
import {
  type TurnLifecycleDependencies,
  TurnFinalizer
} from "./turn-finalization";

export type { TurnContext } from "./turn-context";

export class TurnLifecycleCoordinator {
  readonly #turns = new Map<string, TurnContext>();
  readonly #finalizer: TurnFinalizer;

  constructor(private readonly deps: TurnLifecycleDependencies) {
    this.#finalizer = new TurnFinalizer(deps);
  }

  activateTurn(message: UserTurnMessage, threadId: string, turnId: string, model: string | null): TurnContext {
    if (message.topicId === null) {
      throw new Error("Cannot create an active turn without a Telegram topic id");
    }

    const startedAtMs = Date.now();
    const context: TurnContext = {
      chatId: message.chatId,
      topicId: message.topicId,
      threadId,
      turnId,
      phase: "submitting",
      stopRequested: false,
      submitPendingSteersAfterInterrupt: false,
      startedAtMs,
      statusDraft: buildStatusDraft("thinking"),
      lastStatusUpdateAt: startedAtMs,
      statusHandle: this.deps.messenger.statusDraft({
        chatId: message.chatId,
        topicId: message.topicId,
        draftId: buildStableDraftId(`${turnId}:status`)
      }),
      statusElapsedTimer: null,
      finalStream: this.deps.messenger.streamMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        draftId: buildStableDraftId(`${turnId}:final`)
      }),
      commentaryStreams: new Map(),
      model,
      tokenUsage: null
    };

    transitionTurnPhase(context, "active");
    this.#turns.set(turnId, context);
    context.statusElapsedTimer = setInterval(() => {
      void this.publishCurrentStatus(turnId, false).catch((error) => {
        console.warn(`Failed to refresh elapsed status for turn ${turnId}`, error);
      });
    }, 3000);
    context.statusElapsedTimer.unref?.();
    this.deps.runtime.registerTurn({
      chatId: message.chatId,
      topicId: message.topicId,
      threadId,
      turnId
    });
    return context;
  }

  getTurn(turnId: string): TurnContext | undefined {
    return this.#turns.get(turnId);
  }

  getActiveTurnByTopic(chatId: number, topicId: number): TurnContext | undefined {
    const runtimeTurn = this.deps.runtime.getActiveTurnByTopic(chatId, topicId);
    return runtimeTurn ? this.#turns.get(runtimeTurn.turnId) : undefined;
  }

  getQueueState(chatId: number, topicId: number): QueueStateSnapshot {
    return this.deps.runtime.getQueueState(chatId, topicId);
  }

  renderAssistantItems(turnId: string): string {
    return this.deps.runtime.renderAssistantItems(turnId);
  }

  queuePendingSteer(turnId: string, message: UserTurnMessage): { localId: string; queueState: QueueStateSnapshot } | null {
    const runtimeTurn = this.deps.runtime.getTurn(turnId);
    if (!runtimeTurn) {
      return null;
    }

    return this.deps.runtime.queuePendingSteer(runtimeTurn, message);
  }

  movePendingSteerToQueued(chatId: number, topicId: number, localId: string): QueueStateSnapshot {
    return this.deps.runtime.movePendingSteerToQueued(chatId, topicId, localId);
  }

  dropPendingSteer(chatId: number, topicId: number, localId: string): QueueStateSnapshot {
    return this.deps.runtime.dropPendingSteer(chatId, topicId, localId);
  }

  peekNextQueuedFollowUp(chatId: number, topicId: number): UserTurnMessage | undefined {
    return this.deps.runtime.peekNextQueuedFollowUp(chatId, topicId);
  }

  shiftNextQueuedFollowUp(chatId: number, topicId: number): UserTurnMessage | undefined {
    return this.deps.runtime.shiftNextQueuedFollowUp(chatId, topicId);
  }

  prependQueuedFollowUp(chatId: number, topicId: number, message: UserTurnMessage): QueueStateSnapshot {
    return this.deps.runtime.prependQueuedFollowUp(chatId, topicId, message);
  }

  requestPendingSteerSubmissionAfterInterrupt(turnId: string): void {
    const context = this.#turns.get(turnId);
    if (context) {
      context.submitPendingSteersAfterInterrupt = true;
    }
  }

  clearPendingSteerSubmissionAfterInterrupt(turnId: string): void {
    const context = this.#turns.get(turnId);
    if (context) {
      context.submitPendingSteersAfterInterrupt = false;
    }
  }

  markStopRequested(turnId: string): TurnContext | undefined {
    const context = this.#turns.get(turnId);
    if (!context) {
      return undefined;
    }

    context.stopRequested = true;
    return context;
  }

  clearStopRequested(turnId: string): TurnContext | undefined {
    const context = this.#turns.get(turnId);
    if (!context) {
      return undefined;
    }

    context.stopRequested = false;
    return context;
  }

  async updateStatus(
    turnId: string,
    statusDraft: TurnStatusDraft,
    options?: { force?: boolean; preserveDetails?: boolean }
  ): Promise<void> {
    const context = this.#turns.get(turnId);
    if (!context) {
      return;
    }

    const now = Date.now();
    const nextStatus =
      options?.preserveDetails &&
      context.statusDraft?.state === statusDraft.state &&
      context.statusDraft.details
        ? { ...statusDraft, details: context.statusDraft.details }
        : statusDraft;
    if (isSameStatusDraft(context.statusDraft, nextStatus)) {
      return;
    }

    if (!options?.force && now - context.lastStatusUpdateAt < 500) {
      return;
    }

    context.statusDraft = nextStatus;
    context.lastStatusUpdateAt = now;
    await context.statusHandle.set(
      renderTelegramStatusDraft(nextStatus, Date.now() - context.startedAtMs),
      options?.force ?? false
    );
  }

  async publishCurrentStatus(turnId: string, force = true): Promise<void> {
    const context = this.#turns.get(turnId);
    if (!context?.statusDraft) {
      return;
    }

    await context.statusHandle.set(
      renderTelegramStatusDraft(context.statusDraft, Date.now() - context.startedAtMs),
      force
    );
  }

  async handleTurnStarted(turnId: string): Promise<void> {
    await this.updateStatus(turnId, buildStatusDraft("thinking"));
  }

  async handleItemStarted(turnId: string, item: ThreadItem): Promise<void> {
    if (item.type === "agentMessage") {
      this.deps.runtime.registerAssistantItem(turnId, item.id, item.phase);
    }
    await this.updateStatus(turnId, buildStatusDraftForItem(item));
  }

  async handlePlanUpdated(turnId: string): Promise<void> {
    await this.updateStatus(turnId, buildStatusDraft("planning"));
  }

  async handleReasoningDelta(turnId: string): Promise<void> {
    await this.updateStatus(turnId, buildStatusDraft("thinking"));
  }

  async handleToolProgress(turnId: string): Promise<void> {
    await this.updateStatus(turnId, buildStatusDraft("using tool"), {
      preserveDetails: true
    });
  }

  async handleCommandOutput(turnId: string): Promise<void> {
    await this.updateStatus(turnId, buildStatusDraft("running"), {
      preserveDetails: true
    });
  }

  async handleFileChangeOutput(turnId: string): Promise<void> {
    await this.updateStatus(turnId, buildStatusDraft("editing"), {
      preserveDetails: true
    });
  }

  async handleAssistantDelta(turnId: string, itemId: string, delta: string): Promise<void> {
    const context = this.#turns.get(turnId);
    const update = this.deps.runtime.appendAssistantDelta(turnId, itemId, delta);
    if (!context || !update) {
      return;
    }

    await this.deps.appendTurnStream(context.turnId, update.finalText);
    await this.handleAssistantRenderUpdate(context, update, "delta", update.startedAssistantText);
  }

  async handleItemCompleted(turnId: string, item: ThreadItem): Promise<void> {
    if (item.type === "userMessage") {
      const queueState = this.deps.runtime.acknowledgeCommittedUserItem(turnId, item);
      if (queueState) {
        await this.deps.syncQueuePreview(queueState);
      }
      return;
    }

    if (item.type !== "agentMessage") {
      return;
    }

    const context = this.#turns.get(turnId);
    const update = this.deps.runtime.commitAssistantItem(turnId, item.id, item.text, item.phase);
    if (!context || !update) {
      return;
    }

    await this.deps.appendTurnStream(context.turnId, update.finalText);
    await this.handleAssistantRenderUpdate(context, update, "completed", true);
  }

  async completeTurn(threadId: string, turnId: string): Promise<void> {
    await this.#finalizer.finalizeTurn(this.#turns, turnId, {
      terminalStatus: "completed",
      threadId,
      publishWhenEmpty: true,
      scheduleNextQueuedFollowUp: true,
      submitPendingSteers: false,
      movePendingSteersToQueued: false,
      publishFooter: true,
      buildFinalText: (resolvedText) => resolvedText || "(no assistant output)"
    });
  }

  async failTurn(threadId: string, turnId: string, errorMessage: string): Promise<void> {
    await this.#finalizer.finalizeTurn(this.#turns, turnId, {
      terminalStatus: "failed",
      threadId,
      publishWhenEmpty: true,
      scheduleNextQueuedFollowUp: true,
      submitPendingSteers: false,
      movePendingSteersToQueued: false,
      publishFooter: true,
      buildFinalText: (resolvedText) => [resolvedText, `\n\nCodex error: ${errorMessage}`].filter(Boolean).join("")
    });
  }

  async finalizeInterruptedTurnById(threadId: string, turnId: string): Promise<void> {
    const context = this.#turns.get(turnId);
    if (!context) {
      return;
    }

    await this.#finalizer.finalizeTurn(this.#turns, turnId, {
      terminalStatus: "interrupted",
      threadId,
      publishWhenEmpty: false,
      scheduleNextQueuedFollowUp: false,
      submitPendingSteers: context.submitPendingSteersAfterInterrupt,
      movePendingSteersToQueued: !context.submitPendingSteersAfterInterrupt,
      publishFooter: false,
      buildFinalText: (resolvedText) => resolvedText
    });
  }

  handleThreadTokenUsageUpdated(turnId: string, tokenUsage: ThreadTokenUsage): void {
    const context = this.#turns.get(turnId);
    if (context) {
      context.tokenUsage = tokenUsage;
    }
  }

  handleModelRerouted(turnId: string, model: string): void {
    const context = this.#turns.get(turnId);
    if (context) {
      context.model = model;
    }
  }

  private async handleAssistantRenderUpdate(
    context: TurnContext,
    update: AssistantRenderUpdate,
    stage: "delta" | "completed",
    forceDraft = false
  ): Promise<void> {
    if (update.itemPhase === "commentary") {
      const commentary = this.getOrCreateCommentaryStream(context, update.itemId);
      commentary.text = update.itemText;
      if (stage === "completed") {
        await commentary.handle.finalize(buildRenderedCommentaryMessage(update.itemText));
        context.commentaryStreams.delete(update.itemId);
        return;
      }

      await commentary.handle.update(renderTelegramCommentaryDraft(update.itemText), forceDraft);
      return;
    }

    if (update.draftKind === "assistant") {
      await context.finalStream.update(renderTelegramAssistantDraft(update.draftText || "…"), forceDraft);
    }
  }

  private getOrCreateCommentaryStream(context: TurnContext, itemId: string) {
    const existing = context.commentaryStreams.get(itemId);
    if (existing) {
      return existing;
    }

    const created = {
      handle: this.deps.messenger.streamMessage({
        chatId: context.chatId,
        topicId: context.topicId,
        draftId: buildStableDraftId(`${context.turnId}:commentary:${itemId}`)
      }),
      text: ""
    };
    context.commentaryStreams.set(itemId, created);
    return created;
  }
}
