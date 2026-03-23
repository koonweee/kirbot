import type { UserTurnInput, UserTurnMessage } from "./domain";
import { buildUserInputSignature } from "./bridge/input-signature";
import type { MessagePhase } from "@kirbot/codex-client/generated/codex/MessagePhase";
import type { UserInput } from "@kirbot/codex-client/generated/codex/v2/UserInput";
import type { ThreadItem } from "@kirbot/codex-client/generated/codex/v2/ThreadItem";

type AssistantItemState = {
  text: string;
  phase: MessagePhase | null;
};

type PlanItemState = {
  text: string;
};

export type GeneratedImagePublicationFailureStage =
  | "invalid_url"
  | "download"
  | "validation"
  | "telegram_send";

export type GeneratedImagePublicationFailureLogInput = {
  turnId: string;
  itemId: string;
  url: string;
  stage: GeneratedImagePublicationFailureStage;
};

export type ActivityLogEntry =
  | {
      kind: "commentary";
      text: string;
    }
  | {
      kind: "structuredFailure";
      title: string;
      subject:
        | {
            value: string;
            style: "codeBlock" | "inlineCode" | "text";
          }
        | null;
      metadata: Array<{
        label: string;
        value: string;
        code: boolean;
      }>;
      detail:
        | {
            title: string;
            value: string;
            style: "codeBlock" | "quoteBlock" | "text";
          }
        | null;
    }
  | {
      kind: "activity";
      label: ActivityLogLabel;
      detail: string | null;
      detailStyle: "codeBlock" | "inlineCode" | "text";
    };

export type ActivityLogLabel =
  | "Web Search"
  | "Command"
  | "Tool"
  | "Agent Task"
  | "File Edit";

export type RuntimeTurn = {
  chatId: number;
  topicId: number | null;
  threadId: string;
  turnId: string;
  assistantItemOrder: string[];
  assistantItems: Map<string, AssistantItemState>;
  planItemOrder: string[];
  planItems: Map<string, PlanItemState>;
  activityLogEntries: ActivityLogEntry[];
  commentaryActivityEntryIndexes: Map<string, number>;
};

type PendingSteer = {
  localId: string;
  turnId: string;
  message: UserTurnMessage;
};

type TopicState = {
  activeTurnId: string | null;
  pendingSteers: PendingSteer[];
  queuedFollowUps: UserTurnMessage[];
};

export type QueueStateSnapshot = {
  chatId: number;
  topicId: number | null;
  pendingSteers: string[];
  queuedFollowUps: Array<{
    actorLabel: string;
    text: string;
  }>;
};

export type PendingSteerDrain = {
  mergedMessage: UserTurnMessage | null;
  queueState: QueueStateSnapshot;
};

export class BridgeTurnRuntime {
  readonly #turns = new Map<string, RuntimeTurn>();
  readonly #topicStates = new Map<string, TopicState>();
  #nextPendingSteerId = 1;

  registerTurn(input: {
    chatId: number;
    topicId: number | null;
    threadId: string;
    turnId: string;
  }): RuntimeTurn {
    const turn: RuntimeTurn = {
      chatId: input.chatId,
      topicId: input.topicId,
      threadId: input.threadId,
      turnId: input.turnId,
      assistantItemOrder: [],
      assistantItems: new Map<string, AssistantItemState>(),
      planItemOrder: [],
      planItems: new Map<string, PlanItemState>(),
      activityLogEntries: [],
      commentaryActivityEntryIndexes: new Map<string, number>()
    };

    this.#turns.set(input.turnId, turn);
    this.ensureTopicState(input.chatId, input.topicId).activeTurnId = input.turnId;
    return turn;
  }

  getTurn(turnId: string): RuntimeTurn | undefined {
    return this.#turns.get(turnId);
  }

  getActiveTurnByTopic(chatId: number, topicId: number | null): RuntimeTurn | undefined {
    const activeTurnId = this.#topicStates.get(topicKey(chatId, topicId))?.activeTurnId;
    return activeTurnId ? this.#turns.get(activeTurnId) : undefined;
  }

  queuePendingSteer(activeTurn: RuntimeTurn, message: UserTurnMessage): { localId: string; queueState: QueueStateSnapshot } {
    const topicState = this.ensureTopicState(activeTurn.chatId, activeTurn.topicId);
    const localId = `pending-steer-${this.#nextPendingSteerId++}`;
    topicState.pendingSteers.push({
      localId,
      turnId: activeTurn.turnId,
      message
    });
    return {
      localId,
      queueState: this.getQueueState(activeTurn.chatId, activeTurn.topicId)
    };
  }

