import type { UserTurnMessage } from "../domain";
import {
  buildRenderedAssistantMessages,
  buildRenderedCommentaryMessage
} from "./presentation";
import type { TelegramApi, TelegramMessenger, TelegramRenderedMessage } from "../telegram-messenger";
import { BridgeTurnRuntime, type QueueStateSnapshot } from "../turn-runtime";
import {
  type TerminalTurnStatus,
  type TurnContext,
  isTerminalTurnPhase,
  transitionTurnPhase
} from "./turn-context";

export type TurnLifecycleDependencies = {
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

export type FinalizationPolicy = {
  terminalStatus: TerminalTurnStatus;
  threadId: string;
  publishWhenEmpty: boolean;
  scheduleNextQueuedFollowUp: boolean;
  submitPendingSteers: boolean;
  movePendingSteersToQueued: boolean;
  buildFinalText(resolvedText: string): string;
};

export class TurnFinalizer {
  constructor(private readonly deps: TurnLifecycleDependencies) {}

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
