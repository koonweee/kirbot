import type { ResolvedTurnSnapshot } from "@kirbot/codex-client";
import type { UserTurnMessage } from "../domain";
import {
  buildArtifactReplyMarkup,
  buildCommentaryArtifactPublication,
  buildOversizeResponseArtifactMessage,
  buildRenderedAssistantMessage,
  buildResponseArtifactPublication,
  buildOversizeCommentaryArtifactMessage,
  buildRenderedCompletionFooter,
  type ArtifactPublication,
  type CompletionFooterDetails
} from "./presentation";
import type {
  TelegramApi,
  TelegramMessenger
} from "../telegram-messenger";
import { BridgeTurnRuntime, type QueueStateSnapshot } from "../turn-runtime";
import {
  type TerminalTurnStatus,
  type TurnContext,
  isTerminalTurnPhase,
  transitionTurnPhase
} from "./turn-context";
import { formatError } from "./error-handling";

export type TurnLifecycleDependencies = {
  runtime: BridgeTurnRuntime;
  messenger: TelegramMessenger;
  telegram: TelegramApi;
  planArtifactPublicUrl: string;
  releaseTurnFiles(turnId: string): Promise<void>;
  resolveTurnSnapshot(threadId: string, turnId: string): Promise<ResolvedTurnSnapshot>;
  syncQueuePreview(queueState: QueueStateSnapshot): Promise<void>;
  maybeSendNextQueuedFollowUp(chatId: number, topicId: number | null): Promise<void>;
  submitQueuedFollowUp(chatId: number, topicId: number | null, message: UserTurnMessage): Promise<void>;
};

type TurnFinalizerCallbacks = {
  publishCompletedPlan(context: TurnContext, plan: { itemId: string; text: string }): Promise<number>;
};

