import type { UserTurnMessage } from "../domain";
import type { ThreadItem } from "../generated/codex/v2/ThreadItem";
import {
  buildRenderedAssistantMessages,
  buildRenderedCommentaryMessage,
  buildStableDraftId,
  buildStatusDraft,
  buildStatusDraftForItem,
  buildTurnControlKeyboard,
  isSameStatusDraft,
  renderTelegramAssistantDraft,
  renderTelegramCommentaryDraft,
  renderTelegramStatusDraft,
  renderTurnControlMessage,
  type TurnStatusDraft
} from "./presentation";
import {
  TelegramMessenger,
  type InlineKeyboardMarkup,
  type TelegramApi,
  type TelegramRenderedMessage,
  type TelegramStatusDraftHandle,
  type TelegramStreamMessageHandle
} from "../telegram-messenger";
import { BridgeTurnRuntime, type AssistantRenderUpdate, type QueueStateSnapshot } from "../turn-runtime";

export type TurnPhase = "submitting" | "active" | "finalizing" | "completed" | "failed" | "interrupted";
export type TerminalTurnStatus = Extract<TurnPhase, "completed" | "failed" | "interrupted">;

type CommentaryStreamState = {
  handle: TelegramStreamMessageHandle;
  text: string;
};

export type TurnContext = {
  chatId: number;
  topicId: number;
  threadId: string;
  turnId: string;
  phase: TurnPhase;
  stopControlMessageId: number | null;
  stopRequested: boolean;
  submitPendingSteersAfterInterrupt: boolean;
  statusDraft: TurnStatusDraft | null;
  lastStatusUpdateAt: number;
  statusHandle: TelegramStatusDraftHandle;
  finalStream: TelegramStreamMessageHandle;
  commentaryStreams: Map<string, CommentaryStreamState>;
};

type TurnLifecycleDependencies = {
  runtime: BridgeTurnRuntime;
  messenger: TelegramMessenger;
  telegram: TelegramApi;
  releaseTurnFiles(turnId: string): Promise<void>;
  appendTurnStream(turnId: string, streamText: string): Promise<void>;
  completePersistedTurn(turnId: string, messageId: number | null, status: TerminalTurnStatus): Promise<void>;
  resolveTurnText(threadId: string, turnId: string): Promise<string>;
  syncQueuePreview(queueState: QueueStateSnapshot): Promise<void>;
  maybeSendNextQueuedFollowUp(chatId: number, topicId: number): Promise<void>;
  submitQueuedFollowUp(chatId: number, topicId: number, message: UserTurnMessage): Promise<void>;
};

type FinalizationPolicy = {
  terminalStatus: TerminalTurnStatus;
  threadId: string;
  publishWhenEmpty: boolean;
  scheduleNextQueuedFollowUp: boolean;
  submitPendingSteers: boolean;
  movePendingSteersToQueued: boolean;
  buildFinalText(resolvedText: string): string;
};

export class TurnLifecycleCoordinator {
  readonly #turns = new Map<string, TurnContext>();

  constructor(private readonly deps: TurnLifecycleDependencies) {}

