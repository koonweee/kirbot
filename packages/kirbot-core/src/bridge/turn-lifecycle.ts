import type { UserTurnMessage } from "../domain";
import type { ReasoningEffort } from "@kirbot/codex-client/generated/codex/ReasoningEffort";
import type { ThreadItem } from "@kirbot/codex-client/generated/codex/v2/ThreadItem";
import type { ThreadTokenUsage } from "@kirbot/codex-client/generated/codex/v2/ThreadTokenUsage";
import type { LoggerLike } from "../logging";
import {
  buildCompletedStatusDraftForItem,
  buildPlanArtifactMessage,
  buildRenderedCompletedItemMessage,
  buildOversizePlanArtifactMessage,
  buildStableDraftId,
  buildStatusDraft,
  buildStatusDraftForItem,
  isDurableCompletedItem,
  isSameStatusDraft,
  renderTelegramAssistantDraft,
  renderTelegramStatusDraft,
  type TurnStatusDraft
} from "./presentation";
import { type AssistantRenderUpdate, type PlanRenderUpdate, type QueueStateSnapshot } from "../turn-runtime";
import { type TurnContext, transitionTurnPhase } from "./turn-context";
import {
  type TurnLifecycleDependencies,
  TurnFinalizer
} from "./turn-finalization";

export type { TurnContext } from "./turn-context";

