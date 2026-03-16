import type { UserTurnInput, UserTurnMessage } from "./domain";
import type { MessagePhase } from "./generated/codex/MessagePhase";
import type { UserInput } from "./generated/codex/v2/UserInput";
import type { ThreadItem } from "./generated/codex/v2/ThreadItem";

type AssistantItemState = {
  text: string;
  phase: MessagePhase | null;
};

export type RuntimeTurn = {
  chatId: number;
  topicId: number;
  threadId: string;
  turnId: string;
  draftId: number;
  assistantItemOrder: string[];
  assistantItems: Map<string, AssistantItemState>;
  hasAssistantText: boolean;
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
  topicId: number;
  pendingSteers: string[];
  queuedFollowUps: string[];
};

export type PendingSteerDrain = {
  mergedMessage: UserTurnMessage | null;
  queueState: QueueStateSnapshot;
};

export type AssistantDraftKind = "assistant" | "commentary";

export type AssistantRenderUpdate = {
  draftText: string;
  draftKind: AssistantDraftKind;
  finalText: string;
  startedAssistantText: boolean;
};

export class BridgeTurnRuntime {
  readonly #turns = new Map<string, RuntimeTurn>();
  readonly #topicStates = new Map<string, TopicState>();
  #nextPendingSteerId = 1;

  registerTurn(input: {
    chatId: number;
    topicId: number;
    threadId: string;
    turnId: string;
    draftId: number;
  }): RuntimeTurn {
    const turn: RuntimeTurn = {
      chatId: input.chatId,
      topicId: input.topicId,
      threadId: input.threadId,
      turnId: input.turnId,
      draftId: input.draftId,
      assistantItemOrder: [],
      assistantItems: new Map<string, AssistantItemState>(),
      hasAssistantText: false
    };

    this.#turns.set(input.turnId, turn);
    this.ensureTopicState(input.chatId, input.topicId).activeTurnId = input.turnId;
    return turn;
  }

  getTurn(turnId: string): RuntimeTurn | undefined {
    return this.#turns.get(turnId);
  }