  movePendingSteerToQueued(chatId: number, topicId: number | null, localId: string): QueueStateSnapshot {
    const pending = this.removePendingSteer(chatId, topicId, localId);
    if (pending) {
      this.ensureTopicState(chatId, topicId).queuedFollowUps.push(cloneUserTurnMessage(pending.message));
    }
    return this.getQueueState(chatId, topicId);
  }

  dropPendingSteer(chatId: number, topicId: number | null, localId: string): QueueStateSnapshot {
    this.removePendingSteer(chatId, topicId, localId);
    return this.getQueueState(chatId, topicId);
  }

  drainPendingSteers(chatId: number, topicId: number | null): PendingSteerDrain {
    const topicState = this.ensureTopicState(chatId, topicId);
    if (topicState.pendingSteers.length === 0) {
      return {
        mergedMessage: null,
        queueState: this.getQueueState(chatId, topicId)
      };
    }

    const drained = topicState.pendingSteers.splice(0, topicState.pendingSteers.length);
    const lastMessage = drained.at(-1)?.message;
    const mergedMessage = lastMessage
      ? {
          ...lastMessage,
          text: drained.map((pending) => pending.message.text).filter((text) => text.length > 0).join("\n"),
          input: mergeUserTurnInput(drained.map((pending) => pending.message.input))
        }
      : null;

    return {
      mergedMessage,
      queueState: this.getQueueState(chatId, topicId)
    };
  }

  movePendingSteersToQueued(chatId: number, topicId: number | null): QueueStateSnapshot {
    const topicState = this.ensureTopicState(chatId, topicId);
    if (topicState.pendingSteers.length === 0) {
      return this.getQueueState(chatId, topicId);
    }

    const drained = topicState.pendingSteers.splice(0, topicState.pendingSteers.length).map((pending) =>
      cloneUserTurnMessage(pending.message)
    );
    topicState.queuedFollowUps = [...drained, ...topicState.queuedFollowUps];
    return this.getQueueState(chatId, topicId);
  }

  private removePendingSteer(chatId: number, topicId: number | null, localId: string): PendingSteer | undefined {
    const topicState = this.ensureTopicState(chatId, topicId);
    const index = topicState.pendingSteers.findIndex((pending) => pending.localId === localId);
    if (index !== -1) {
      const [pending] = topicState.pendingSteers.splice(index, 1);
      return pending;
    }
    return undefined;
  }

  acknowledgeCommittedUserItem(turnId: string, item: Extract<ThreadItem, { type: "userMessage" }>): QueueStateSnapshot | null {
    const turn = this.#turns.get(turnId);
    if (!turn) {
      return null;
    }

    const topicState = this.ensureTopicState(turn.chatId, turn.topicId);
    const messageSignature = buildUserInputSignature(item.content);
    const index = topicState.pendingSteers.findIndex(
      (pending) =>
        pending.message.submittedInputSignature === messageSignature ||
        summarizeUserTurnMessage(pending.message) === summarizeCommittedUserMessage(item.content)
    );
    if (index !== -1) {
      topicState.pendingSteers.splice(index, 1);
    }

    return this.getQueueState(turn.chatId, turn.topicId);
  }

  registerAssistantItem(turnId: string, itemId: string, phase: MessagePhase | null): void {
    const turn = this.#turns.get(turnId);
    if (!turn) {
      return;
    }

    ensureAssistantItem(turn, itemId).phase = phase;
    if (phase === "commentary") {
      ensureCommentaryActivityEntry(turn, itemId);
    }
  }

  registerPlanItem(turnId: string, itemId: string): void {
    const turn = this.#turns.get(turnId);
    if (!turn) {
      return;
    }

    ensurePlanItem(turn, itemId);
  }

  appendAssistantDelta(turnId: string, itemId: string, delta: string): void {
    const turn = this.#turns.get(turnId);
    if (!turn) {
      return;
    }

    const item = ensureAssistantItem(turn, itemId);
    item.text = `${item.text}${delta}`;
    syncCommentaryActivityEntry(turn, itemId, item.phase, item.text);
  }

  commitAssistantItem(
    turnId: string,
    itemId: string,
    text: string,
    phase: MessagePhase | null
  ): void {
    const turn = this.#turns.get(turnId);
    if (!turn) {
      return;
    }

    const item = ensureAssistantItem(turn, itemId);
    item.phase = phase;
    item.text = text;
    syncCommentaryActivityEntry(turn, itemId, phase, text);
  }

