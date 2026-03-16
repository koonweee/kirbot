import type { UserTextMessage } from "./domain";
import type { ThreadItem } from "./generated/codex/v2/ThreadItem";

export type RuntimeTurn = {
  chatId: number;
  topicId: number;
  threadId: string;
  turnId: string;
  draftId: number;
  assistantItemOrder: string[];
  assistantItemTexts: Map<string, string>;
  hasAssistantText: boolean;
};

type PendingSteer = {
  localId: string;
  turnId: string;
  message: UserTextMessage;
};

type TopicState = {
  activeTurnId: string | null;
  pendingSteers: PendingSteer[];
  queuedFollowUps: UserTextMessage[];
};

export type QueueStateSnapshot = {
  chatId: number;
  topicId: number;
  pendingSteers: string[];
  queuedFollowUps: string[];
};

export type PendingSteerDrain = {
  mergedMessage: UserTextMessage | null;
  queueState: QueueStateSnapshot;
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
      assistantItemTexts: new Map<string, string>(),
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

  queuePendingSteer(activeTurn: RuntimeTurn, message: UserTextMessage): { localId: string; queueState: QueueStateSnapshot } {
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
          text: drained.map((pending) => pending.message.text).join("\n")
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
    const messageText = flattenUserMessageText(item);
    const index = topicState.pendingSteers.findIndex((pending) => pending.message.text === messageText);
    if (index !== -1) {
      topicState.pendingSteers.splice(index, 1);
    }

    return this.getQueueState(turn.chatId, turn.topicId);
  }

  appendAssistantDelta(turnId: string, itemId: string, delta: string): { rendered: string; startedAssistantText: boolean } | null {
    const turn = this.#turns.get(turnId);
    if (!turn) {
      return null;
    }

    const startedAssistantText = !turn.hasAssistantText;
    turn.hasAssistantText = true;
    if (!turn.assistantItemTexts.has(itemId)) {
      turn.assistantItemOrder.push(itemId);
      turn.assistantItemTexts.set(itemId, delta);
    } else {
      const current = turn.assistantItemTexts.get(itemId) ?? "";
      turn.assistantItemTexts.set(itemId, `${current}${delta}`);
    }

    return {
      rendered: renderAssistantItems(turn),
      startedAssistantText
    };
  }

  commitAssistantItem(turnId: string, itemId: string, text: string): { rendered: string; startedAssistantText: boolean } | null {
    const turn = this.#turns.get(turnId);
    if (!turn) {
      return null;
    }

    const startedAssistantText = !turn.hasAssistantText;
    turn.hasAssistantText = true;
    if (!turn.assistantItemTexts.has(itemId)) {
      turn.assistantItemOrder.push(itemId);
    }
    turn.assistantItemTexts.set(itemId, text);

    return {
      rendered: renderAssistantItems(turn),
      startedAssistantText
    };
  }

  renderAssistantItems(turnId: string): string {
    const turn = this.#turns.get(turnId);
    return turn ? renderAssistantItems(turn) : "";
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
      pendingSteers: topicState?.pendingSteers.map((pending) => pending.message.text) ?? [],
      queuedFollowUps: topicState?.queuedFollowUps.map((message) => message.text) ?? []
    };
  }

  peekNextQueuedFollowUp(chatId: number, topicId: number): UserTextMessage | undefined {
    return this.#topicStates.get(topicKey(chatId, topicId))?.queuedFollowUps[0];
  }

  shiftNextQueuedFollowUp(chatId: number, topicId: number): UserTextMessage | undefined {
    const topicState = this.#topicStates.get(topicKey(chatId, topicId));
    const next = topicState?.queuedFollowUps.shift();
    this.cleanupTopicState(chatId, topicId);
    return next;
  }

  prependQueuedFollowUp(chatId: number, topicId: number, message: UserTextMessage): QueueStateSnapshot {
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

function flattenUserMessageText(item: Extract<ThreadItem, { type: "userMessage" }>): string {
  return item.content
    .filter((contentItem): contentItem is Extract<typeof contentItem, { type: "text" }> => contentItem.type === "text")
    .map((contentItem) => contentItem.text)
    .join("");
}

function renderAssistantItems(turn: RuntimeTurn): string {
  return turn.assistantItemOrder
    .map((itemId) => turn.assistantItemTexts.get(itemId) ?? "")
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function topicKey(chatId: number, topicId: number): string {
  return `${chatId}:${topicId}`;
}
