import type { UserTurnMessage } from "../domain";
import type { SessionMode } from "../domain";
import type { ReasoningEffort } from "@kirbot/codex-client/generated/codex/ReasoningEffort";
import type { ServiceTier } from "@kirbot/codex-client/generated/codex/ServiceTier";
import type { ThreadItem } from "@kirbot/codex-client/generated/codex/v2/ThreadItem";
import type { ThreadTokenUsage } from "@kirbot/codex-client/generated/codex/v2/ThreadTokenUsage";
import type { LoggerLike } from "../logging";
import {
  buildActivityLogEntryForItemCompleted,
  buildPlanArtifactMessages,
  buildOversizePlanArtifactMessage,
  buildStableDraftId,
  buildStatusDraft,
  buildStatusDraftForItem,
  isSameStatusDraft,
  renderTelegramAssistantDraft,
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

  constructor(
    private readonly deps: TurnLifecycleDependencies,
    private readonly logger: LoggerLike = console
  ) {
    this.#finalizer = new TurnFinalizer(deps, {
      publishCompletedPlan: this.publishCompletedPlan.bind(this)
    });
  }

  activateTurn(
    message: UserTurnMessage,
    threadId: string,
    turnId: string,
    model: string | null,
    reasoningEffort: ReasoningEffort | null = null,
    serviceTier: ServiceTier | null = null,
    mode: SessionMode = "default"
  ): TurnContext {
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
      draftMode: "status",
      statusDraft: buildStatusDraft("thinking"),
      lastStatusUpdateAt: startedAtMs,
      draftHandle: this.deps.messenger.streamMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        draftId: buildStableDraftId(`${turnId}:draft`)
      }),
      statusElapsedTimer: null,
      compactionNoticeSent: false,
      publishedPlanMessages: 0,
      changedFilePaths: new Set(),
      mode,
      model,
      reasoningEffort,
      serviceTier,
      tokenUsage: null
    };

    transitionTurnPhase(context, "active");
    this.#turns.set(turnId, context);
    context.statusElapsedTimer = setInterval(() => {
      void this.publishCurrentStatus(turnId, false).catch((error) => {
        this.logger.warn(`Failed to refresh elapsed status for turn ${turnId}`, error);
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

  getActiveTurnByTopic(chatId: number, topicId: number | null): TurnContext | undefined {
    const runtimeTurn = this.deps.runtime.getActiveTurnByTopic(chatId, topicId);
    return runtimeTurn ? this.#turns.get(runtimeTurn.turnId) : undefined;
  }

  markCompactionNoticeSentForThread(threadId: string): boolean {
    const context = Array.from(this.#turns.values()).find((turn) => turn.threadId === threadId && turn.phase === "active");
    if (!context) {
      return true;
    }

    if (context.compactionNoticeSent) {
      return false;
    }

    context.compactionNoticeSent = true;
    return true;
  }

  getQueueState(chatId: number, topicId: number | null): QueueStateSnapshot {
    return this.deps.runtime.getQueueState(chatId, topicId);
  }

  getActiveTurnCount(): number {
    return this.#turns.size;
  }

  getActiveTopics(): Array<{ chatId: number; topicId: number | null }> {
    return Array.from(this.#turns.values()).map((turn) => ({
      chatId: turn.chatId,
      topicId: turn.topicId
    }));
  }

  renderAssistantItems(turnId: string): string {
    return this.deps.runtime.renderAssistantItems(turnId);
  }

  renderPlanItems(turnId: string): string {
    return this.deps.runtime.renderPlanItems(turnId);
  }

  queuePendingSteer(turnId: string, message: UserTurnMessage): { localId: string; queueState: QueueStateSnapshot } | null {
    const runtimeTurn = this.deps.runtime.getTurn(turnId);
    if (!runtimeTurn) {
      return null;
    }

    return this.deps.runtime.queuePendingSteer(runtimeTurn, message);
  }

  movePendingSteerToQueued(chatId: number, topicId: number | null, localId: string): QueueStateSnapshot {
    return this.deps.runtime.movePendingSteerToQueued(chatId, topicId, localId);
  }

  dropPendingSteer(chatId: number, topicId: number | null, localId: string): QueueStateSnapshot {
    return this.deps.runtime.dropPendingSteer(chatId, topicId, localId);
  }

  peekNextQueuedFollowUp(chatId: number, topicId: number | null): UserTurnMessage | undefined {
    return this.deps.runtime.peekNextQueuedFollowUp(chatId, topicId);
  }

  shiftNextQueuedFollowUp(chatId: number, topicId: number | null): UserTurnMessage | undefined {
    return this.deps.runtime.shiftNextQueuedFollowUp(chatId, topicId);
  }

  prependQueuedFollowUp(chatId: number, topicId: number | null, message: UserTurnMessage): QueueStateSnapshot {
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
    options?: { force?: boolean }
  ): Promise<void> {
    const context = this.#turns.get(turnId);
    if (!context || context.phase !== "active") {
      return;
    }

    await this.setStatusDraft(context, statusDraft, Date.now(), options?.force ?? false);
  }

  async publishCurrentStatus(turnId: string, force = true): Promise<void> {
    const context = this.#turns.get(turnId);
    if (!context || context.phase !== "active" || !context.statusDraft || context.draftMode !== "status") {
      return;
    }

    const rendered = renderTelegramStatusDraft(context.statusDraft, Date.now() - context.startedAtMs);
    if (!rendered) {
      return;
    }

    await context.draftHandle.update(rendered, force);
  }

  async handleTurnStarted(turnId: string): Promise<void> {
    await this.updateStatus(turnId, buildStatusDraft("thinking"));
  }

  async handleItemStarted(turnId: string, item: ThreadItem): Promise<void> {
    const context = this.#turns.get(turnId);
    if (item.type === "agentMessage") {
      this.deps.runtime.registerAssistantItem(turnId, item.id, item.phase);
    } else if (item.type === "plan") {
      this.deps.runtime.registerPlanItem(turnId, item.id);
    } else if (item.type === "fileChange" && context) {
      for (const change of item.changes) {
        context.changedFilePaths.add(change.path);
      }
    }

    await this.updateStatus(turnId, buildStatusDraftForItem(item));
  }

  async handlePlanUpdated(turnId: string, details: string | null): Promise<void> {
    void details;
    await this.updateStatus(turnId, buildStatusDraft("planning"));
  }

  async handleToolProgress(turnId: string): Promise<void> {
    await this.updateStatus(turnId, buildStatusDraft("using tool"));
  }

  async handleCommandOutput(turnId: string): Promise<void> {
    await this.updateStatus(turnId, buildStatusDraft("running"));
  }

  async handleFileChangeOutput(turnId: string): Promise<void> {
    await this.updateStatus(turnId, buildStatusDraft("editing"));
  }

  async handleAssistantDelta(turnId: string, itemId: string, delta: string): Promise<void> {
    const context = this.#turns.get(turnId);
    const update = this.deps.runtime.appendAssistantDelta(turnId, itemId, delta);
    if (!context || !update) {
      return;
    }

    await this.handleAssistantRenderUpdate(context, update, update.startedAssistantText);
  }

  async handleItemCompleted(turnId: string, item: ThreadItem): Promise<void> {
    if (item.type === "userMessage") {
      const queueState = this.deps.runtime.acknowledgeCommittedUserItem(turnId, item);
      if (queueState) {
        await this.deps.syncQueuePreview(queueState);
      }
      return;
    }

    if (item.type === "plan") {
      const context = this.#turns.get(turnId);
      if (!context) {
        return;
      }

      this.deps.runtime.commitPlanItem(turnId, item.id, item.text);
      return;
    }

    if (item.type === "agentMessage") {
      const context = this.#turns.get(turnId);
      const update = this.deps.runtime.commitAssistantItem(turnId, item.id, item.text, item.phase);
      if (!context || !update) {
        return;
      }

      await this.handleAssistantRenderUpdate(context, update, true);
      return;
    }

    const context = this.#turns.get(turnId);
    if (!context) {
      return;
    }

    if (item.type === "fileChange") {
      for (const change of item.changes) {
        context.changedFilePaths.add(change.path);
      }
    }

    const activityLogEntry = buildActivityLogEntryForItemCompleted(item);
    if (activityLogEntry) {
      this.deps.runtime.appendActivityLogEntry(turnId, activityLogEntry);
    }

    if (item.type === "reasoning") {
      return;
    }

    if (item.type === "contextCompaction") {
      if (context.compactionNoticeSent) {
        return;
      }
      context.compactionNoticeSent = true;
    }
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
    forceDraft = false
  ): Promise<void> {
    if (update.itemPhase === "commentary") {
      return;
    }

    if (update.draftKind === "assistant") {
      context.draftMode = "assistant";
      context.statusDraft = null;
      await context.draftHandle.update(renderTelegramAssistantDraft(update.draftText || "…"), forceDraft);
    }
  }

  private async setStatusDraft(
    context: TurnContext,
    nextStatus: TurnStatusDraft,
    now: number,
    force: boolean
  ): Promise<void> {
    if (isSameStatusDraft(context.statusDraft, nextStatus)) {
      return;
    }

    if (!force && context.statusDraft?.state === nextStatus.state && now - context.lastStatusUpdateAt < 500) {
      return;
    }

    context.statusDraft = nextStatus;
    context.lastStatusUpdateAt = now;
    if (context.draftMode !== "status") {
      return;
    }

    const rendered = renderTelegramStatusDraft(nextStatus, Date.now() - context.startedAtMs);
    if (!rendered) {
      return;
    }

    await context.draftHandle.update(rendered, force);
  }

  private async publishCompletedPlan(context: TurnContext, plan: { itemId: string; text: string }): Promise<number> {
    const messageId = await this.sendMiniAppPlanMessage(context, plan.text);

    context.publishedPlanMessages += 1;
    return messageId;
  }

  private async sendMiniAppPlanMessage(context: TurnContext, markdownText: string): Promise<number> {
    try {
      const publications = buildPlanArtifactMessages(this.deps.planArtifactPublicUrl!, markdownText);
      let lastMessageId: number | null = null;

      for (const publication of publications) {
        lastMessageId = (
          await this.deps.messenger.sendMessage({
            chatId: context.chatId,
            topicId: context.topicId,
            text: publication.text,
            replyMarkup: publication.replyMarkup,
            disableNotification: lastMessageId === null ? false : true
          })
        ).messageId;
      }

      if (lastMessageId === null) {
        throw new Error("Failed to publish plan artifact");
      }

      return lastMessageId;
    } catch (error) {
      if (error instanceof Error && error.message === "mini_app_artifact_too_large") {
        return this.deps.messenger.sendMessage({
          chatId: context.chatId,
          topicId: context.topicId,
          ...buildOversizePlanArtifactMessage(),
          disableNotification: false
        }).then((message) => message.messageId);
      }

      throw error;
    }
  }
}
