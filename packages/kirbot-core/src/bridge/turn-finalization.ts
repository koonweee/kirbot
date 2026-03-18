import type { UserTurnMessage } from "../domain";
import {
  buildRenderedAssistantMessages,
  buildCommentaryArtifactReplyMarkup,
  buildCommentaryArtifactStubMessage,
  buildRenderedPlanMessages,
  buildOversizeCommentaryArtifactMessage,
  buildRenderedCompletionFooter,
  type CompletionFooterDetails
} from "./presentation";
import type { InlineKeyboardMarkup, TelegramApi, TelegramMessenger, TelegramRenderedMessage } from "../telegram-messenger";
import { BridgeTurnRuntime, type QueueStateSnapshot } from "../turn-runtime";
import {
  type TerminalTurnStatus,
  type TurnContext,
  isTerminalTurnPhase,
  transitionTurnPhase
} from "./turn-context";

export type ResolvedTurnSnapshot = {
  text: string;
  assistantText: string;
  planText: string;
  changedFiles: number;
  cwd: string | null;
  branch: string | null;
};

export type TurnLifecycleDependencies = {
  runtime: BridgeTurnRuntime;
  messenger: TelegramMessenger;
  telegram: TelegramApi;
  planArtifactPublicUrl: string;
  releaseTurnFiles(turnId: string): Promise<void>;
  appendTurnStream(turnId: string, streamText: string): Promise<void>;
  completePersistedTurn(
    turnId: string,
    messageId: number | null,
    status: TerminalTurnStatus,
    resolvedAssistantText?: string
  ): Promise<void>;
  resolveTurnSnapshot(threadId: string, turnId: string): Promise<ResolvedTurnSnapshot>;
  syncQueuePreview(queueState: QueueStateSnapshot): Promise<void>;
  maybeSendNextQueuedFollowUp(chatId: number, topicId: number): Promise<void>;
  submitQueuedFollowUp(chatId: number, topicId: number, message: UserTurnMessage): Promise<void>;
};

type TurnFinalizerCallbacks = {
  publishCompletedPlan(context: TurnContext, plan: { itemId: string; text: string }): Promise<number>;
};

export type FinalizationPolicy = {
  terminalStatus: TerminalTurnStatus;
  threadId: string;
  publishWhenEmpty: boolean;
  scheduleNextQueuedFollowUp: boolean;
  submitPendingSteers: boolean;
  movePendingSteersToQueued: boolean;
  publishFooter: boolean;
  buildFinalText(resolvedText: string): string;
};

type CommentaryPublication =
  | { kind: "hidden" }
  | { kind: "attach_to_assistant"; replyMarkup: InlineKeyboardMarkup }
  | { kind: "standalone_stub"; text: string; replyMarkup: InlineKeyboardMarkup }
  | { kind: "oversize_stub"; text: string };

export class TurnFinalizer {
  constructor(
    private readonly deps: TurnLifecycleDependencies,
    private readonly callbacks: TurnFinalizerCallbacks
  ) {}

  async finalizeTurn(
    turns: Map<string, TurnContext>,
    turnId: string,
    policy: FinalizationPolicy
  ): Promise<void> {
    const context = turns.get(turnId);
    if (!context || context.phase === "finalizing" || isTerminalTurnPhase(context.phase)) {
      return;
    }

    const pendingSteers = policy.submitPendingSteers
      ? this.deps.runtime.drainPendingSteers(context.chatId, context.topicId)
      : null;
    if (policy.movePendingSteersToQueued) {
      await this.deps.syncQueuePreview(this.deps.runtime.movePendingSteersToQueued(context.chatId, context.topicId));
    }

    await this.beginFinalization(context);
    const commentaryItems = this.deps.runtime.renderCommentaryItems(context.turnId);
    const snapshot = await this.deps.resolveTurnSnapshot(policy.threadId, context.turnId);
    const hasAssistantText = snapshot.assistantText.trim().length > 0;
    const commentaryPublication = this.buildCommentaryPublication(commentaryItems, hasAssistantText);
    await this.publishStandaloneCommentary(context, commentaryPublication);
    const publishedPlanMessageId =
      snapshot.planText.trim().length > 0 && context.publishedPlanMessages === 0
        ? await this.callbacks.publishCompletedPlan(context, {
            itemId: this.deps.runtime.getLatestPlanItemId(context.turnId) ?? "plan-final",
            text: snapshot.planText
          })
        : null;
    const finalText = policy.buildFinalText(snapshot.text);
    const messageId =
      policy.terminalStatus === "completed" && !hasAssistantText && snapshot.planText.trim().length > 0
        ? publishedPlanMessageId
        : finalText.trim().length > 0 || policy.publishWhenEmpty
          ? await this.publishFinalTurnText(
              context,
              finalText,
              hasAssistantText ? "assistant" : "plan",
              commentaryPublication.kind === "attach_to_assistant" ? commentaryPublication.replyMarkup : undefined
            )
          : null;

    if (policy.publishFooter) {
      await this.publishCompletionFooter(context, snapshot);
    }

    await this.deps.appendTurnStream(context.turnId, finalText);
    await this.deps.completePersistedTurn(context.turnId, messageId, policy.terminalStatus, snapshot.assistantText);
    await this.deps.releaseTurnFiles(context.turnId);

    const queueState = this.deps.runtime.finalizeTurn(context.turnId);
    turns.delete(context.turnId);
    transitionTurnPhase(context, policy.terminalStatus);

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

    transitionTurnPhase(context, "finalizing");
    if (context.statusElapsedTimer) {
      clearInterval(context.statusElapsedTimer);
      context.statusElapsedTimer = null;
    }
    context.statusDraft = null;
    await context.statusHandle.clear();

    for (const [itemId, plan] of context.planStreams) {
      if (plan.text.trim().length > 0) {
        await plan.handle.clear();
        await this.callbacks.publishCompletedPlan(context, {
          itemId,
          text: plan.text
        });
      } else {
        await plan.handle.clear();
      }
      context.planStreams.delete(itemId);
    }
  }

