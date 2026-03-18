import { describe, expect, it, vi } from "vitest";
import type { MessageEntity } from "grammy/types";

import type { UserTurnMessage } from "../src/domain";
import { TurnLifecycleCoordinator } from "../src/bridge/turn-lifecycle";
import { decodeMiniAppArtifact, getEncodedMiniAppArtifactFromHash, MiniAppArtifactType } from "../src/mini-app/url";
import { TOPIC_IMPLEMENT_CALLBACK_DATA } from "../src/bridge/presentation";
import { TelegramMessenger, type TelegramApi } from "../src/telegram-messenger";
import { BridgeTurnRuntime, type QueueStateSnapshot } from "../src/turn-runtime";

function longText(paragraph: string, count: number): string {
  return Array.from({ length: count }, () => paragraph).join("\n\n");
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

function getInlineButtonTexts(entry: { options?: Record<string, unknown> } | undefined): string[] {
  return (
    ((entry?.options?.reply_markup as { inline_keyboard?: Array<Array<{ text?: string }>> } | undefined)?.inline_keyboard
      ?.flat()
      .map((button) => button.text)
      .filter((text): text is string => typeof text === "string")) ?? []
  );
}

function getWebAppUrlByButtonText(
  entry: { options?: Record<string, unknown> } | undefined,
  buttonText: string
): string | null {
  return (
    ((entry?.options?.reply_markup as {
      inline_keyboard?: Array<Array<{ text?: string; web_app?: { url?: string } }>>;
    } | undefined)
      ?.inline_keyboard?.flat()
      .find((button) => button.text === buttonText)
      ?.web_app?.url ?? null)
  );
}

function getCallbackDataByButtonText(
  entry: { options?: Record<string, unknown> } | undefined,
  buttonText: string
): string | null {
  return (
    ((entry?.options?.reply_markup as {
      inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>>;
    } | undefined)
      ?.inline_keyboard?.flat()
      .find((button) => button.text === buttonText)
      ?.callback_data ?? null)
  );
}

class FakeTelegram implements TelegramApi {
  messageCounter = 0;
  sentMessages: Array<{ chatId: number; text: string; options?: Record<string, unknown> }> = [];
  drafts: Array<{
    chatId: number;
    draftId: number;
    text: string;
    options?: { message_thread_id?: number; entities?: MessageEntity[] };
  }> = [];
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
    options?: { message_thread_id?: number; entities?: MessageEntity[] }
  ): Promise<true> {
    this.drafts.push(options ? { chatId, draftId, text, options } : { chatId, draftId, text });
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
  releasedTurnIds: string[];
  queueSyncs: QueueStateSnapshot[];
  nextQueuedCalls: Array<{ chatId: number; topicId: number }>;
  queuedFollowUps: Array<{ chatId: number; topicId: number; message: UserTurnMessage }>;
} {
  const telegram = new FakeTelegram();
  const runtime = new BridgeTurnRuntime();
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
    planArtifactPublicUrl: "https://example.com/mini-app",
    releaseTurnFiles: async (turnId) => {
      releasedTurnIds.push(turnId);
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
    expect(harness.telegram.sentMessages.some((entry) => entry.text === "Final answer")).toBe(true);
    expect(harness.releasedTurnIds).toEqual(["turn-1"]);
    expect(harness.nextQueuedCalls).toEqual([{ chatId: -1001, topicId: 777 }]);
    expect(harness.coordinator.getTurn("turn-1")).toBeUndefined();
  });

  it("ignores duplicate terminal notifications once a turn has been finalized", async () => {
    const harness = createHarness("Final answer");
    harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");

    await harness.coordinator.completeTurn("thread-1", "turn-1");
    await harness.coordinator.failTurn("thread-1", "turn-1", "late error");

    expect(harness.telegram.sentMessages.filter((entry) => entry.text === "Final answer")).toHaveLength(1);
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

    const planMessages = harness.telegram.sentMessages.filter((message) => message.text.startsWith("Plan"));
    expect(planMessages).toHaveLength(1);
    expect(planMessages[0]?.text).toBe("Plan is ready");
  });

  it("publishes Mini App plan links with encoded typed payloads", async () => {
    const telegram = new FakeTelegram();
    const coordinator = new TurnLifecycleCoordinator({
      runtime: new BridgeTurnRuntime(),
      messenger: new TelegramMessenger(telegram),
      telegram,
      planArtifactPublicUrl: "https://example.com/mini-app",
      releaseTurnFiles: async () => undefined,
      resolveTurnSnapshot: async () => ({
        text: "1. Draft the rollout",
        assistantText: "",
        planText: "1. Draft the rollout",
        changedFiles: 0,
        cwd: "/workspace",
        branch: "main"
      }),
      syncQueuePreview: async () => undefined,
      maybeSendNextQueuedFollowUp: async () => undefined,
      submitQueuedFollowUp: async () => undefined
    });

    coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");
    await coordinator.handleItemStarted("turn-1", {
      type: "plan",
      id: "plan-1",
      text: ""
    });
    await coordinator.handleItemCompleted("turn-1", {
      type: "plan",
      id: "plan-1",
      text: "1. Draft the rollout"
    });
    await coordinator.completeTurn("thread-1", "turn-1");

    const stub = telegram.sentMessages.find((entry) => entry.text.startsWith("Plan"));
    expect(getInlineButtonTexts(stub)).toEqual(["Plan", "Implement"]);
    const url = getWebAppUrlByButtonText(stub, "Plan");
    expect(url).toBeTruthy();
    expect(getCallbackDataByButtonText(stub, "Implement")).toBe(TOPIC_IMPLEMENT_CALLBACK_DATA);
    const encoded = getEncodedMiniAppArtifactFromHash(new URL(url!).hash);
    expect(encoded).toBeTruthy();
    expect(decodeMiniAppArtifact(encoded!)).toEqual({
      v: 1,
      type: MiniAppArtifactType.Plan,
      title: "Plan",
      markdownText: "1. Draft the rollout"
    });
  });

  it("attaches response and commentary Mini App buttons to the final answer when assistant output follows", async () => {
    const telegram = new FakeTelegram();
    const coordinator = new TurnLifecycleCoordinator({
      runtime: new BridgeTurnRuntime(),
      messenger: new TelegramMessenger(telegram),
      telegram,
      planArtifactPublicUrl: "https://example.com/mini-app",
      releaseTurnFiles: async () => undefined,
      resolveTurnSnapshot: async () => ({
        text: "Final answer",
        assistantText: "Final answer",
        planText: "",
        changedFiles: 0,
        cwd: "/workspace",
        branch: "main"
      }),
      syncQueuePreview: async () => undefined,
      maybeSendNextQueuedFollowUp: async () => undefined,
      submitQueuedFollowUp: async () => undefined
    });

    coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");
    await coordinator.handleItemStarted("turn-1", {
      type: "agentMessage",
      id: "item-1",
      text: "",
      phase: "commentary"
    });
    await coordinator.handleAssistantDelta("turn-1", "item-1", "Inspecting the rollout plan");
    await coordinator.handleItemCompleted("turn-1", {
      type: "agentMessage",
      id: "item-1",
      text: "Inspecting the rollout plan",
      phase: "commentary"
    });
    await coordinator.completeTurn("thread-1", "turn-1");

    expect(telegram.sentMessages.some((entry) => entry.text.startsWith("Commentary"))).toBe(false);
    const finalAnswer = telegram.sentMessages.find((entry) => entry.text === "Final answer");
    expect(getInlineButtonTexts(finalAnswer)).toEqual(["Response", "Commentary"]);
    const responseUrl = getWebAppUrlByButtonText(finalAnswer, "Response");
    const responseEncoded = getEncodedMiniAppArtifactFromHash(new URL(responseUrl!).hash);
    expect(decodeMiniAppArtifact(responseEncoded!)).toEqual({
      v: 1,
      type: MiniAppArtifactType.Response,
      title: "Response",
      markdownText: "Final answer"
    });
    const url = getWebAppUrlByButtonText(finalAnswer, "Commentary");
    const encoded = getEncodedMiniAppArtifactFromHash(new URL(url!).hash);
    expect(decodeMiniAppArtifact(encoded!)).toEqual({
      v: 1,
      type: MiniAppArtifactType.Commentary,
      title: "Commentary",
      markdownText: "## Activity Log\n\n**Commentary**\n\nInspecting the rollout plan"
    });
  });

  it("publishes a standalone commentary stub before plan output when no assistant answer follows", async () => {
    const telegram = new FakeTelegram();
    const coordinator = new TurnLifecycleCoordinator({
      runtime: new BridgeTurnRuntime(),
      messenger: new TelegramMessenger(telegram),
      telegram,
      planArtifactPublicUrl: "https://example.com/mini-app",
      releaseTurnFiles: async () => undefined,
      resolveTurnSnapshot: async () => ({
        text: "1. Draft the rollout",
        assistantText: "",
        planText: "1. Draft the rollout",
        changedFiles: 0,
        cwd: "/workspace",
        branch: "main"
      }),
      syncQueuePreview: async () => undefined,
      maybeSendNextQueuedFollowUp: async () => undefined,
      submitQueuedFollowUp: async () => undefined
    });

    coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");
    await coordinator.handleItemStarted("turn-1", {
      type: "agentMessage",
      id: "item-1",
      text: "",
      phase: "commentary"
    });
    await coordinator.handleAssistantDelta("turn-1", "item-1", "Inspecting the rollout plan");
    await coordinator.handleItemCompleted("turn-1", {
      type: "agentMessage",
      id: "item-1",
      text: "Inspecting the rollout plan",
      phase: "commentary"
    });
    await coordinator.handleItemStarted("turn-1", {
      type: "plan",
      id: "plan-1",
      text: ""
    });
    await coordinator.handleItemCompleted("turn-1", {
      type: "plan",
      id: "plan-1",
      text: "1. Draft the rollout"
    });
    await coordinator.completeTurn("thread-1", "turn-1");

    const stub = telegram.sentMessages.find((entry) => entry.text === "Commentary is available.");
    expect(getInlineButtonTexts(stub)).toEqual(["Commentary"]);
    const url = getWebAppUrlByButtonText(stub, "Commentary");
    const encoded = getEncodedMiniAppArtifactFromHash(new URL(url!).hash);
    expect(decodeMiniAppArtifact(encoded!)).toEqual({
      v: 1,
      type: MiniAppArtifactType.Commentary,
      title: "Commentary",
      markdownText: "## Activity Log\n\n**Commentary**\n\nInspecting the rollout plan"
    });
    expect(
      telegram.sentMessages.findIndex((entry) => entry.text === "Commentary is available.")
    ).toBeLessThan(telegram.sentMessages.findIndex((entry) => entry.text.startsWith("Plan")));
  });

  it("publishes oversized commentary as a stub before the final answer", async () => {
    const telegram = new FakeTelegram();
    const commentaryText = "Inspecting the rollout plan";
    const coordinator = new TurnLifecycleCoordinator({
      runtime: new BridgeTurnRuntime(),
      messenger: new TelegramMessenger(telegram),
      telegram,
      planArtifactPublicUrl: `https://example.com/${"mini-app/".repeat(1_500)}`,
      releaseTurnFiles: async () => undefined,
      resolveTurnSnapshot: async () => ({
        text: "Final answer",
        assistantText: "Final answer",
        planText: "",
        changedFiles: 0,
        cwd: "/workspace",
        branch: "main"
      }),
      syncQueuePreview: async () => undefined,
      maybeSendNextQueuedFollowUp: async () => undefined,
      submitQueuedFollowUp: async () => undefined
    });

    coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");
    await coordinator.handleItemStarted("turn-1", {
      type: "agentMessage",
      id: "item-1",
      text: "",
      phase: "commentary"
    });
    await coordinator.handleAssistantDelta("turn-1", "item-1", commentaryText);
    await coordinator.handleItemCompleted("turn-1", {
      type: "agentMessage",
      id: "item-1",
      text: commentaryText,
      phase: "commentary"
    });
    await coordinator.completeTurn("thread-1", "turn-1");

    expect(
      telegram.sentMessages.find((entry) => entry.text === "Commentary artifact was too large to encode.")
    ).toBeTruthy();
    expect(
      telegram.sentMessages.findIndex((entry) => entry.text === "Commentary artifact was too large to encode.")
    ).toBeLessThan(telegram.sentMessages.findIndex((entry) => entry.text === "Final answer"));
  });

  it("interleaves commentary with chronological activity events in the artifact", async () => {
    const telegram = new FakeTelegram();
    const coordinator = new TurnLifecycleCoordinator({
      runtime: new BridgeTurnRuntime(),
      messenger: new TelegramMessenger(telegram),
      telegram,
      planArtifactPublicUrl: "https://example.com/mini-app",
      releaseTurnFiles: async () => undefined,
      resolveTurnSnapshot: async () => ({
        text: "Final answer",
        assistantText: "Final answer",
        planText: "",
        changedFiles: 0,
        cwd: "/workspace",
        branch: "main"
      }),
      syncQueuePreview: async () => undefined,
      maybeSendNextQueuedFollowUp: async () => undefined,
      submitQueuedFollowUp: async () => undefined
    });

    coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");
    await coordinator.handleItemStarted("turn-1", {
      type: "agentMessage",
      id: "commentary-1",
      text: "",
      phase: "commentary"
    });
    await coordinator.handleAssistantDelta("turn-1", "commentary-1", "Inspecting the rollout plan.");
    await coordinator.handleItemStarted("turn-1", {
      type: "commandExecution",
      id: "cmd-1",
      command: "npm test",
      cwd: "/workspace",
      processId: null,
      status: "inProgress",
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null
    });
    await coordinator.handleItemCompleted("turn-1", {
      type: "commandExecution",
      id: "cmd-1",
      command: "npm test",
      cwd: "/workspace",
      processId: null,
      status: "completed",
      commandActions: [],
      aggregatedOutput: "ok",
      exitCode: 0,
      durationMs: 120
    });
    await coordinator.handleItemCompleted("turn-1", {
      type: "agentMessage",
      id: "commentary-1",
      text: "Inspecting the rollout plan.",
      phase: "commentary"
    });
    await coordinator.completeTurn("thread-1", "turn-1");

    const finalAnswer = telegram.sentMessages.find((entry) => entry.text === "Final answer");
    const url = getWebAppUrlByButtonText(finalAnswer, "Commentary");
    const encoded = getEncodedMiniAppArtifactFromHash(new URL(url!).hash);
    expect(decodeMiniAppArtifact(encoded!)).toEqual({
      v: 1,
      type: MiniAppArtifactType.Commentary,
      title: "Commentary",
      markdownText:
        "## Activity Log\n\n**Commentary**\n\nInspecting the rollout plan.\n\n- **Command Started:** `npm test`\n\n- **Command Completed:** `npm test`"
    });
  });

  it("publishes a non-blocking notice when the response artifact is too large to encode", async () => {
    const telegram = new FakeTelegram();
    const finalAnswer = longText("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu", 90);
    const coordinator = new TurnLifecycleCoordinator({
      runtime: new BridgeTurnRuntime(),
      messenger: new TelegramMessenger(telegram),
      telegram,
      planArtifactPublicUrl: `https://example.com/${"mini-app/".repeat(1_500)}`,
      releaseTurnFiles: async () => undefined,
      resolveTurnSnapshot: async () => ({
        text: finalAnswer,
        assistantText: finalAnswer,
        planText: "",
        changedFiles: 0,
        cwd: "/workspace",
        branch: "main"
      }),
      syncQueuePreview: async () => undefined,
      maybeSendNextQueuedFollowUp: async () => undefined,
      submitQueuedFollowUp: async () => undefined
    });

    coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");
    await coordinator.completeTurn("thread-1", "turn-1");

    const publishedAnswer = telegram.sentMessages.find((entry) => entry.text.includes("[response truncated]"));
    expect(publishedAnswer).toBeTruthy();
    expect(getInlineButtonTexts(publishedAnswer)).toEqual([]);
    expect(telegram.sentMessages.some((entry) => entry.text === "Response artifact was too large to encode.")).toBe(true);
  });

  it("submits merged pending steers when an interrupted turn is finalized with send-now intent", async () => {
    const harness = createHarness("");
    const context = harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");

    harness.coordinator.queuePendingSteer("turn-1", message("First steer", 2));
    harness.coordinator.queuePendingSteer("turn-1", message("Second steer", 3));
    harness.coordinator.requestPendingSteerSubmissionAfterInterrupt("turn-1");

    await harness.coordinator.finalizeInterruptedTurnById("thread-1", "turn-1");

    expect(context.phase).toBe("interrupted");
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
      expect(harness.telegram.drafts.at(-1)?.text).toBe("running · 2s\n\nnpm test");
      expect(harness.telegram.drafts.at(-1)?.options?.entities).toEqual([
        {
          type: "blockquote",
          offset: "running · 2s\n\n".length,
          length: "npm test".length
        }
      ]);

      await vi.advanceTimersByTimeAsync(1000);
      expect(harness.telegram.drafts.at(-1)?.text).toBe("running · 3s\n\nnpm test");

      await harness.coordinator.completeTurn("thread-1", "turn-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces reasoning summaries in the status draft and preserves them across elapsed-time refreshes", async () => {
    vi.useFakeTimers();

    try {
      const harness = createHarness();
      harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");
      await harness.coordinator.publishCurrentStatus("turn-1", true);

      await harness.coordinator.handleReasoningDelta("turn-1", "reasoning-1", 0, "Inspect the current");
      await harness.coordinator.handleReasoningDelta("turn-1", "reasoning-1", 0, " status pipeline.");

      expect(harness.telegram.drafts.at(-1)?.text).toBe("thinking · 0s\n\nInspect the current status pipeline.");
      expect(harness.telegram.drafts.at(-1)?.options?.entities).toEqual([
        {
          type: "blockquote",
          offset: "thinking · 0s\n\n".length,
          length: "Inspect the current status pipeline.".length
        }
      ]);

      await vi.advanceTimersByTimeAsync(3000);
      expect(harness.telegram.drafts.at(-1)?.text).toBe("thinking · 3s\n\nInspect the current status pipeline.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the surfaced reasoning summary when a new summary index starts", async () => {
    const harness = createHarness();
    harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");

    await harness.coordinator.handleReasoningDelta("turn-1", "reasoning-1", 0, "First summary.");
    await harness.coordinator.handleReasoningDelta("turn-1", "reasoning-1", 1, "Second summary.");

    expect(harness.telegram.drafts.at(-1)?.text).toBe("thinking · 0s\n\nSecond summary.");
  });

  it("surfaces raw reasoning deltas when no reasoning summary is available", async () => {
    const harness = createHarness();
    harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");

    await harness.coordinator.handleReasoningTextDelta("turn-1", "reasoning-1", "**Inspect current renderer**");

    expect(harness.telegram.drafts.at(-1)?.text).toBe("thinking · 0s\n\nInspect current renderer");
    expect(harness.telegram.drafts.at(-1)?.options?.entities).toEqual([
      {
        type: "blockquote",
        offset: "thinking · 0s\n\n".length,
        length: "Inspect current renderer".length
      }
    ]);
  });

  it("prefers reasoning summaries over raw reasoning fallback previews", async () => {
    const harness = createHarness();
    harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");

    await harness.coordinator.handleReasoningTextDelta("turn-1", "reasoning-1", "**Inspect current renderer**");
    await harness.coordinator.handleReasoningDelta("turn-1", "reasoning-1", 0, "Use the summary instead.");
    await harness.coordinator.handleReasoningTextDelta("turn-1", "reasoning-1", " Additional raw detail.");

    expect(harness.telegram.drafts.at(-1)?.text).toBe("thinking · 0s\n\nUse the summary instead.");
  });

  it("keeps successful command and file completions transient", async () => {
    const harness = createHarness();
    harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");

    await harness.coordinator.handleItemCompleted("turn-1", {
      type: "commandExecution",
      id: "cmd-1",
      command: "npm test",
      cwd: "/workspace",
      processId: null,
      status: "completed",
      commandActions: [],
      aggregatedOutput: "ok",
      exitCode: 0,
      durationMs: 123
    });
    await harness.coordinator.handleItemCompleted("turn-1", {
      type: "fileChange",
      id: "patch-1",
      status: "completed",
      changes: [
        { path: "src/app.ts", kind: { type: "update", move_path: null }, diff: "" },
        { path: "src/server.ts", kind: { type: "update", move_path: null }, diff: "" }
      ]
    });

    expect(harness.telegram.sentMessages).toEqual([]);
    expect(harness.telegram.drafts.at(-2)).toMatchObject({
      text: "done · 0s\n\nnpm test",
      options: {
        entities: [
          {
            type: "blockquote",
            offset: "done · 0s\n\n".length,
            length: "npm test".length
          }
        ]
      }
    });
    expect(harness.telegram.drafts.at(-1)).toMatchObject({
      text: "done · 0s\n\nsrc/app.ts, src/server.ts",
      options: {
        entities: [
          {
            type: "blockquote",
            offset: "done · 0s\n\n".length,
            length: "src/app.ts, src/server.ts".length
          }
        ]
      }
    });
  });

  it("keeps successful item completions transient but still publishes failures durably", async () => {
    const harness = createHarness();
    harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");

    await harness.coordinator.handleItemCompleted("turn-1", {
      type: "mcpToolCall",
      id: "mcp-1",
      server: "github",
      tool: "search",
      status: "completed",
      arguments: {},
      result: null,
      error: null,
      durationMs: 10
    });
    await harness.coordinator.handleItemCompleted("turn-1", {
      type: "dynamicToolCall",
      id: "tool-1",
      tool: "lookup_docs",
      arguments: {},
      status: "failed",
      contentItems: null,
      success: false,
      durationMs: 10
    });
    await harness.coordinator.handleItemCompleted("turn-1", {
      type: "collabAgentToolCall",
      id: "agent-1",
      tool: "spawnAgent",
      status: "completed",
      senderThreadId: "thread-1",
      receiverThreadIds: ["thread-2"],
      prompt: null,
      model: null,
      reasoningEffort: null,
      agentsStates: {}
    });
    await harness.coordinator.handleItemCompleted("turn-1", {
      type: "webSearch",
      id: "search-1",
      query: "kirbot issues",
      action: null
    });
    await harness.coordinator.handleItemCompleted("turn-1", {
      type: "imageView",
      id: "image-1",
      path: "/tmp/screenshots/error.png"
    });
    await harness.coordinator.handleItemCompleted("turn-1", {
      type: "imageGeneration",
      id: "image-gen-1",
      status: "completed",
      revisedPrompt: null,
      result: "https://example.com/image.png"
    });
    await harness.coordinator.handleItemCompleted("turn-1", {
      type: "enteredReviewMode",
      id: "review-1",
      review: "Security review"
    });
    await harness.coordinator.handleItemCompleted("turn-1", {
      type: "exitedReviewMode",
      id: "review-2",
      review: ""
    });
    await harness.coordinator.handleItemCompleted("turn-1", {
      type: "contextCompaction",
      id: "compact-1"
    });
    await harness.coordinator.handleItemCompleted("turn-1", {
      type: "contextCompaction",
      id: "compact-2"
    });

    expect(harness.telegram.sentMessages.map((entry) => entry.text)).toEqual(["Tool failed: lookup_docs"]);
    expect(harness.telegram.drafts.map((entry) => entry.text)).toEqual([
      "done · 0s\n\ngithub.search",
      "done · 0s\n\nspawnAgent",
      "done · 0s\n\nkirbot issues",
      "done · 0s\n\nerror.png",
      "done · 0s\n\nimage generated",
      "done · 0s\n\nreview mode: Security review",
      "done · 0s\n\nexited review mode",
      "done · 0s\n\ncontext compacted"
    ]);
    expect(harness.telegram.drafts[0]?.options?.entities).toEqual([
      {
        type: "blockquote",
        offset: "done · 0s\n\n".length,
        length: "github.search".length
      }
    ]);
    expect(harness.telegram.drafts[3]?.options?.entities).toEqual([
      {
        type: "blockquote",
        offset: "done · 0s\n\n".length,
        length: "error.png".length
      }
    ]);
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