const RAW_REASONING_BUFFER_LIMIT = 2_000;
const RAW_REASONING_PREVIEW_LIMIT = 140;

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
    reasoningEffort: ReasoningEffort | null = null
  ): TurnContext {
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
      planStreams: new Map(),
      reasoningSummary: null,
      reasoningFallback: null,
      compactionNoticeSent: false,
      publishedPlanMessages: 0,
      model,
      reasoningEffort,
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

  getActiveTurnByTopic(chatId: number, topicId: number): TurnContext | undefined {
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

  getQueueState(chatId: number, topicId: number): QueueStateSnapshot {
    return this.deps.runtime.getQueueState(chatId, topicId);
  }

  getActiveTurnCount(): number {
    return this.#turns.size;
  }

  getActiveTopics(): Array<{ chatId: number; topicId: number }> {
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
    if (!context || context.phase !== "active") {
      return;
    }

    const now = Date.now();
    const nextStatus =
      options?.preserveDetails &&
      context.statusDraft?.state === statusDraft.state &&
      (context.statusDraft.inlineDetails || context.statusDraft.quotedDetails)
        ? {
            ...statusDraft,
            inlineDetails: context.statusDraft.inlineDetails,
            quotedDetails: context.statusDraft.quotedDetails
          }
        : statusDraft;
    await this.setStatusDraft(context, nextStatus, now, options?.force ?? false);
  }

  async publishCurrentStatus(turnId: string, force = true): Promise<void> {
    const context = this.#turns.get(turnId);
    if (!context || context.phase !== "active" || !context.statusDraft) {
      return;
    }

    await context.statusHandle.set(
      renderTelegramStatusDraft(context.statusDraft, Date.now() - context.startedAtMs),
      force
    );
  }

  async handleTurnStarted(turnId: string): Promise<void> {
    const context = this.#turns.get(turnId);
    if (context) {
      context.reasoningSummary = null;
      context.reasoningFallback = null;
    }
    await this.updateStatus(turnId, buildStatusDraft("thinking"));
  }

  async handleItemStarted(turnId: string, item: ThreadItem): Promise<void> {
    const context = this.#turns.get(turnId);
    if (context && item.type === "reasoning") {
      context.reasoningSummary = null;
      context.reasoningFallback = null;
    }

    if (item.type === "agentMessage") {
      this.deps.runtime.registerAssistantItem(turnId, item.id, item.phase);
    } else if (item.type === "plan") {
      this.deps.runtime.registerPlanItem(turnId, item.id);
    }
    await this.updateStatus(turnId, buildStatusDraftForItem(item));
  }

  async handlePlanUpdated(turnId: string, details: string | null): Promise<void> {
    await this.updateStatus(turnId, buildStatusDraft("planning", details));
  }

  async handlePlanDelta(turnId: string, itemId: string, delta: string): Promise<void> {
    void turnId;
    void itemId;
    void delta;
  }

  async handleReasoningDelta(turnId: string, itemId: string, summaryIndex: number, delta: string): Promise<void> {
    const context = this.#turns.get(turnId);
    if (!context || context.phase !== "active") {
      return;
    }

    const resetPreview =
      !context.reasoningSummary ||
      context.reasoningSummary.itemId !== itemId ||
      context.reasoningSummary.summaryIndex !== summaryIndex;
    const previousText = resetPreview ? "" : (context.reasoningSummary?.text ?? "");
    const nextText = `${previousText}${delta}`;

    context.reasoningSummary = {
      itemId,
      summaryIndex,
      text: nextText
    };
    await this.updateStatus(turnId, buildStatusDraft("thinking", null, nextText), {
      force: true
    });
  }

  async handleReasoningTextDelta(turnId: string, itemId: string, delta: string): Promise<void> {
    const context = this.#turns.get(turnId);
    if (!context || context.phase !== "active") {
      return;
    }

    const previousFallback = context.reasoningFallback;
    const resetPreview = !previousFallback || previousFallback.itemId !== itemId;
    const previousBuffer = resetPreview ? "" : previousFallback.buffer;
    const nextBuffer = `${previousBuffer}${delta}`.slice(-RAW_REASONING_BUFFER_LIMIT);
    const nextPreview = deriveRawReasoningPreview(nextBuffer);

    context.reasoningFallback = {
      itemId,
      buffer: nextBuffer,
      preview: nextPreview
    };

    if (context.reasoningSummary?.itemId === itemId && context.reasoningSummary.text.trim().length > 0) {
      return;
    }

    if (!nextPreview) {
      return;
    }

    await this.updateStatus(turnId, buildStatusDraft("thinking", null, nextPreview), {
      force: true
    });
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
    // TODO: Surface concise file-change progress details in Telegram once we have a stable summary format.
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
      const update = this.deps.runtime.commitPlanItem(turnId, item.id, item.text);
      if (!context || !update) {
        return;
      }

      await this.handlePlanRenderUpdate(context, update, "completed");
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

    if (item.type === "reasoning") {
      if (context.reasoningSummary?.itemId === item.id) {
        context.reasoningSummary = null;
      }
      if (context.reasoningFallback?.itemId === item.id) {
        context.reasoningFallback = null;
      }
      return;
    }

    if (item.type === "contextCompaction") {
      if (context.compactionNoticeSent) {
        return;
      }
      context.compactionNoticeSent = true;
    }

    if (!isDurableCompletedItem(item)) {
      const statusDraft = buildCompletedStatusDraftForItem(item);
      if (statusDraft) {
        await this.setStatusDraft(context, statusDraft, Date.now(), true);
      }
      return;
    }

    const rendered = buildRenderedCompletedItemMessage(item);
    if (!rendered) {
      return;
    }

    await this.deps.messenger.sendMessage({
      chatId: context.chatId,
      topicId: context.topicId,
      text: rendered.text,
      ...(rendered.entities ? { entities: rendered.entities } : {})
    });
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
      void forceDraft;
      return;
    }

    if (update.draftKind === "assistant") {
      await context.finalStream.update(renderTelegramAssistantDraft(update.draftText || "…"), forceDraft);
      await this.clearStatusDraft(context);
    }
  }

  private async handlePlanRenderUpdate(
    context: TurnContext,
    update: PlanRenderUpdate,
    stage: "delta" | "completed"
  ): Promise<void> {
    void context;
    void update;
    void stage;
  }

  private async clearStatusDraft(context: TurnContext): Promise<void> {
    context.reasoningSummary = null;
    context.reasoningFallback = null;
    if (!context.statusDraft) {
      return;
    }

    context.statusDraft = null;
    await context.statusHandle.clear();
  }

  private async setStatusDraft(
    context: TurnContext,
    nextStatus: TurnStatusDraft,
    now: number,
    force: boolean
  ): Promise<void> {
    if (nextStatus.state !== "thinking") {
      context.reasoningSummary = null;
      context.reasoningFallback = null;
    } else if (!nextStatus.quotedDetails && context.reasoningSummary?.text) {
      nextStatus = {
        ...nextStatus,
        quotedDetails: context.reasoningSummary.text
      };
    } else if (!nextStatus.quotedDetails && context.reasoningFallback?.preview) {
      nextStatus = {
        ...nextStatus,
        quotedDetails: context.reasoningFallback.preview
      };
    }

    if (isSameStatusDraft(context.statusDraft, nextStatus)) {
      return;
    }

    if (!force && context.statusDraft?.state === nextStatus.state && now - context.lastStatusUpdateAt < 500) {
      return;
    }

    context.statusDraft = nextStatus;
    context.lastStatusUpdateAt = now;
    await context.statusHandle.set(
      renderTelegramStatusDraft(nextStatus, Date.now() - context.startedAtMs),
      force
    );
  }

  private async publishCompletedPlan(context: TurnContext, plan: { itemId: string; text: string }): Promise<number> {
    const messageId = await this.sendMiniAppPlanMessage(context, plan.text);

    context.publishedPlanMessages += 1;
    return messageId;
  }

  private async sendMiniAppPlanMessage(context: TurnContext, markdownText: string): Promise<number> {
    try {
      return await this.deps.messenger.sendMessage({
        chatId: context.chatId,
        topicId: context.topicId,
        ...buildPlanArtifactMessage(this.deps.planArtifactPublicUrl!, markdownText)
      }).then((message) => message.messageId);
    } catch (error) {
      if (error instanceof Error && error.message === "mini_app_artifact_too_large") {
        return this.deps.messenger.sendMessage({
          chatId: context.chatId,
          topicId: context.topicId,
          ...buildOversizePlanArtifactMessage()
        }).then((message) => message.messageId);
      }

      throw error;
    }
  }
}

function deriveRawReasoningPreview(buffer: string): string | null {
  const boldPreview = extractFirstBoldMarkdown(buffer);
  if (boldPreview) {
    return truncateReasoningPreview(boldPreview);
  }

  const normalized = normalizeReasoningPreview(buffer);
  if (!normalized) {
    return null;
  }

  const sentenceMatch = normalized.match(/^(.{1,140}?[.!?])(?:\s|$)/);
  if (sentenceMatch?.[1]) {
    return truncateReasoningPreview(sentenceMatch[1]);
  }

  return truncateReasoningPreview(normalized);
}

function extractFirstBoldMarkdown(text: string): string | null {
  const match = /\*\*([^*]+)\*\*/.exec(text);
  return match?.[1] ? normalizeReasoningPreview(match[1]) : null;
}

function normalizeReasoningPreview(text: string): string | null {
  const normalized = text.replace(/\*\*/g, "").replace(/`/g, "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function truncateReasoningPreview(text: string): string {
  return text.length > RAW_REASONING_PREVIEW_LIMIT ? `${text.slice(0, RAW_REASONING_PREVIEW_LIMIT - 3)}...` : text;
}
