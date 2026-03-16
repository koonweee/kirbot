import { describe, expect, it } from "vitest";

import type { UserTextMessage } from "../src/domain";
import { BridgeTurnRuntime } from "../src/turn-runtime";

function message(text: string, updateId = 1): UserTextMessage {
  return {
    chatId: -1001,
    topicId: 777,
    messageId: updateId,
    updateId,
    userId: 42,
    text
  };
}

describe("BridgeTurnRuntime", () => {
  it("removes a pending steer when the matching user item is committed", () => {
    const runtime = new BridgeTurnRuntime();
    const turn = runtime.registerTurn({
      chatId: -1001,
      topicId: 777,
      threadId: "thread-1",
      turnId: "turn-1",
      draftId: 1
    });

    runtime.queuePendingSteer(turn, message("Follow up"));

    const queueState = runtime.acknowledgeCommittedUserItem("turn-1", {
      type: "userMessage",
      id: "item-1",
      content: [
        {
          type: "text",
          text: "Follow up",
          text_elements: []
        }
      ]
    });

    expect(queueState).toEqual({
      chatId: -1001,
      topicId: 777,
      pendingSteers: [],
      queuedFollowUps: []
    });
  });

  it("moves a stale pending steer into the next-turn queue", () => {
    const runtime = new BridgeTurnRuntime();
    const turn = runtime.registerTurn({
      chatId: -1001,
      topicId: 777,
      threadId: "thread-1",
      turnId: "turn-1",
      draftId: 1
    });

    const pending = runtime.queuePendingSteer(turn, message("Follow up"));
    const queueState = runtime.movePendingSteerToQueued(-1001, 777, pending.localId);

    expect(queueState).toEqual({
      chatId: -1001,
      topicId: 777,
      pendingSteers: [],
      queuedFollowUps: ["Follow up"]
    });
    expect(runtime.peekNextQueuedFollowUp(-1001, 777)?.text).toBe("Follow up");
  });

  it("drains pending steers into one merged message in FIFO order", () => {
    const runtime = new BridgeTurnRuntime();
    const turn = runtime.registerTurn({
      chatId: -1001,
      topicId: 777,
      threadId: "thread-1",
      turnId: "turn-1",
      draftId: 1
    });

    runtime.queuePendingSteer(turn, message("First steer", 2));
    runtime.queuePendingSteer(turn, message("Second steer", 3));
    const drained = runtime.drainPendingSteers(-1001, 777);

    expect(drained.mergedMessage?.text).toBe("First steer\nSecond steer");
    expect(drained.queueState).toEqual({
      chatId: -1001,
      topicId: 777,
      pendingSteers: [],
      queuedFollowUps: []
    });
  });

  it("moves interrupted pending steers ahead of existing queued follow-ups", () => {
    const runtime = new BridgeTurnRuntime();
    const turn = runtime.registerTurn({
      chatId: -1001,
      topicId: 777,
      threadId: "thread-1",
      turnId: "turn-1",
      draftId: 1
    });

    runtime.queuePendingSteer(turn, message("First steer", 2));
    runtime.queuePendingSteer(turn, message("Second steer", 3));
    runtime.movePendingSteerToQueued(-1001, 777, runtime.queuePendingSteer(turn, message("Queued later", 4)).localId);
    const queueState = runtime.movePendingSteersToQueued(-1001, 777);

    expect(queueState).toEqual({
      chatId: -1001,
      topicId: 777,
      pendingSteers: [],
      queuedFollowUps: ["First steer", "Second steer", "Queued later"]
    });
  });

  it("clears leftover pending steers when a turn finalizes", () => {
    const runtime = new BridgeTurnRuntime();
    const turn = runtime.registerTurn({
      chatId: -1001,
      topicId: 777,
      threadId: "thread-1",
      turnId: "turn-1",
      draftId: 1
    });

    runtime.queuePendingSteer(turn, message("Follow up"));

    expect(runtime.finalizeTurn("turn-1")).toEqual({
      chatId: -1001,
      topicId: 777,
      pendingSteers: [],
      queuedFollowUps: []
    });
  });
});
