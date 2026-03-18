import { describe, expect, it, vi } from "vitest";
import type { MessageEntity } from "grammy/types";

import type { UserTurnMessage } from "../src/domain";
import { TurnLifecycleCoordinator } from "../src/bridge/turn-lifecycle";
import { MARKDOWN_AST_VERSION, parseMarkdownToMdast, serializeMarkdownAst } from "../src/markdown/ast";
import { TelegramMessenger, type TelegramApi } from "../src/telegram-messenger";
import { BridgeTurnRuntime, type QueueStateSnapshot } from "../src/turn-runtime";

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

class FakeTelegram implements TelegramApi {
  messageCounter = 0;
  sentMessages: Array<{ chatId: number; text: string; options?: Record<string, unknown> }> = [];
  drafts: Array<{ chatId: number; draftId: number; text: string }> = [];
  edits: Array<{ chatId: number; messageId: number; text: string }> = [];
  deletions: Array<{ chatId: number; messageId: number }> = [];

  async createForumTopic(_chatId: number, _name: string): Promise<{ message_thread_id: number; name: string }> {
    throw new Error("Not implemented");
  }

  async sendMessage(
    chatId: number,
    text: string,
    options?: Record<string, unknown>
  ): Promise<{ message_id: number }> {
    this.messageCounter += 1;
    this.sentMessages.push(options ? { chatId, text, options } : { chatId, text });
    return { message_id: this.messageCounter };
  }

  async sendMessageDraft(
    chatId: number,
    draftId: number,
    text: string,
    _options?: { message_thread_id?: number; entities?: MessageEntity[] }
  ): Promise<true> {
    this.drafts.push({ chatId, draftId, text });
    return true;
  }

  async sendChatAction(
    _chatId: number,
    _action: "typing" | "upload_document",
    _options?: { message_thread_id?: number }
  ): Promise<true> {
    return true;
  }

  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    _options?: Record<string, unknown>
  ): Promise<unknown> {
    this.edits.push({ chatId, messageId, text });
    return true;
  }

  async deleteMessage(chatId: number, messageId: number): Promise<true> {
    this.deletions.push({ chatId, messageId });
    return true;
  }

  async answerCallbackQuery(_callbackQueryId: string, _options?: { text?: string }): Promise<true> {
    return true;
  }

  async downloadFile(_fileId: string): Promise<{ bytes: Uint8Array; filePath?: string }> {
    return { bytes: new Uint8Array() };
  }
}