  private async publishFinalTurnText(
    context: TurnContext,
    text: string,
    kind: "assistant" | "plan",
    replyMarkup?: InlineKeyboardMarkup
  ): Promise<number> {
    const outputs = kind === "assistant" ? buildRenderedAssistantMessages(text) : buildRenderedPlanMessages(text);
    if (kind === "assistant") {
      const messageId = await context.finalStream.finalize(outputs, {
        ...(replyMarkup ? { firstMessageReplyMarkup: replyMarkup } : {})
      });
      if (messageId !== null) {
        return messageId;
      }
    }

    return this.sendRenderedMessages(context.chatId, context.topicId, outputs);
  }

  private buildCommentaryPublication(items: string[], hasAssistantText: boolean): CommentaryPublication {
    if (items.length === 0) {
      return { kind: "hidden" };
    }

    try {
      const replyMarkup = buildCommentaryArtifactReplyMarkup(this.deps.planArtifactPublicUrl, items);
      if (hasAssistantText) {
        return {
          kind: "attach_to_assistant",
          replyMarkup
        };
      }

      return {
        kind: "standalone_stub",
        ...buildCommentaryArtifactStubMessage(replyMarkup)
      };
    } catch (error) {
      if (error instanceof Error && error.message === "mini_app_artifact_too_large") {
        return {
          kind: "oversize_stub",
          ...buildOversizeCommentaryArtifactMessage()
        };
      }

      throw error;
    }
  }

  private async publishStandaloneCommentary(context: TurnContext, publication: CommentaryPublication): Promise<void> {
    if (publication.kind === "hidden" || publication.kind === "attach_to_assistant") {
      return;
    }

    if (publication.kind === "standalone_stub") {
      await this.deps.messenger.sendMessage({
        chatId: context.chatId,
        topicId: context.topicId,
        text: publication.text,
        replyMarkup: publication.replyMarkup
      });
      return;
    }

    await this.deps.messenger.sendMessage({
      chatId: context.chatId,
      topicId: context.topicId,
      text: publication.text
    });
  }

  private async publishCompletionFooter(context: TurnContext, snapshot: ResolvedTurnSnapshot): Promise<void> {
    const rendered = buildRenderedCompletionFooter(this.buildCompletionFooterDetails(context, snapshot));
    await this.deps.messenger.sendMessage({
      chatId: context.chatId,
      topicId: context.topicId,
      text: rendered.text,
      ...(rendered.entities ? { entities: rendered.entities } : {})
    });
  }

  private buildCompletionFooterDetails(context: TurnContext, snapshot: ResolvedTurnSnapshot): CompletionFooterDetails {
    const contextLeftPercent = computeContextLeftPercent(context.tokenUsage);
    return {
      model: context.model,
      reasoningEffort: context.reasoningEffort,
      durationMs: Math.max(0, Date.now() - context.startedAtMs),
      changedFiles: snapshot.changedFiles,
      contextLeftPercent,
      cwd: snapshot.cwd,
      branch: snapshot.branch
    };
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
        ...(rendered.entities ? { entities: rendered.entities } : {})
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
}

const CODEX_CLI_CONTEXT_LEFT_BASELINE_TOKENS = 12_000;

function computeContextLeftPercent(tokenUsage: TurnContext["tokenUsage"]): number | null {
  if (!tokenUsage?.modelContextWindow || tokenUsage.modelContextWindow <= 0) {
    return null;
  }

  // Match codex-cli's baseline-adjusted remaining-context calculation:
  // codex-rs/protocol/src/protocol.rs `percent_of_context_window_remaining`.
  if (tokenUsage.modelContextWindow <= CODEX_CLI_CONTEXT_LEFT_BASELINE_TOKENS) {
    return 0;
  }

  const effectiveWindow = tokenUsage.modelContextWindow - CODEX_CLI_CONTEXT_LEFT_BASELINE_TOKENS;
  const used = Math.max(0, tokenUsage.last.totalTokens - CODEX_CLI_CONTEXT_LEFT_BASELINE_TOKENS);
  const remaining = Math.max(0, effectiveWindow - used);
  return Math.min(100, Math.max(0, Math.round((remaining / effectiveWindow) * 100)));
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error);
}