  commitPlanItem(turnId: string, itemId: string, text: string): void {
    const turn = this.#turns.get(turnId);
    if (!turn) {
      return;
    }

    const item = ensurePlanItem(turn, itemId);
    item.text = text;
  }

  renderAssistantItems(turnId: string): string {
    const turn = this.#turns.get(turnId);
    return turn ? renderFinalAssistantText(turn) : "";
  }

  renderCommentaryItems(turnId: string): string[] {
    const turn = this.#turns.get(turnId);
    return turn ? renderCommentaryTexts(turn) : [];
  }

  appendActivityLogEntry(turnId: string, entry: ActivityLogEntry): void {
    const turn = this.#turns.get(turnId);
    if (!turn) {
      return;
    }

    turn.activityLogEntries.push(entry);
  }

  renderActivityLogEntries(turnId: string): ActivityLogEntry[] {
    const turn = this.#turns.get(turnId);
    return turn ? renderActivityLogEntries(turn) : [];
  }

  renderPlanItems(turnId: string): string {
    const turn = this.#turns.get(turnId);
    return turn ? renderPlanText(turn) : "";
  }

  getLatestPlanItemId(turnId: string): string | null {
    const turn = this.#turns.get(turnId);
    return turn?.planItemOrder.at(-1) ?? null;
  }

  finalizeTurn(turnId: string): QueueStateSnapshot | null {
    const turn = this.#turns.get(turnId);
    if (!turn) {
      return null;
    }

    const topicState = this.ensureTopicState(turn.chatId, turn.topicId);
    if (topicState.activeTurnId === turnId) {
      topicState.activeTurnId = null;
    }
    topicState.pendingSteers = topicState.pendingSteers.filter((pending) => pending.turnId !== turnId);

    this.#turns.delete(turnId);
    const snapshot = this.getQueueState(turn.chatId, turn.topicId);
    this.cleanupTopicState(turn.chatId, turn.topicId);
    return snapshot;
  }

  getQueueState(chatId: number, topicId: number | null): QueueStateSnapshot {
    const topicState = this.#topicStates.get(topicKey(chatId, topicId));
    return {
      chatId,
      topicId,
      pendingSteers: topicState?.pendingSteers.map((pending) => summarizeUserTurnMessage(pending.message)) ?? [],
      queuedFollowUps:
        topicState?.queuedFollowUps.map((message) => ({
          actorLabel: resolveUserTurnActorLabel(message),
          text: summarizeUserTurnMessage(message)
        })) ?? []
    };
  }

  peekNextQueuedFollowUp(chatId: number, topicId: number | null): UserTurnMessage | undefined {
    return this.#topicStates.get(topicKey(chatId, topicId))?.queuedFollowUps[0];
  }

  shiftNextQueuedFollowUp(chatId: number, topicId: number | null): UserTurnMessage | undefined {
    const topicState = this.#topicStates.get(topicKey(chatId, topicId));
    const next = topicState?.queuedFollowUps.shift();
    this.cleanupTopicState(chatId, topicId);
    return next;
  }

  prependQueuedFollowUp(chatId: number, topicId: number | null, message: UserTurnMessage): QueueStateSnapshot {
    this.ensureTopicState(chatId, topicId).queuedFollowUps.unshift(cloneUserTurnMessage(message));
    return this.getQueueState(chatId, topicId);
  }

  private ensureTopicState(chatId: number, topicId: number | null): TopicState {
    const key = topicKey(chatId, topicId);
    const existing = this.#topicStates.get(key);
    if (existing) {
      return existing;
    }

    const created: TopicState = {
      activeTurnId: null,
      pendingSteers: [],
      queuedFollowUps: []
    };
    this.#topicStates.set(key, created);
    return created;
  }

  private cleanupTopicState(chatId: number, topicId: number | null): void {
    const key = topicKey(chatId, topicId);
    const topicState = this.#topicStates.get(key);
    if (!topicState) {
      return;
    }

    if (topicState.activeTurnId === null && topicState.pendingSteers.length === 0 && topicState.queuedFollowUps.length === 0) {
      this.#topicStates.delete(key);
    }
  }
}

function ensureAssistantItem(turn: RuntimeTurn, itemId: string): AssistantItemState {
  const existing = turn.assistantItems.get(itemId);
  if (existing) {
    return existing;
  }

  const created: AssistantItemState = {
    text: "",
    phase: null
  };
  turn.assistantItems.set(itemId, created);
  turn.assistantItemOrder.push(itemId);
  return created;
}