function createHarness(
  resolvedSnapshot:
    | string
    | {
        text: string;
        assistantText?: string;
        planText?: string;
        changedFiles?: number;
        cwd?: string | null;
        branch?: string | null;
      } = { text: "" }
): {
  coordinator: TurnLifecycleCoordinator;
  telegram: FakeTelegram;
  appendCalls: string[];
  completionCalls: Array<{ turnId: string; messageId: number | null; status: "completed" | "failed" | "interrupted" }>;
  releasedTurnIds: string[];
  queueSyncs: QueueStateSnapshot[];
  nextQueuedCalls: Array<{ chatId: number; topicId: number }>;
  queuedFollowUps: Array<{ chatId: number; topicId: number; message: UserTurnMessage }>;
} {
  const telegram = new FakeTelegram();
  const runtime = new BridgeTurnRuntime();
  const appendCalls: string[] = [];
  const completionCalls: Array<{ turnId: string; messageId: number | null; status: "completed" | "failed" | "interrupted" }> =
    [];
  const releasedTurnIds: string[] = [];
  const queueSyncs: QueueStateSnapshot[] = [];
  const nextQueuedCalls: Array<{ chatId: number; topicId: number }> = [];
  const queuedFollowUps: Array<{ chatId: number; topicId: number; message: UserTurnMessage }> = [];
  const snapshot =
    typeof resolvedSnapshot === "string"
      ? {
          text: resolvedSnapshot,
          assistantText: resolvedSnapshot,
          planText: "",
          changedFiles: 0,
          cwd: "/workspace",
          branch: "main"
        }
      : {
          text: resolvedSnapshot.text,
          assistantText: resolvedSnapshot.assistantText ?? resolvedSnapshot.text,
          planText: resolvedSnapshot.planText ?? "",
          changedFiles: resolvedSnapshot.changedFiles ?? 0,
          cwd: resolvedSnapshot.cwd ?? "/workspace",
          branch: resolvedSnapshot.branch ?? "main"
        };

  const coordinator = new TurnLifecycleCoordinator({
    runtime,
    messenger: new TelegramMessenger(telegram),
    telegram,
    planArtifactPublicUrl: null,
    upsertPlanArtifact: async ({ chatId, topicId, threadId, turnId, itemId, markdownText }) => ({
      id: 1,
      artifactId: `artifact:${turnId}:${itemId}`,
      kind: "plan",
      title: "Plan",
      telegramChatId: String(chatId),
      telegramTopicId: topicId,
      codexThreadId: threadId,
      codexTurnId: turnId,
      itemId,
      markdownText,
      mdastJson: serializeMarkdownAst(parseMarkdownToMdast(markdownText)),
      astVersion: MARKDOWN_AST_VERSION,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }),
    releaseTurnFiles: async (turnId) => {
      releasedTurnIds.push(turnId);
    },
    appendTurnStream: async (_turnId, text) => {
      appendCalls.push(text);
    },
    completePersistedTurn: async (turnId, messageId, status) => {
      completionCalls.push({ turnId, messageId, status });
    },
    resolveTurnSnapshot: async () => ({
      text: snapshot.text,
      assistantText: snapshot.assistantText,
      planText: snapshot.planText,
      changedFiles: snapshot.changedFiles,
      cwd: snapshot.cwd,
      branch: snapshot.branch
    }),
    syncQueuePreview: async (queueState) => {
      queueSyncs.push(queueState);
    },
    maybeSendNextQueuedFollowUp: async (chatId, topicId) => {
      nextQueuedCalls.push({ chatId, topicId });
    },
    submitQueuedFollowUp: async (chatId, topicId, queuedMessage) => {
      queuedFollowUps.push({ chatId, topicId, message: queuedMessage });
    }
  });

  return {
    coordinator,
    telegram,
    appendCalls,
    completionCalls,
    releasedTurnIds,
    queueSyncs,
    nextQueuedCalls,
    queuedFollowUps
  };
}

