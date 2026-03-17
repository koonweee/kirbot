import { describe, expect, it } from "vitest";

import type { UserTurnMessage } from "../src/domain";
import { BridgeTurnRuntime } from "../src/turn-runtime";

function message(text: string, updateId = 1): UserTurnMessage {
  return {
    chatId: -1001,
    topicId: 777,
    messageId: updateId,
    updateId,
    userId: 42,
    text,
    input: [
      {
        type: "text",
        text,
        text_elements: []
      }
    ]
  };
}

describe("BridgeTurnRuntime", () => {
  it("removes a pending steer when the matching user item is committed", () => {
    const runtime = new BridgeTurnRuntime();
    const turn = runtime.registerTurn({
      chatId: -1001,
      topicId: 777,
      threadId: "thread-1",
      turnId: "turn-1"
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
      turnId: "turn-1"
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
      turnId: "turn-1"
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
      turnId: "turn-1"
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
      turnId: "turn-1"
    });

    runtime.queuePendingSteer(turn, message("Follow up"));

    expect(runtime.finalizeTurn("turn-1")).toEqual({
      chatId: -1001,
      topicId: 777,
      pendingSteers: [],
      queuedFollowUps: []
    });
  });

  it("keeps commentary in the draft while reserving final output for final-answer items", () => {
    const runtime = new BridgeTurnRuntime();
    runtime.registerTurn({
      chatId: -1001,
      topicId: 777,
      threadId: "thread-1",
      turnId: "turn-1"
    });

    runtime.registerAssistantItem("turn-1", "item-1", "commentary");
    const commentary = runtime.appendAssistantDelta("turn-1", "item-1", "Inspecting the repo");

    expect(commentary).toEqual({
      itemId: "item-1",
      itemText: "Inspecting the repo",
      itemPhase: "commentary",
      draftText: "",
      draftKind: null,
      finalText: "",
      startedAssistantText: true
    });

    runtime.registerAssistantItem("turn-1", "item-2", "final_answer");
    const finalAnswer = runtime.appendAssistantDelta("turn-1", "item-2", "Here is the fix.");

    expect(finalAnswer).toEqual({
      itemId: "item-2",
      itemText: "Here is the fix.",
      itemPhase: "final_answer",
      draftText: "Here is the fix.",
      draftKind: "assistant",
      finalText: "Here is the fix.",
      startedAssistantText: false
    });
    expect(runtime.renderAssistantDraft("turn-1")).toEqual({
      text: "Here is the fix.",
      kind: "assistant"
    });
    expect(runtime.renderAssistantItems("turn-1")).toBe("Here is the fix.");
  });

  it("falls back to legacy merged output when phase metadata is missing", () => {
    const runtime = new BridgeTurnRuntime();
    runtime.registerTurn({
      chatId: -1001,
      topicId: 777,
      threadId: "thread-1",
      turnId: "turn-1"
    });

    runtime.appendAssistantDelta("turn-1", "item-1", "First part");
    runtime.appendAssistantDelta("turn-1", "item-2", "Second part");

    expect(runtime.renderAssistantDraft("turn-1")).toEqual({
      text: "First part\n\nSecond part",
      kind: "assistant"
    });
    expect(runtime.renderAssistantItems("turn-1")).toBe("First part\n\nSecond part");
  });

  it("tracks plan items separately from assistant items", () => {
    const runtime = new BridgeTurnRuntime();
    runtime.registerTurn({
      chatId: -1001,
      topicId: 777,
      threadId: "thread-1",
      turnId: "turn-1"
    });

    runtime.registerPlanItem("turn-1", "plan-1");
    expect(runtime.appendPlanDelta("turn-1", "plan-1", "Draft the rollout")).toEqual({
      itemId: "plan-1",
      itemText: "Draft the rollout",
      finalText: "Draft the rollout"
    });

    runtime.commitPlanItem("turn-1", "plan-1", "1. Draft the rollout");
    runtime.registerAssistantItem("turn-1", "item-1", "final_answer");
    runtime.commitAssistantItem("turn-1", "item-1", "Implementation done.", "final_answer");

    expect(runtime.renderPlanItems("turn-1")).toBe("1. Draft the rollout");
    expect(runtime.renderAssistantItems("turn-1")).toBe("Implementation done.");
  });
});