function ensurePlanItem(turn: RuntimeTurn, itemId: string): PlanItemState {
  const existing = turn.planItems.get(itemId);
  if (existing) {
    return existing;
  }

  const created: PlanItemState = {
    text: ""
  };
  turn.planItems.set(itemId, created);
  turn.planItemOrder.push(itemId);
  return created;
}

function ensureCommentaryActivityEntry(turn: RuntimeTurn, itemId: string): ActivityLogEntry {
  const existingIndex = turn.commentaryActivityEntryIndexes.get(itemId);
  if (existingIndex !== undefined) {
    return turn.activityLogEntries[existingIndex] ?? { kind: "commentary", text: "" };
  }

  const entry: ActivityLogEntry = {
    kind: "commentary",
    text: ""
  };
  turn.activityLogEntries.push(entry);
  turn.commentaryActivityEntryIndexes.set(itemId, turn.activityLogEntries.length - 1);
  return entry;
}

function syncCommentaryActivityEntry(
  turn: RuntimeTurn,
  itemId: string,
  phase: MessagePhase | null,
  text: string
): void {
  if (phase !== "commentary") {
    return;
  }

  const entry = ensureCommentaryActivityEntry(turn, itemId);
  if (entry.kind === "commentary") {
    entry.text = text;
  }
}

function renderFinalAssistantText(turn: RuntimeTurn): string {
  const items = getAssistantItemsWithText(turn);
  if (items.some((item) => item.phase === "final_answer")) {
    return renderAssistantText(items.filter((item) => item.phase === "final_answer"));
  }

  return renderAssistantText(items.filter((item) => item.phase !== "commentary"));
}

function renderPlanText(turn: RuntimeTurn): string {
  return turn.planItemOrder
    .map((itemId) => turn.planItems.get(itemId)?.text ?? "")
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function renderCommentaryTexts(turn: RuntimeTurn): string[] {
  return getAssistantItemsWithText(turn)
    .filter((item) => item.phase === "commentary")
    .map((item) => item.text);
}

function renderActivityLogEntries(turn: RuntimeTurn): ActivityLogEntry[] {
  return turn.activityLogEntries.filter((entry) => {
    if (entry.kind === "commentary") {
      return entry.text.trim().length > 0;
    }

    return true;
  });
}

function getAssistantItemsWithText(turn: RuntimeTurn): AssistantItemState[] {
  return turn.assistantItemOrder
    .map((itemId) => turn.assistantItems.get(itemId))
    .filter((item): item is AssistantItemState => Boolean(item?.text.length));
}

function renderAssistantText(items: AssistantItemState[]): string {
  return items.map((item) => item.text).join("\n\n");
}

function topicKey(chatId: number, topicId: number | null): string {
  return topicId === null ? `${chatId}:root` : `${chatId}:${topicId}`;
}

function summarizeUserTurnMessage(message: UserTurnMessage): string {
  const text = message.text.trim();
  if (text.length > 0) {
    return text;
  }

  const imageCount = message.input.filter((item) => item.type === "telegramImage").length;
  if (imageCount === 1) {
    return "[Image]";
  }

  if (imageCount > 1) {
    return `[${imageCount} images]`;
  }

  return "(empty message)";
}

function resolveUserTurnActorLabel(message: UserTurnMessage): string {
  const label = message.actorLabel?.trim();
  return label?.length ? label : `User ${message.userId}`;
}

function summarizeCommittedUserMessage(input: UserInput[]): string {
  const text = input
    .filter((item): item is Extract<UserInput, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("")
    .trim();

  if (text.length > 0) {
    return text;
  }

  const imageCount = input.filter((item) => item.type === "localImage" || item.type === "image").length;
  if (imageCount === 1) {
    return "[Image]";
  }

  if (imageCount > 1) {
    return `[${imageCount} images]`;
  }

  return "(empty message)";
}

function mergeUserTurnInput(messageInputs: UserTurnInput[][]): UserTurnInput[] {
  const merged: UserTurnInput[] = [];

  for (const input of messageInputs) {
    for (const item of input) {
      if (item.type !== "text") {
        merged.push(item);
        continue;
      }

      const previous = merged.at(-1);
      if (previous?.type === "text") {
        previous.text = `${previous.text}\n${item.text}`;
        continue;
      }

      merged.push({
        ...item,
        text_elements: [...item.text_elements]
      });
    }
  }

  return merged;
}

function cloneUserTurnMessage(message: UserTurnMessage): UserTurnMessage {
  return {
    ...message
  };
}