describe("TurnLifecycleCoordinator", () => {
  it("finalizes completed turns through one shared terminal path", async () => {
    const harness = createHarness("Final answer");
    const context = harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");

    await harness.coordinator.completeTurn("thread-1", "turn-1");

    expect(context.phase).toBe("completed");
    expect(harness.appendCalls.at(-1)).toBe("Final answer");
    expect(harness.completionCalls).toEqual([
      {
        turnId: "turn-1",
        messageId: 1,
        status: "completed"
      }
    ]);
    expect(harness.releasedTurnIds).toEqual(["turn-1"]);
    expect(harness.nextQueuedCalls).toEqual([{ chatId: -1001, topicId: 777 }]);
    expect(harness.coordinator.getTurn("turn-1")).toBeUndefined();
  });

  it("ignores duplicate terminal notifications once a turn has been finalized", async () => {
    const harness = createHarness("Final answer");
    harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");

    await harness.coordinator.completeTurn("thread-1", "turn-1");
    await harness.coordinator.failTurn("thread-1", "turn-1", "late error");

    expect(harness.completionCalls).toEqual([
      {
        turnId: "turn-1",
        messageId: 1,
        status: "completed"
      }
    ]);
  });

  it("clears leftover pending steers on completion instead of requeueing them", async () => {
    const harness = createHarness("Final answer");
    harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");
    harness.coordinator.queuePendingSteer("turn-1", message("Follow up", 2));

    await harness.coordinator.completeTurn("thread-1", "turn-1");

    expect(harness.queueSyncs.at(-1)).toEqual({
      chatId: -1001,
      topicId: 777,
      pendingSteers: [],
      queuedFollowUps: []
    });
  });

  it("persists completed plan items without duplicating them at turn finalization", async () => {
    const harness = createHarness({
      text: "1. Draft the rollout",
      assistantText: "",
      planText: "1. Draft the rollout"
    });
    harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");

    await harness.coordinator.handleItemStarted("turn-1", {
      type: "plan",
      id: "plan-1",
      text: ""
    });
    await harness.coordinator.handleItemCompleted("turn-1", {
      type: "plan",
      id: "plan-1",
      text: "1. Draft the rollout"
    });
    await harness.coordinator.completeTurn("thread-1", "turn-1");

    expect(harness.telegram.sentMessages.filter((message) => message.text.startsWith("Plan"))).toEqual([
      {
        chatId: -1001,
        text: "Plan\n\n1. Draft the rollout",
        options: {
          message_thread_id: 777
        }
      }
    ]);
    expect(harness.appendCalls.at(-1)).toBe("1. Draft the rollout");
  });

  it("submits merged pending steers when an interrupted turn is finalized with send-now intent", async () => {
    const harness = createHarness("");
    const context = harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");

    harness.coordinator.queuePendingSteer("turn-1", message("First steer", 2));
    harness.coordinator.queuePendingSteer("turn-1", message("Second steer", 3));
    harness.coordinator.requestPendingSteerSubmissionAfterInterrupt("turn-1");

    await harness.coordinator.finalizeInterruptedTurnById("thread-1", "turn-1");

    expect(context.phase).toBe("interrupted");
    expect(harness.completionCalls).toEqual([
      {
        turnId: "turn-1",
        messageId: null,
        status: "interrupted"
      }
    ]);
    expect(harness.queuedFollowUps).toHaveLength(1);
    expect(harness.queuedFollowUps[0]?.message.text).toBe("First steer\nSecond steer");
    expect(harness.nextQueuedCalls).toEqual([]);
  });

  it("maps committed user items back to pending steers and syncs the queue preview", async () => {
    const harness = createHarness();
    harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");
    harness.coordinator.queuePendingSteer("turn-1", message("Follow up", 2));

    await harness.coordinator.handleItemCompleted("turn-1", {
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

    expect(harness.queueSyncs.at(-1)).toEqual({
      chatId: -1001,
      topicId: 777,
      pendingSteers: [],
      queuedFollowUps: []
    });
  });

  it("keeps elapsed time current every 3 seconds without resetting the timer on status changes", async () => {
    vi.useFakeTimers();

    try {
      const harness = createHarness();
      harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");
      await harness.coordinator.publishCurrentStatus("turn-1", true);
      expect(harness.telegram.drafts.at(-1)?.text).toBe("thinking · 0s");

      await vi.advanceTimersByTimeAsync(2000);
      await harness.coordinator.handleItemStarted("turn-1", {
        type: "commandExecution",
        id: "item-1",
        command: "npm test",
        cwd: "/workspace",
        processId: null,
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null
      });
      expect(harness.telegram.drafts.at(-1)?.text).toBe("running: npm test · 2s");

      await vi.advanceTimersByTimeAsync(1000);
      expect(harness.telegram.drafts.at(-1)?.text).toBe("running: npm test · 3s");

      await harness.coordinator.completeTurn("thread-1", "turn-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses rerouted model, token usage, and resolved thread metadata in the completion footer", async () => {
    const harness = createHarness({
      text: "Final answer",
      changedFiles: 2,
      cwd: "/home/tester/kirbot",
      branch: "feature/footer"
    });

    harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex", "high");
    harness.coordinator.handleThreadTokenUsageUpdated("turn-1", {
      total: {
        totalTokens: 17000,
        inputTokens: 12000,
        cachedInputTokens: 0,
        outputTokens: 5000,
        reasoningOutputTokens: 0
      },
      last: {
        totalTokens: 17000,
        inputTokens: 12000,
        cachedInputTokens: 0,
        outputTokens: 5000,
        reasoningOutputTokens: 0
      },
      modelContextWindow: 32000
    });
    harness.coordinator.handleModelRerouted("turn-1", "gpt-5");

    await harness.coordinator.completeTurn("thread-1", "turn-1");

    expect(harness.telegram.sentMessages.at(-2)?.text).toBe("Final answer");
    expect(harness.telegram.sentMessages.at(-1)?.text).toBe(
      "gpt-5 high • <1s • 2 files • 75% left • /home/tester/kirbot • feature/footer"
    );
  });

  it("includes reasoning output tokens in the completion footer context-left calculation", async () => {
    const harness = createHarness({
      text: "Final answer",
      changedFiles: 0,
      cwd: "/workspace",
      branch: "main"
    });

    harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");
    harness.coordinator.handleThreadTokenUsageUpdated("turn-1", {
      total: {
        totalTokens: 26000,
        inputTokens: 12000,
        cachedInputTokens: 0,
        outputTokens: 14000,
        reasoningOutputTokens: 5000
      },
      last: {
        totalTokens: 26000,
        inputTokens: 12000,
        cachedInputTokens: 0,
        outputTokens: 14000,
        reasoningOutputTokens: 5000
      },
      modelContextWindow: 32000
    });

    await harness.coordinator.completeTurn("thread-1", "turn-1");

    expect(harness.telegram.sentMessages.at(-1)?.text).toBe(
      "gpt-5-codex • <1s • 0 files • 30% left • /workspace • main"
    );
  });

  it("uses last token usage instead of total aggregate usage in the completion footer", async () => {
    const harness = createHarness({
      text: "Final answer",
      changedFiles: 0,
      cwd: "/workspace",
      branch: "main"
    });

    harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");
    harness.coordinator.handleThreadTokenUsageUpdated("turn-1", {
      total: {
        totalTokens: 26000,
        inputTokens: 12000,
        cachedInputTokens: 0,
        outputTokens: 14000,
        reasoningOutputTokens: 0
      },
      last: {
        totalTokens: 17000,
        inputTokens: 12000,
        cachedInputTokens: 0,
        outputTokens: 5000,
        reasoningOutputTokens: 0
      },
      modelContextWindow: 32000
    });

    await harness.coordinator.completeTurn("thread-1", "turn-1");

    expect(harness.telegram.sentMessages.at(-1)?.text).toBe(
      "gpt-5-codex • <1s • 0 files • 75% left • /workspace • main"
    );
  });

  it("rounds the completion footer context-left percentage to the nearest integer", async () => {
    const harness = createHarness({
      text: "Final answer",
      changedFiles: 0,
      cwd: "/workspace",
      branch: "main"
    });

    harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");
    harness.coordinator.handleThreadTokenUsageUpdated("turn-1", {
      total: {
        totalTokens: 12495,
        inputTokens: 12495,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0
      },
      last: {
        totalTokens: 12495,
        inputTokens: 12495,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0
      },
      modelContextWindow: 13000
    });

    await harness.coordinator.completeTurn("thread-1", "turn-1");

    expect(harness.telegram.sentMessages.at(-1)?.text).toBe(
      "gpt-5-codex • <1s • 0 files • 51% left • /workspace • main"
    );
  });

  it("omits reasoning effort from the completion footer when it is not available", async () => {
    const harness = createHarness({
      text: "Final answer",
      changedFiles: 0,
      cwd: "/workspace",
      branch: "main"
    });

    harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");
    await harness.coordinator.completeTurn("thread-1", "turn-1");

    expect(harness.telegram.sentMessages.at(-1)?.text).toBe(
      "gpt-5-codex • <1s • 0 files • 100% left • /workspace • main"
    );
  });
});