  activateTurn(message: UserTurnMessage, threadId: string, turnId: string): TurnContext {
    if (message.topicId === null) {
      throw new Error("Cannot create an active turn without a Telegram topic id");
    }

    const context: TurnContext = {
      chatId: message.chatId,
      topicId: message.topicId,
      threadId,
      turnId,
      phase: "submitting",
      stopControlMessageId: null,
      stopRequested: false,
      submitPendingSteersAfterInterrupt: false,
      statusDraft: buildStatusDraft("thinking"),
      lastStatusUpdateAt: Date.now(),
      statusHandle: this.deps.messenger.statusDraft({
        chatId: message.chatId,
        topicId: message.topicId,
        draftId: buildStableDraftId(`${turnId}:status`)
      }),
      finalStream: this.deps.messenger.streamMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        draftId: buildStableDraftId(`${turnId}:final`)
      }),
      commentaryStreams: new Map()
    };

    this.transitionPhase(context, "active");
    this.#turns.set(turnId, context);
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

  async sendTurnControlMessage(turnId: string, replyToMessageId: number): Promise<void> {
    const context = this.#turns.get(turnId);
    if (!context) {
      return;
    }

    try {
      const message = await this.deps.messenger.sendMessage({
        chatId: context.chatId,
        topicId: context.topicId,
        text: renderTurnControlMessage("active"),
        replyToMessageId,
        replyMarkup: buildTurnControlKeyboard(context.turnId)
      });
      context.stopControlMessageId = message.messageId;
    } catch (error) {
      console.warn("Failed to send turn control message", error);
    }
  }

  async updateTurnControlMessage(
    turnId: string,
    text: string,
    replyMarkup?: InlineKeyboardMarkup
  ): Promise<void> {
    const context = this.#turns.get(turnId);
    if (!context || context.stopControlMessageId === null) {
      return;
    }

    try {
      const options = replyMarkup
        ? {
            message_thread_id: context.topicId,
            reply_markup: replyMarkup
          }
        : {
            message_thread_id: context.topicId
          };
      await this.deps.telegram.editMessageText(context.chatId, context.stopControlMessageId, text, options);
    } catch (error) {
      if (isTelegramMessageMissingError(error)) {
        context.stopControlMessageId = null;
        return;
      }
      console.warn("Failed to update turn control message", error);
    }
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
    await context.statusHandle.set(renderTelegramStatusDraft(nextStatus), options?.force ?? false);
  }

  async publishCurrentStatus(turnId: string, force = true): Promise<void> {
    const context = this.#turns.get(turnId);
    if (!context?.statusDraft) {
      return;
    }

    await context.statusHandle.set(renderTelegramStatusDraft(context.statusDraft), force);
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
    await this.updateStatus(turnId, buildStatusDraft("using tool"));
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
    await this.finalizeTurn(turnId, {
      terminalStatus: "completed",
      threadId,
      publishWhenEmpty: true,
      scheduleNextQueuedFollowUp: true,
      submitPendingSteers: false,
      movePendingSteersToQueued: false,
      buildFinalText: (resolvedText) => resolvedText || "(no assistant output)"
    });
  }

  async failTurn(threadId: string, turnId: string, errorMessage: string): Promise<void> {
    await this.finalizeTurn(turnId, {
      terminalStatus: "failed",
      threadId,
      publishWhenEmpty: true,
      scheduleNextQueuedFollowUp: true,
      submitPendingSteers: false,
      movePendingSteersToQueued: false,
      buildFinalText: (resolvedText) => [resolvedText, `\n\nCodex error: ${errorMessage}`].filter(Boolean).join("")
    });
  }

  async finalizeInterruptedTurnById(threadId: string, turnId: string): Promise<void> {
    const context = this.#turns.get(turnId);
    if (!context) {
      return;
    }

    await this.finalizeTurn(turnId, {
      terminalStatus: "interrupted",
      threadId,
      publishWhenEmpty: false,
      scheduleNextQueuedFollowUp: false,
      submitPendingSteers: context.submitPendingSteersAfterInterrupt,
      movePendingSteersToQueued: !context.submitPendingSteersAfterInterrupt,
      buildFinalText: (resolvedText) => resolvedText
    });
  }

  private async finalizeTurn(turnId: string, policy: FinalizationPolicy): Promise<void> {
    const context = this.#turns.get(turnId);
    if (!context || context.phase === "finalizing" || isTerminalPhase(context.phase)) {
      return;
    }

    const pendingSteers = policy.submitPendingSteers
      ? this.deps.runtime.drainPendingSteers(context.chatId, context.topicId)
      : null;
    if (policy.movePendingSteersToQueued) {
      await this.deps.syncQueuePreview(this.deps.runtime.movePendingSteersToQueued(context.chatId, context.topicId));
    }

    await this.beginFinalization(context);
    const resolvedText = await this.deps.resolveTurnText(policy.threadId, context.turnId);
    const finalText = policy.buildFinalText(resolvedText);
    const messageId =
      finalText.trim().length > 0 || policy.publishWhenEmpty
        ? await this.publishFinalTurnText(context, finalText)
        : null;

    await this.deps.appendTurnStream(context.turnId, finalText);
    await this.deps.completePersistedTurn(context.turnId, messageId, policy.terminalStatus);
    await this.deps.releaseTurnFiles(context.turnId);

    const queueState = this.deps.runtime.finalizeTurn(context.turnId);
    this.#turns.delete(context.turnId);
    this.transitionPhase(context, policy.terminalStatus);

    if (!queueState) {
      return;
    }

    await this.deps.syncQueuePreview(queueState);
    if (policy.scheduleNextQueuedFollowUp) {
      await this.deps.maybeSendNextQueuedFollowUp(queueState.chatId, queueState.topicId);
    }

    if (!policy.submitPendingSteers || !pendingSteers?.mergedMessage) {
      return;
    }

    try {
      await this.deps.submitQueuedFollowUp(context.chatId, context.topicId, pendingSteers.mergedMessage);
      await this.deps.syncQueuePreview(this.deps.runtime.getQueueState(context.chatId, context.topicId));
    } catch (error) {
      const restoredQueue = this.deps.runtime.prependQueuedFollowUp(
        context.chatId,
        context.topicId,
        pendingSteers.mergedMessage
      );
      await this.deps.syncQueuePreview(restoredQueue);
      await this.deps.messenger.sendMessage({
        chatId: context.chatId,
        topicId: context.topicId,
        text: `Interrupted the current turn, but failed to submit queued steer instructions: ${formatError(error)}`
      });
    }
  }

  private async beginFinalization(context: TurnContext): Promise<void> {
    if (context.phase === "finalizing") {
      return;
    }

    this.transitionPhase(context, "finalizing");
    await this.clearTurnControlMessage(context);
    await context.statusHandle.clear();

    for (const [itemId, commentary] of context.commentaryStreams) {
      if (commentary.text.trim().length > 0) {
        await commentary.handle.finalize(buildRenderedCommentaryMessage(commentary.text));
      } else {
        await commentary.handle.clear();
      }
      context.commentaryStreams.delete(itemId);
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

  private getOrCreateCommentaryStream(context: TurnContext, itemId: string): CommentaryStreamState {
    const existing = context.commentaryStreams.get(itemId);
    if (existing) {
      return existing;
    }

    const created: CommentaryStreamState = {
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

  private async publishFinalTurnText(context: TurnContext, text: string): Promise<number> {
    const outputs = buildRenderedAssistantMessages(text);
    if (this.deps.runtime.getTurn(context.turnId)?.hasAssistantText) {
      const messageId = await context.finalStream.finalize(outputs);
      if (messageId !== null) {
        return messageId;
      }
    }

    return this.sendRenderedMessages(context.chatId, context.topicId, outputs);
  }

  private async sendRenderedMessages(
    chatId: number,
    topicId: number,
    renderedMessages: TelegramRenderedMessage[]
  ): Promise<number> {
    let firstMessageId: number | null = null;

    for (const rendered of renderedMessages) {
      const message = await this.deps.messenger.sendMessage({
        chatId,
        topicId,
        text: rendered.text,
        ...(rendered.parseMode ? { parseMode: rendered.parseMode } : {})
      });
      if (firstMessageId === null) {
        firstMessageId = message.messageId;
      }
    }

    if (firstMessageId === null) {
      throw new Error("Failed to publish Telegram message chunks");
    }

    return firstMessageId;
  }

  private async clearTurnControlMessage(context: TurnContext): Promise<void> {
    if (context.stopControlMessageId === null) {
      return;
    }

    try {
      await this.deps.telegram.deleteMessage(context.chatId, context.stopControlMessageId);
    } catch (error) {
      if (!isTelegramMessageMissingError(error)) {
        console.warn("Failed to delete turn control message", error);
      }
    } finally {
      context.stopControlMessageId = null;
    }
  }

  private transitionPhase(context: TurnContext, nextPhase: TurnPhase): void {
    if (!isAllowedTransition(context.phase, nextPhase)) {
      throw new Error(`Illegal turn phase transition: ${context.phase} -> ${nextPhase}`);
    }

    context.phase = nextPhase;
  }
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

function isTerminalPhase(phase: TurnPhase): phase is TerminalTurnStatus {
  return phase === "completed" || phase === "failed" || phase === "interrupted";
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error);
}

function isTelegramMessageMissingError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeTelegramError = error as { error_code?: unknown; description?: unknown };
  return (
    maybeTelegramError.error_code === 400 &&
    typeof maybeTelegramError.description === "string" &&
    (maybeTelegramError.description.toLowerCase().includes("message to edit not found") ||
      maybeTelegramError.description.toLowerCase().includes("message to delete not found") ||
      maybeTelegramError.description.toLowerCase().includes("not found"))
  );
}
