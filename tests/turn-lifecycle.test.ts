import { describe, expect, it } from "vitest";

import type { UserTurnMessage } from "../src/domain";
import type { TelegramStatusDraftHandle, TelegramStreamMessageHandle } from "../src/telegram-messenger";
import { TurnLifecycle } from "../src/turn-lifecycle";

function statusHandle(): TelegramStatusDraftHandle {
  return {
    set: async () => {},
    clear: async () => {},
    close: async () => {}
  } as unknown as TelegramStatusDraftHandle;
}

function streamHandle(): TelegramStreamMessageHandle {
  return {
    update: async () => {},
    finalize: async () => 1,
    clear: async () => {}
  } as unknown as TelegramStreamMessageHandle;
}

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

function activateTurn(lifecycle: TurnLifecycle, turnId = "turn-1") {
  return lifecycle.activateTurn({
    chatId: -1001,
    topicId: 777,
    threadId: "thread-1",
    turnId,
    draftId: 1,
    statusDraft: {
      state: "thinking",
      emoji: "🤔",
      details: null
    },
    lastStatusUpdateAt: 0,
    statusHandle: statusHandle(),
    finalStream: streamHandle()
  });
}

describe("TurnLifecycle", () => {
  it("tracks an activated turn by id and topic", () => {
    const lifecycle = new TurnLifecycle();
    const turn = activateTurn(lifecycle);

    expect(lifecycle.getContext(turn.turnId)?.phase).toBe("active");
    expect(lifecycle.getActiveTurnByTopic(turn.chatId, turn.topicId)?.turnId).toBe("turn-1");
  });

  it("prevents duplicate terminal finalization", () => {
    const lifecycle = new TurnLifecycle();
    activateTurn(lifecycle);

    expect(lifecycle.beginFinalization("turn-1")?.phase).toBe("finalizing");
    expect(lifecycle.beginFinalization("turn-1")).toBeNull();
    expect(lifecycle.finalizeTurn("turn-1", "completed")?.context.phase).toBe("completed");
    expect(lifecycle.finalizeTurn("turn-1", "completed")).toBeNull();
    expect(lifecycle.getContext("turn-1")).toBeUndefined();
  });

  it("attaches steer input only while the turn is active", () => {
    const lifecycle = new TurnLifecycle();
    activateTurn(lifecycle);

    expect(lifecycle.queuePendingSteer("turn-1", message("Follow up"))?.queueState).toEqual({
      chatId: -1001,
      topicId: 777,
      pendingSteers: ["Follow up"],
      queuedFollowUps: []
    });

    lifecycle.beginFinalization("turn-1");
    expect(lifecycle.queuePendingSteer("turn-1", message("Too late", 2))).toBeNull();
  });

  it("drains pending steers into one merged message when interrupt submission is requested", () => {
    const lifecycle = new TurnLifecycle();
    activateTurn(lifecycle);

    lifecycle.queuePendingSteer("turn-1", message("First steer", 2));
    lifecycle.queuePendingSteer("turn-1", message("Second steer", 3));
    lifecycle.requestSubmitPendingSteersAfterInterrupt("turn-1");

    const interrupted = lifecycle.prepareInterruptedFinalization("turn-1");

    expect(interrupted?.submitPendingSteers).toBe(true);
    expect(interrupted?.pendingSteers?.mergedMessage?.text).toBe("First steer\nSecond steer");
    expect(interrupted?.pendingSteers?.queueState).toEqual({
      chatId: -1001,
      topicId: 777,
      pendingSteers: [],
      queuedFollowUps: []
    });
  });

  it("moves pending steers into the next-turn queue on a normal interrupt", () => {
    const lifecycle = new TurnLifecycle();
    activateTurn(lifecycle);

    lifecycle.queuePendingSteer("turn-1", message("Pending steer", 2));

    const interrupted = lifecycle.prepareInterruptedFinalization("turn-1", false);

    expect(interrupted?.submitPendingSteers).toBe(false);
    expect(interrupted?.pendingSteers).toBeNull();
    expect(lifecycle.getQueueState(-1001, 777)).toEqual({
      chatId: -1001,
      topicId: 777,
      pendingSteers: [],
      queuedFollowUps: ["Pending steer"]
    });
  });

  it("ignores assistant updates once finalization has started", () => {
    const lifecycle = new TurnLifecycle();
    activateTurn(lifecycle);

    lifecycle.registerAssistantItem("turn-1", "item-1", "final_answer");
    expect(lifecycle.appendAssistantDelta("turn-1", "item-1", "Hello")?.update.finalText).toBe("Hello");

    lifecycle.beginFinalization("turn-1");
    expect(lifecycle.appendAssistantDelta("turn-1", "item-1", " world")).toBeNull();
  });
});