type PlannedArtifactPublication = ArtifactPublication & {
  oversizeNoticeText: string | null;
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
    const activityLogEntries = this.deps.runtime.renderActivityLogEntries(context.turnId);
    const snapshot = await this.deps.resolveTurnSnapshot(policy.threadId, context.turnId);
    const hasAssistantText = snapshot.assistantText.trim().length > 0;
    const publishesPlanOnly = policy.terminalStatus === "completed" && !hasAssistantText && snapshot.planText.trim().length > 0;
    const commentaryPublication = this.buildCommentaryPublication(activityLogEntries, !publishesPlanOnly);
    await this.publishStandaloneCommentary(context, commentaryPublication);
    if (snapshot.planText.trim().length > 0 && context.publishedPlanMessages === 0) {
      await this.callbacks.publishCompletedPlan(context, {
        itemId: this.deps.runtime.getLatestPlanItemId(context.turnId) ?? "plan-final",
        text: snapshot.planText
      });
    }
    const finalText = policy.buildFinalText(snapshot.text);
    const responsePublication = publishesPlanOnly ? null : this.buildResponsePublication(finalText);
    const publishedFinalAssistantMessage =
      !publishesPlanOnly && (finalText.trim().length > 0 || policy.publishWhenEmpty);
    if (!publishesPlanOnly && publishedFinalAssistantMessage) {
      await this.publishFinalTurnText(context, finalText, commentaryPublication, responsePublication);
    }

    if (responsePublication?.oversizeNoticeText) {
      await this.publishArtifactOversizeNotice(context, responsePublication.oversizeNoticeText);
    }

    if (policy.publishFooter) {
      await this.publishCompletionFooter(context, snapshot);
    }

    if (!publishedFinalAssistantMessage) {
      await context.draftHandle.clear();
    }

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
  }

  private async publishFinalTurnText(
    context: TurnContext,
    text: string,
    commentaryPublication: PlannedArtifactPublication,
    responsePublication: PlannedArtifactPublication | null
  ): Promise<number> {
    const attachment = this.resolveAssistantAttachment(responsePublication, commentaryPublication);

    const messageId = await context.draftHandle.finalize(
      buildRenderedAssistantMessage(text, {
        includeContinueInViewNote: attachment.includeContinueInViewNote
      }),
      {
        ...(attachment.replyMarkup ? { firstMessageReplyMarkup: attachment.replyMarkup } : {}),
        disableNotification: false
      }
    );
    if (messageId === null) {
      throw new Error("Failed to publish final assistant message");
    }

    await this.publishStandaloneAgentMessages(context, attachment.deferredMessages);

    return messageId;
  }

  private buildCommentaryPublication(
    activityLogEntries: ReturnType<TurnLifecycleDependencies["runtime"]["renderActivityLogEntries"]>,
    attachToAssistant: boolean
  ): PlannedArtifactPublication {
    try {
      const publication = buildCommentaryArtifactPublication(this.deps.planArtifactPublicUrl, activityLogEntries, {
        attachToAssistant
      });
      return {
        ...publication,
        oversizeNoticeText: null
      };
    } catch (error) {
      if (error instanceof Error && error.message === "mini_app_artifact_too_large") {
        return {
          attachedButton: null,
          standaloneMessages: [],
          oversizeNoticeText: buildOversizeCommentaryArtifactMessage().text
        };
      }

      throw error;
    }
  }

  private buildResponsePublication(text: string): PlannedArtifactPublication {
    try {
      const publication = buildResponseArtifactPublication(this.deps.planArtifactPublicUrl, text);
      return {
        ...publication,
        oversizeNoticeText: null
      };
    } catch (error) {
      if (error instanceof Error && error.message === "mini_app_artifact_too_large") {
        return {
          attachedButton: null,
          standaloneMessages: [],
          oversizeNoticeText: buildOversizeResponseArtifactMessage().text
        };
      }

      throw error;
    }
  }

  private async publishStandaloneCommentary(context: TurnContext, publication: PlannedArtifactPublication): Promise<void> {
    await this.publishStandaloneAgentMessages(context, publication.standaloneMessages, {
      notifyFirstMessage: true
    });

    if (publication.oversizeNoticeText) {
      await this.publishArtifactOversizeNotice(context, publication.oversizeNoticeText);
    }
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
      mode: context.mode,
      model: context.model,
      reasoningEffort: context.reasoningEffort,
      serviceTier: context.serviceTier,
      durationMs: Math.max(0, Date.now() - context.startedAtMs),
      changedFiles: Math.max(snapshot.changedFiles, context.changedFilePaths.size),
      contextLeftPercent,
      cwd: snapshot.cwd,
      branch: snapshot.branch
    };
  }

  private async publishArtifactOversizeNotice(context: TurnContext, text: string): Promise<void> {
    await this.deps.messenger.sendMessage({
      chatId: context.chatId,
      topicId: context.topicId,
      text
    });
  }

  private async publishStandaloneAgentMessages(
    context: TurnContext,
    messages: ArtifactPublication["standaloneMessages"],
    options?: { notifyFirstMessage?: boolean }
  ): Promise<void> {
    for (const [index, message] of messages.entries()) {
      await this.deps.messenger.sendMessage({
        chatId: context.chatId,
        topicId: context.topicId,
        text: message.text,
        replyMarkup: message.replyMarkup,
        disableNotification: options?.notifyFirstMessage && index === 0 ? false : true
      });
    }
  }

  private resolveAssistantAttachment(
    responsePublication: PlannedArtifactPublication | null,
    commentaryPublication: PlannedArtifactPublication
  ): {
    replyMarkup?: ReturnType<typeof buildArtifactReplyMarkup>;
    deferredMessages: ArtifactPublication["standaloneMessages"];
    includeContinueInViewNote: boolean;
  } {
    const responseButton = responsePublication?.attachedButton ?? null;
    const commentaryButton = commentaryPublication.attachedButton;

    if (responseButton && commentaryButton) {
      try {
        return {
          replyMarkup: buildArtifactReplyMarkup([responseButton, commentaryButton]),
          deferredMessages: [],
          includeContinueInViewNote: true
        };
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "mini_app_artifact_too_large") {
          throw error;
        }

        return {
          replyMarkup: buildArtifactReplyMarkup([responseButton]),
          deferredMessages:
            commentaryPublication.standaloneMessages.length > 0
              ? commentaryPublication.standaloneMessages
              : [
                  {
                    text: "Commentary is available",
                    replyMarkup: buildArtifactReplyMarkup([commentaryButton])
                  }
                ],
          includeContinueInViewNote: true
        };
      }
    }

    if (responseButton) {
      return {
        replyMarkup: buildArtifactReplyMarkup([responseButton]),
        deferredMessages: [],
        includeContinueInViewNote: true
      };
    }

    if (commentaryButton) {
      return {
        replyMarkup: buildArtifactReplyMarkup([commentaryButton]),
        deferredMessages: [],
        includeContinueInViewNote: false
      };
    }

    return {
      deferredMessages: [],
      includeContinueInViewNote: false
    };
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