  getActiveTurnByTopic(chatId: number, topicId: number): RuntimeTurn | undefined {
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

  movePendingSteerToQueued(chatId: number, topicId: number, localId: string): QueueStateSnapshot {
    const pending = this.removePendingSteer(chatId, topicId, localId);
    if (pending) {
      this.ensureTopicState(chatId, topicId).queuedFollowUps.push(pending.message);
    }
    return this.getQueueState(chatId, topicId);
  }

  dropPendingSteer(chatId: number, topicId: number, localId: string): QueueStateSnapshot {
    this.removePendingSteer(chatId, topicId, localId);
    return this.getQueueState(chatId, topicId);
  }

  drainPendingSteers(chatId: number, topicId: number): PendingSteerDrain {
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

  movePendingSteersToQueued(chatId: number, topicId: number): QueueStateSnapshot {
    const topicState = this.ensureTopicState(chatId, topicId);
    if (topicState.pendingSteers.length === 0) {
      return this.getQueueState(chatId, topicId);
    }

    const drained = topicState.pendingSteers.splice(0, topicState.pendingSteers.length).map((pending) => pending.message);
    topicState.queuedFollowUps = [...drained, ...topicState.queuedFollowUps];
    return this.getQueueState(chatId, topicId);
  }

  private removePendingSteer(chatId: number, topicId: number, localId: string): PendingSteer | undefined {
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
  }

  appendAssistantDelta(turnId: string, itemId: string, delta: string): AssistantRenderUpdate | null {
    const turn = this.#turns.get(turnId);
    if (!turn) {
      return null;
    }

    const startedAssistantText = !turn.hasAssistantText;
    turn.hasAssistantText = true;
    const item = ensureAssistantItem(turn, itemId);
    item.text = `${item.text}${delta}`;

    return buildAssistantRenderUpdate(turn, startedAssistantText);
  }

  commitAssistantItem(
    turnId: string,
    itemId: string,
    text: string,
    phase: MessagePhase | null
  ): AssistantRenderUpdate | null {
    const turn = this.#turns.get(turnId);
    if (!turn) {
      return null;
    }

    const startedAssistantText = !turn.hasAssistantText;
    turn.hasAssistantText = true;
    const item = ensureAssistantItem(turn, itemId);
    item.phase = phase;
    item.text = text;

    return buildAssistantRenderUpdate(turn, startedAssistantText);
  }

  renderAssistantItems(turnId: string): string {
    const turn = this.#turns.get(turnId);
    return turn ? renderFinalAssistantText(turn) : "";
  }

  renderAssistantDraft(turnId: string): { text: string; kind: AssistantDraftKind } {
    const turn = this.#turns.get(turnId);
    return turn ? renderAssistantDraft(turn) : { text: "", kind: "assistant" };
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

  getQueueState(chatId: number, topicId: number): QueueStateSnapshot {
    const topicState = this.#topicStates.get(topicKey(chatId, topicId));
    return {
      chatId,
      topicId,
      pendingSteers: topicState?.pendingSteers.map((pending) => summarizeUserTurnMessage(pending.message)) ?? [],
      queuedFollowUps: topicState?.queuedFollowUps.map((message) => summarizeUserTurnMessage(message)) ?? []
    };
  }

  peekNextQueuedFollowUp(chatId: number, topicId: number): UserTurnMessage | undefined {
    return this.#topicStates.get(topicKey(chatId, topicId))?.queuedFollowUps[0];
  }

  shiftNextQueuedFollowUp(chatId: number, topicId: number): UserTurnMessage | undefined {
    const topicState = this.#topicStates.get(topicKey(chatId, topicId));
    const next = topicState?.queuedFollowUps.shift();
    this.cleanupTopicState(chatId, topicId);
    return next;
  }

  prependQueuedFollowUp(chatId: number, topicId: number, message: UserTurnMessage): QueueStateSnapshot {
    this.ensureTopicState(chatId, topicId).queuedFollowUps.unshift(message);
    return this.getQueueState(chatId, topicId);
  }

  private ensureTopicState(chatId: number, topicId: number): TopicState {
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

  private cleanupTopicState(chatId: number, topicId: number): void {
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

function buildAssistantRenderUpdate(turn: RuntimeTurn, startedAssistantText: boolean): AssistantRenderUpdate {
  const draft = renderAssistantDraft(turn);
  return {
    draftText: draft.text,
    draftKind: draft.kind,
    finalText: renderFinalAssistantText(turn),
    startedAssistantText
  };
}

function renderAssistantDraft(turn: RuntimeTurn): { text: string; kind: AssistantDraftKind } {
  const items = getAssistantItemsWithText(turn);
  if (items.some((item) => item.phase === "final_answer")) {
    return {
      text: renderAssistantText(items.filter((item) => item.phase === "final_answer")),
      kind: "assistant"
    };
  }

  if (items.some((item) => item.phase === null)) {
    return {
      text: renderAssistantText(items),
      kind: "assistant"
    };
  }

  return {
    text: renderAssistantText(items.filter((item) => item.phase === "commentary")),
    kind: "commentary"
  };
}

function renderFinalAssistantText(turn: RuntimeTurn): string {
  const items = getAssistantItemsWithText(turn);
  if (items.some((item) => item.phase === "final_answer")) {
    return renderAssistantText(items.filter((item) => item.phase === "final_answer"));
  }

  return renderAssistantText(items);
}

function getAssistantItemsWithText(turn: RuntimeTurn): AssistantItemState[] {
  return turn.assistantItemOrder
    .map((itemId) => turn.assistantItems.get(itemId))
    .filter((item): item is AssistantItemState => Boolean(item?.text.length));
}

function renderAssistantText(items: AssistantItemState[]): string {
  return items.map((item) => item.text).join("\n\n");
}

function topicKey(chatId: number, topicId: number): string {
  return `${chatId}:${topicId}`;
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

function buildUserInputSignature(input: UserInput[]): string {
  return JSON.stringify(
    input.map((item) => {
      if (item.type === "text") {
        return {
          type: "text",
          text: item.text
        };
      }

      if (item.type === "localImage") {
        return {
          type: "localImage",
          path: item.path
        };
      }

      if (item.type === "image") {
        return {
          type: "image",
          url: item.url
        };
      }

      return item;
    })
  );
}
