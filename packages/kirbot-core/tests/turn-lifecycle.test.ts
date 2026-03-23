import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageEntity } from "grammy/types";

vi.mock("node:dns/promises", async () => {
  const actual = await vi.importActual<typeof import("node:dns/promises")>("node:dns/promises");
  return {
    ...actual,
    lookup: vi.fn(actual.lookup)
  };
});

import * as dns from "node:dns/promises";
import type { UserTurnMessage } from "../src/domain";
import { TurnLifecycleCoordinator } from "../src/bridge/turn-lifecycle";
import { decodeMiniAppArtifact, getEncodedMiniAppArtifactFromHash, MiniAppArtifactType } from "../src/mini-app/url";
import {
  buildArtifactReplyMarkup,
  buildCommentaryArtifactButton,
  buildResponseArtifactButton,
  TOPIC_IMPLEMENT_CALLBACK_DATA
} from "../src/bridge/presentation";
import {
  TelegramMessenger,
  type TelegramApi,
  type TelegramCreateForumTopicOptions,
  type TelegramPhotoSendInput
} from "../src/telegram-messenger";
import { BridgeTurnRuntime, type QueueStateSnapshot } from "../src/turn-runtime";
import { TurnFinalizer } from "../src/bridge/turn-finalization";

function longText(paragraph: string, count: number): string {
  return Array.from({ length: count }, () => paragraph).join("\n\n");
}

function message(text: string, updateId = 1, telegramUsername?: string): UserTurnMessage {
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
    ],
    ...(telegramUsername ? { telegramUsername } : {})
  } as UserTurnMessage;
}

function rootMessage(text: string, updateId = 1, telegramUsername?: string): UserTurnMessage {
  return {
    chatId: -1001,
    topicId: null,
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
    ],
    ...(telegramUsername ? { telegramUsername } : {})
  } as UserTurnMessage;
}

function getInlineButtonTexts(entry: { options?: Record<string, unknown> } | undefined): string[] {
  return (
    ((entry?.options?.reply_markup as { inline_keyboard?: Array<Array<{ text?: string }>> } | undefined)?.inline_keyboard
      ?.flat()
      .map((button) => button.text)
      .filter((text): text is string => typeof text === "string")) ?? []
  );
}

function getButtonUrlByButtonText(
  entry: { options?: Record<string, unknown> } | undefined,
  buttonText: string
): string | null {
  return (
    ((entry?.options?.reply_markup as {
      inline_keyboard?: Array<Array<{ text?: string; url?: string }>>;
    } | undefined)
      ?.inline_keyboard?.flat()
      .find((button) => button.text === buttonText)
      ?.url ?? null)
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

function getReplyKeyboardRows(entry: { options?: Record<string, unknown> } | undefined): string[][] {
  return (
    ((entry?.options?.reply_markup as { keyboard?: Array<Array<string>> } | undefined)?.keyboard?.map((row) => [...row])) ?? []
  );
}

function findSingleButtonSafeDualButtonUnsafeMiniAppUrl(): string {
  for (let repeatCount = 300; repeatCount <= 1_500; repeatCount += 25) {
    const publicUrl = `https://example.com/${"mini-app/".repeat(repeatCount)}`;
    const responseButton = buildResponseArtifactButton(publicUrl, "Final answer");
    const commentaryButton = buildCommentaryArtifactButton(publicUrl, [{ kind: "commentary", text: "Inspecting files" }]);

    try {
      buildArtifactReplyMarkup([responseButton]);
      buildArtifactReplyMarkup([commentaryButton]);
    } catch {
      continue;
    }

    try {
      buildArtifactReplyMarkup([responseButton, commentaryButton]);
    } catch (error) {
      if (error instanceof Error && error.message === "mini_app_artifact_too_large") {
        return publicUrl;
      }
    }
  }

  throw new Error("Failed to find a Mini App URL that fits single buttons but not combined buttons");
}

class FakeTelegram implements TelegramApi {
  messageCounter = 0;
  nextSendPhotoError: Error | null = null;
  sentMessages: Array<{ chatId: number; text: string; options?: Record<string, unknown> }> = [];
  sentPhotos: Array<{
    chatId: number;
    photo: Uint8Array;
    options?: {
      message_thread_id?: number;
      disable_notification?: boolean;
      file_name?: string;
      mime_type?: string;
    };
  }> = [];
  drafts: Array<{
    chatId: number;
    draftId: number;
    text: string;
    options?: Record<string, unknown>;
  }> = [];
  edits: Array<{ chatId: number; messageId: number; text: string }> = [];
  deletions: Array<{ chatId: number; messageId: number }> = [];

  async getForumTopicIconStickers(): Promise<Array<{ custom_emoji_id?: string }>> {
    return [];
  }

  async createForumTopic(
    _chatId: number,
    _name: string,
    _options?: TelegramCreateForumTopicOptions
  ): Promise<{ message_thread_id: number; name: string }> {
    throw new Error("Not implemented");
  }

  async sendMessage(
    chatId: number,
    text: string,
    options?: Record<string, unknown>
  ): Promise<{ message_id: number }> {
    this.messageCounter += 1;
    this.sentMessages.push(options ? { chatId, text, options } : { chatId, text });
    this.drafts.push(
      options
        ? {
            chatId,
            draftId: this.messageCounter,
            text,
            options
          }
        : {
            chatId,
            draftId: this.messageCounter,
            text
          }
    );
    return { message_id: this.messageCounter };
  }

  async sendPhoto(input: TelegramPhotoSendInput): Promise<{ message_id: number }> {
    if (this.nextSendPhotoError) {
      const error = this.nextSendPhotoError;
      this.nextSendPhotoError = null;
      throw error;
    }

    this.messageCounter += 1;
    const options = {
      ...(input.topicId !== null && input.topicId !== undefined ? { message_thread_id: input.topicId } : {}),
      ...((input.disableNotification ?? true) ? { disable_notification: true } : {}),
      ...(input.fileName !== null && input.fileName !== undefined ? { file_name: input.fileName } : {}),
      ...(input.mimeType !== null && input.mimeType !== undefined ? { mime_type: input.mimeType } : {})
    };
    this.sentPhotos.push(
      Object.keys(options).length > 0 ? { chatId: input.chatId, photo: input.bytes, options } : { chatId: input.chatId, photo: input.bytes }
    );
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
    options?: Record<string, unknown>
  ): Promise<unknown> {
    this.edits.push({ chatId, messageId, text });
    this.drafts.push({
      chatId,
      draftId: messageId,
      text,
      ...(options ? { options } : {})
    });
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

function createTestMessenger(telegram: TelegramApi): TelegramMessenger {
  return new TelegramMessenger(telegram, console, {
    callbackAnswerSpacingMs: 0,
    visibleSendSpacingMs: 0,
    topicCreateSpacingMs: 0,
    visibleEditSpacingMs: 0,
    chatActionSpacingMs: 0,
    deleteSpacingMs: 0
  });
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
      } = { text: "" },
  options?: {
    buildTopicCommandReplyMarkup?(): Promise<{ keyboard: string[][] } | undefined>;
  }
): {
  coordinator: TurnLifecycleCoordinator;
  runtime: BridgeTurnRuntime;
  telegram: FakeTelegram;
  releasedTurnIds: string[];
  queueSyncs: QueueStateSnapshot[];
  nextQueuedCalls: Array<{ chatId: number; topicId: number | null }>;
  queuedFollowUps: Array<{ chatId: number; topicId: number | null; message: UserTurnMessage }>;
} {
  const telegram = new FakeTelegram();
  const runtime = new BridgeTurnRuntime();
  const releasedTurnIds: string[] = [];
  const queueSyncs: QueueStateSnapshot[] = [];
  const nextQueuedCalls: Array<{ chatId: number; topicId: number | null }> = [];
  const queuedFollowUps: Array<{ chatId: number; topicId: number | null; message: UserTurnMessage }> = [];
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
    messenger: createTestMessenger(telegram),
    telegram,
    planArtifactPublicUrl: "https://example.com/mini-app",
    ...(options?.buildTopicCommandReplyMarkup
      ? { buildTopicCommandReplyMarkup: options.buildTopicCommandReplyMarkup }
      : {}),
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
    runtime,
    telegram,
    releasedTurnIds,
    queueSyncs,
    nextQueuedCalls,
    queuedFollowUps
  };
}

function expectImagePublicationFailureEntry(
  entries: ReturnType<BridgeTurnRuntime["renderActivityLogEntries"]>,
  input: {
    turnId: string;
    itemId: string;
    url: string;
    stage: "invalid_url" | "download" | "validation" | "telegram_send";
  }
): void {
  expect(entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "structuredFailure",
        title: "Generated image publication failed",
        subject: null,
        metadata: expect.arrayContaining([
          expect.objectContaining({
            label: "Turn ID",
            value: input.turnId,
            code: true
          }),
          expect.objectContaining({
            label: "Item ID",
            value: input.itemId,
            code: true
          }),
          expect.objectContaining({
            label: "Stage",
            value: input.stage,
            code: true
          })
        ]),
        detail: expect.objectContaining({
          title: "URL",
          value: input.url,
          style: "quoteBlock"
        })
      })
    ])
  );
}

function expectNoImagePublicationFailureEntries(
  entries: ReturnType<BridgeTurnRuntime["renderActivityLogEntries"]>
): void {
  expect(
    entries.some((entry) => entry.kind === "structuredFailure" && entry.title === "Generated image publication failed")
  ).toBe(false);
}

beforeEach(() => {
  vi.mocked(dns.lookup).mockReset();
  vi.mocked(dns.lookup).mockResolvedValue([
    {
      address: "93.184.216.34",
      family: 4
    }
  ] as Awaited<ReturnType<typeof dns.lookup>>);
});

describe("TurnLifecycleCoordinator", () => {
  it("supports root-surface status drafts without a topic id", async () => {
    const harness = createHarness();

    harness.coordinator.activateTurn(rootMessage("Start"), "thread-root", "turn-root", "gpt-5.4-mini");
    await harness.coordinator.publishCurrentStatus("turn-root", true);

    expect(harness.telegram.drafts[0]?.options?.message_thread_id).toBeUndefined();
  });

  it("preserves the starter telegram username when activating a turn", async () => {
    const harness = createHarness();

    const context = harness.coordinator.activateTurn(
      message("Start", 1, "starter-user"),
      "thread-1",
      "turn-1",
      "gpt-5-codex"
    );

    expect(context).toMatchObject({
      telegramUsername: "starter-user"
    });
  });

  it("keeps queued follow-up usernames when promoting them into a new turn", async () => {
    const harness = createHarness();

    harness.coordinator.activateTurn(message("Start", 1, "starter-user"), "thread-1", "turn-1", "gpt-5-codex");
    const pending = harness.coordinator.queuePendingSteer("turn-1", message("Queued follow-up", 2, "queued-user"));
    expect(pending).not.toBeNull();

    const queueState = harness.coordinator.movePendingSteerToQueued(-1001, 777, pending!.localId);
    expect(queueState.queuedFollowUps[0]).toEqual({
      actorLabel: "User 42",
      text: "Queued follow-up"
    });

    const queuedMessage = harness.coordinator.peekNextQueuedFollowUp(-1001, 777);
    expect(queuedMessage).toMatchObject({
      telegramUsername: "queued-user"
    });

    const promotedContext = harness.coordinator.activateTurn(
      harness.coordinator.shiftNextQueuedFollowUp(-1001, 777)!,
      "thread-2",
      "turn-2",
      "gpt-5-codex"
    );

    expect(promotedContext).toMatchObject({
      telegramUsername: "queued-user"
    });
  });

  it("renders spawn-agent progress in the live status bubble with fallback agent labels", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();

      harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");
      await harness.coordinator.publishCurrentStatus("turn-1", true);
      await harness.coordinator.handleItemStarted("turn-1", {
        type: "collabAgentToolCall",
        id: "agent-1",
        tool: "spawnAgent",
        status: "inProgress",
        senderThreadId: "thread-1",
        receiverThreadIds: ["thread-2", "thread-3"],
        prompt: "Explore the repo",
        model: "gpt-5",
        reasoningEffort: "high",
        agentsStates: {}
      });

      await vi.advanceTimersByTimeAsync(12_000);
      expect(harness.telegram.drafts.at(-1)?.text).toBe(
        "spawning agent · 12s\n\nspawning agent\n- agent 1: pending\n- agent 2: pending"
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders wait progress and brief failures in the live status bubble", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();

      harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");
      await harness.coordinator.publishCurrentStatus("turn-1", true);
      await harness.coordinator.handleItemStarted("turn-1", {
        type: "collabAgentToolCall",
        id: "agent-1",
        tool: "wait",
        status: "inProgress",
        senderThreadId: "thread-1",
        receiverThreadIds: ["thread-2", "thread-3"],
        prompt: null,
        model: null,
        reasoningEffort: null,
        agentsStates: {}
      });

      await vi.advanceTimersByTimeAsync(12_000);
      expect(harness.telegram.drafts.at(-1)?.text).toBe(
        "waiting · 12s\n\nwaiting for 2 agents\n- agent 1: pending\n- agent 2: pending"
      );

      await harness.coordinator.handleItemCompleted("turn-1", {
        type: "collabAgentToolCall",
        id: "agent-1",
        tool: "wait",
        status: "completed",
        senderThreadId: "thread-1",
        receiverThreadIds: ["thread-2", "thread-3"],
        prompt: null,
        model: null,
        reasoningEffort: null,
        agentsStates: {
          "thread-2": {
            status: "completed",
            message: "Done"
          },
          "thread-3": {
            status: "errored",
            message: "timeout while reading"
          }
        }
      });

      await vi.advanceTimersByTimeAsync(12_000);
      expect(harness.telegram.drafts.at(-1)?.text).toBe(
        "waiting · 24s\n\nwaiting for 2 agents\n- agent 1: completed - Done\n- agent 2: failed - timeout while reading"
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("finalizes completed turns through one shared terminal path", async () => {
    const harness = createHarness("Final answer");
    const context = harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");
    await harness.coordinator.publishCurrentStatus("turn-1", true);

    await harness.coordinator.completeTurn("thread-1", "turn-1");

    expect(context.phase).toBe("completed");
    expect(harness.telegram.sentMessages.map((entry) => entry.text)).toEqual([
      "thinking · 0s",
      "Final answer",
      "<1s • 100% left • /workspace • main • gpt-5-codex"
    ]);
    expect(harness.telegram.deletions).toEqual([{ chatId: -1001, messageId: 1 }]);
    expect(harness.telegram.sentMessages.some((entry) => entry.text === "> done")).toBe(false);
    expect(harness.releasedTurnIds).toEqual(["turn-1"]);
    expect(harness.nextQueuedCalls).toEqual([{ chatId: -1001, topicId: 777 }]);
    expect(harness.coordinator.getTurn("turn-1")).toBeUndefined();
  });

  it("retains the status bubble for completed plan-only turns", async () => {
    const harness = createHarness({
      text: "1. Draft the rollout",
      assistantText: "",
      planText: "1. Draft the rollout"
    });

    harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");
    await harness.coordinator.publishCurrentStatus("turn-1", true);
    await harness.coordinator.completeTurn("thread-1", "turn-1");

    expect(harness.telegram.sentMessages.map((entry) => entry.text)).toContain("thinking · 0s");
    expect(harness.telegram.edits.at(-1)?.text).toBe("completed");
    expect(harness.telegram.deletions).toEqual([]);
  });

  it("keeps the status bubble for interrupted turns", async () => {
    const harness = createHarness();

    harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");
    await harness.coordinator.publishCurrentStatus("turn-1", true);
    await harness.coordinator.finalizeInterruptedTurnById("thread-1", "turn-1");

    expect(harness.telegram.sentMessages.map((entry) => entry.text)).toContain("thinking · 0s");
    expect(harness.telegram.edits.at(-1)?.text).toBe("interrupted");
    expect(harness.telegram.deletions).toEqual([]);
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
      messenger: createTestMessenger(telegram),
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
    const url = getButtonUrlByButtonText(stub, "Plan");
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
      messenger: createTestMessenger(telegram),
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
    expect(finalAnswer?.options?.disable_notification).toBeUndefined();
    expect(getInlineButtonTexts(finalAnswer)).toEqual(["Response", "Commentary"]);
    const responseUrl = getButtonUrlByButtonText(finalAnswer, "Response");
    const responseEncoded = getEncodedMiniAppArtifactFromHash(new URL(responseUrl!).hash);
    expect(decodeMiniAppArtifact(responseEncoded!)).toEqual({
      v: 1,
      type: MiniAppArtifactType.Response,
      title: "Response",
      markdownText: "Final answer"
    });
    const url = getButtonUrlByButtonText(finalAnswer, "Commentary");
    const encoded = getEncodedMiniAppArtifactFromHash(new URL(url!).hash);
    expect(decodeMiniAppArtifact(encoded!)).toEqual({
      v: 1,
      type: MiniAppArtifactType.Commentary,
      title: "Commentary",
      markdownText: "Inspecting the rollout plan"
    });
  });

  it("mentions the turn starter on the final assistant reply even when commentary would otherwise publish earlier", async () => {
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

    coordinator.activateTurn(message("Start", 1, "starter-user"), "thread-1", "turn-1", "gpt-5-codex");
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

    expect(telegram.sentMessages.find((entry) => entry.text === "@starter-user Final answer")).toBeTruthy();
    expect(telegram.sentMessages.some((entry) => entry.text.startsWith("@starter-user Commentary"))).toBe(false);
    expect(telegram.sentMessages.at(-1)?.text).toBe("<1s • 100% left • /workspace • main • gpt-5-codex");
  });

  it("mentions the first standalone commentary publication when no final assistant reply exists", async () => {
    const telegram = new FakeTelegram();
    const coordinator = new TurnLifecycleCoordinator({
      runtime: new BridgeTurnRuntime(),
      messenger: new TelegramMessenger(telegram),
      telegram,
      planArtifactPublicUrl: "https://example.com/mini-app",
      releaseTurnFiles: async () => undefined,
      resolveTurnSnapshot: async () => ({
        text: "",
        assistantText: "",
        planText: "",
        changedFiles: 0,
        cwd: "/workspace",
        branch: "main"
      }),
      syncQueuePreview: async () => undefined,
      maybeSendNextQueuedFollowUp: async () => undefined,
      submitQueuedFollowUp: async () => undefined
    });

    coordinator.activateTurn(message("Start", 1, "starter-user"), "thread-1", "turn-1", "gpt-5-codex");
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
    await coordinator.finalizeInterruptedTurnById("thread-1", "turn-1");

    const commentaryStub = telegram.sentMessages.find((entry) => entry.text.startsWith("@starter-user Commentary"));
    expect(commentaryStub?.text).toBe("@starter-user Commentary is available");
    expect(commentaryStub?.options?.disable_notification).toBeUndefined();
  });

  it("mentions the first standalone response publication when the final assistant reply cannot be published", async () => {
    const commentarySpy = vi.spyOn(TurnFinalizer.prototype as any, "buildCommentaryPublication").mockReturnValue({
      attachedButton: null,
      standaloneMessages: [
        { text: "Commentary is available", replyMarkup: buildArtifactReplyMarkup([buildCommentaryArtifactButton("https://example.com/mini-app", [{ kind: "commentary", text: "Inspecting files" }])]) },
        { text: "Commentary is available (2/2)", replyMarkup: buildArtifactReplyMarkup([buildCommentaryArtifactButton("https://example.com/mini-app", [{ kind: "commentary", text: "Inspecting files 2" }])]) }
      ],
      oversizeNoticeText: null
    });
    const responseSpy = vi.spyOn(TurnFinalizer.prototype as any, "buildResponsePublication").mockReturnValue({
      attachedButton: null,
      standaloneMessages: [
        { text: "Response is available", replyMarkup: buildArtifactReplyMarkup([buildResponseArtifactButton("https://example.com/mini-app", "Final answer")]) },
        { text: "Response is available (2/2)", replyMarkup: buildArtifactReplyMarkup([buildResponseArtifactButton("https://example.com/mini-app", "Final answer 2")]) }
      ],
      oversizeNoticeText: null
    });
    try {
      const harness = createHarness("Final answer");
      const context = harness.coordinator.activateTurn(
        message("Start", 1, "starter-user"),
        "thread-1",
        "turn-1",
        "gpt-5-codex"
      );
      const originalSurface = context.visibleMessageHandle;
      context.visibleMessageHandle = {
        ...originalSurface,
        publishFinalAssistantMessage: async () => null
      };

      await harness.coordinator.completeTurn("thread-1", "turn-1");

      const commentaryMessages = harness.telegram.sentMessages.filter((entry) => entry.text.includes("Commentary"));
      const responseMessages = harness.telegram.sentMessages.filter((entry) => entry.text.includes("Response"));
      expect(commentaryMessages[0]?.text.startsWith("@starter-user Commentary")).toBe(true);
      expect(commentaryMessages.slice(1).every((entry) => !entry.text.startsWith("@starter-user "))).toBe(true);
      expect(responseMessages.every((entry) => !entry.text.startsWith("@starter-user "))).toBe(true);
    } finally {
      commentarySpy.mockRestore();
      responseSpy.mockRestore();
    }
  });

  it("does not let a commentary oversize notice outrank standalone response publication", async () => {
    const commentarySpy = vi.spyOn(TurnFinalizer.prototype as any, "buildCommentaryPublication").mockReturnValue({
      attachedButton: null,
      standaloneMessages: [],
      oversizeNoticeText: "Commentary artifact was too large to encode"
    });
    const responseSpy = vi.spyOn(TurnFinalizer.prototype as any, "buildResponsePublication").mockReturnValue({
      attachedButton: null,
      standaloneMessages: [
        { text: "Response is available", replyMarkup: buildArtifactReplyMarkup([buildResponseArtifactButton("https://example.com/mini-app", "Final answer")]) },
        { text: "Response is available (2/2)", replyMarkup: buildArtifactReplyMarkup([buildResponseArtifactButton("https://example.com/mini-app", "Final answer 2")]) }
      ],
      oversizeNoticeText: null
    });
    try {
      const harness = createHarness("Final answer");
      const context = harness.coordinator.activateTurn(
        message("Start", 1, "starter-user"),
        "thread-1",
        "turn-1",
        "gpt-5-codex"
      );
      const originalSurface = context.visibleMessageHandle;
      context.visibleMessageHandle = {
        ...originalSurface,
        publishFinalAssistantMessage: async () => null
      };

      await harness.coordinator.completeTurn("thread-1", "turn-1");

      expect(
        harness.telegram.sentMessages.find((entry) => entry.text === "Commentary artifact was too large to encode")
      ).toBeTruthy();
      const responseMessages = harness.telegram.sentMessages.filter((entry) => entry.text.includes("Response"));
      expect(responseMessages[0]?.text.startsWith("@starter-user Response")).toBe(true);
      expect(responseMessages.slice(1).every((entry) => !entry.text.startsWith("@starter-user "))).toBe(true);
    } finally {
      commentarySpy.mockRestore();
      responseSpy.mockRestore();
    }
  });

  it("mentions the first standalone plan publication when no higher-precedence completion message exists", async () => {
    const harness = createHarness({
      text: "1. Draft the rollout",
      assistantText: "",
      planText: "1. Draft the rollout"
    });

    harness.coordinator.activateTurn(message("Start", 1, "starter-user"), "thread-1", "turn-1", "gpt-5-codex");
    await harness.coordinator.completeTurn("thread-1", "turn-1");

    const planStub = harness.telegram.sentMessages.find((entry) => entry.text.startsWith("@starter-user Plan"));
    expect(planStub?.text).toBe("@starter-user Plan is ready");
    expect(planStub?.options?.disable_notification).toBeUndefined();
  });

  it("leaves silent status bubble text unchanged and keeps messages unprefixed when no telegram username exists", async () => {
    const harness = createHarness("Final answer");
    harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");
    await harness.coordinator.publishCurrentStatus("turn-1", true);
    await harness.coordinator.completeTurn("thread-1", "turn-1");

    expect(harness.telegram.drafts[0]?.text).toBe("thinking · 0s");
    expect(harness.telegram.sentMessages[1]?.text).toBe("Final answer");
    expect(harness.telegram.sentMessages.some((entry) => entry.text.startsWith("@"))).toBe(false);
  });

  it("publishes a standalone commentary stub before plan output when no assistant answer follows", async () => {
    const telegram = new FakeTelegram();
    const coordinator = new TurnLifecycleCoordinator({
      runtime: new BridgeTurnRuntime(),
      messenger: createTestMessenger(telegram),
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

    const stub = telegram.sentMessages.find((entry) => entry.text === "Commentary is available");
    expect(stub?.options?.disable_notification).toBeUndefined();
    expect(getInlineButtonTexts(stub)).toEqual(["Commentary"]);
    const url = getButtonUrlByButtonText(stub, "Commentary");
    const encoded = getEncodedMiniAppArtifactFromHash(new URL(url!).hash);
    expect(decodeMiniAppArtifact(encoded!)).toEqual({
      v: 1,
      type: MiniAppArtifactType.Commentary,
      title: "Commentary",
      markdownText: "Inspecting the rollout plan"
    });
    expect(
      telegram.sentMessages.findIndex((entry) => entry.text === "Commentary is available")
    ).toBeLessThan(telegram.sentMessages.findIndex((entry) => entry.text.startsWith("Plan")));
  });

  it("publishes oversized commentary as a stub before the final answer", async () => {
    const telegram = new FakeTelegram();
    const commentaryText = "Inspecting the rollout plan";
    const coordinator = new TurnLifecycleCoordinator({
      runtime: new BridgeTurnRuntime(),
      messenger: createTestMessenger(telegram),
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
      telegram.sentMessages.find((entry) => entry.text === "Commentary artifact was too large to encode")
    ).toBeTruthy();
    expect(
      telegram.sentMessages.findIndex((entry) => entry.text === "Commentary artifact was too large to encode")
    ).toBeLessThan(telegram.sentMessages.findIndex((entry) => entry.text === "Final answer"));
  });

  it("falls back to a standalone commentary stub when response and commentary buttons exceed the combined markup budget", async () => {
    const telegram = new FakeTelegram();
    const coordinator = new TurnLifecycleCoordinator({
      runtime: new BridgeTurnRuntime(),
      messenger: createTestMessenger(telegram),
      telegram,
      planArtifactPublicUrl: findSingleButtonSafeDualButtonUnsafeMiniAppUrl(),
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
    await coordinator.handleAssistantDelta("turn-1", "item-1", "Inspecting files");
    await coordinator.handleItemCompleted("turn-1", {
      type: "agentMessage",
      id: "item-1",
      text: "Inspecting files",
      phase: "commentary"
    });
    await coordinator.completeTurn("thread-1", "turn-1");

    const finalAnswer = telegram.sentMessages.find((entry) => entry.text === "Final answer");
    expect(finalAnswer?.options?.disable_notification).toBeUndefined();
    expect(getInlineButtonTexts(finalAnswer)).toEqual(["Response"]);

    const commentaryStub = telegram.sentMessages.find((entry) => entry.text === "Commentary is available");
    expect(commentaryStub?.options?.disable_notification).toBe(true);
    expect(getInlineButtonTexts(commentaryStub)).toEqual(["Commentary"]);
    expect(
      telegram.sentMessages.findIndex((entry) => entry.text === "Final answer")
    ).toBeLessThan(telegram.sentMessages.findIndex((entry) => entry.text === "Commentary is available"));
  });

  it("interleaves commentary with chronological activity events in the artifact", async () => {
    const telegram = new FakeTelegram();
    const coordinator = new TurnLifecycleCoordinator({
      runtime: new BridgeTurnRuntime(),
      messenger: createTestMessenger(telegram),
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

    const finalAnswer = telegram.drafts.findLast((entry) => entry.text === "Final answer");
    const url = getButtonUrlByButtonText(finalAnswer, "Commentary");
    const encoded = getEncodedMiniAppArtifactFromHash(new URL(url!).hash);
    expect(decodeMiniAppArtifact(encoded!)).toEqual({
      v: 1,
      type: MiniAppArtifactType.Commentary,
      title: "Commentary",
      markdownText:
        "Inspecting the rollout plan.\n\n:::details Logs (1)\n- **Command**\n```\nnpm test\n```\n:::"
    });
  });

  it("publishes a non-blocking notice when the response artifact is too large to encode", async () => {
    const telegram = new FakeTelegram();
    const finalAnswer = longText("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu", 90);
    const coordinator = new TurnLifecycleCoordinator({
      runtime: new BridgeTurnRuntime(),
      messenger: createTestMessenger(telegram),
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
    expect(telegram.sentMessages.some((entry) => entry.text === "Response artifact was too large to encode")).toBe(true);
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

  it("keeps elapsed time anchored to the turn start when throttled status updates publish", async () => {
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
      expect(harness.coordinator.getTurn("turn-1")?.statusDraft?.state).toBe("running");
      expect(harness.telegram.drafts.at(-1)?.text).toBe("thinking · 0s");
      expect(harness.telegram.drafts.at(-1)?.options?.entities).toBeUndefined();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(harness.telegram.drafts.at(-1)?.text).toBe("running · 12s");

      await harness.coordinator.completeTurn("thread-1", "turn-1");
    } finally {
      vi.useRealTimers();
    }
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
  });

  it("treats successful transient completions as a status-draft no-op", async () => {
    vi.useFakeTimers();

    try {
      const harness = createHarness();
      harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");
      await harness.coordinator.publishCurrentStatus("turn-1", true);

      await vi.advanceTimersByTimeAsync(2000);
      await harness.coordinator.handleItemStarted("turn-1", {
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

      expect(harness.coordinator.getTurn("turn-1")?.statusDraft?.state).toBe("running");
      expect(harness.telegram.drafts.at(-1)?.text).toBe("thinking · 0s");
      const draftCountBeforeCompletion = harness.telegram.drafts.length;

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

      expect(harness.telegram.drafts).toHaveLength(draftCountBeforeCompletion);
      expect(harness.coordinator.getTurn("turn-1")?.statusDraft?.state).toBe("running");
      expect(harness.telegram.drafts.at(-1)?.text).toBe("thinking · 0s");

      await harness.coordinator.completeTurn("thread-1", "turn-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces successful collab completions in the status bubble while keeping other successful items transient", async () => {
    const harness = createHarness();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1]), {
        headers: {
          "Content-Type": "image/png"
        }
      })
    );
    harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");
    try {
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
    } finally {
      fetchSpy.mockRestore();
    }
    await harness.coordinator.handleItemCompleted("turn-1", {
      type: "contextCompaction",
      id: "compact-2"
    });

    expect(harness.telegram.sentMessages).toEqual([
      {
        chatId: -1001,
        text: "spawning agent · 0s\n\nspawning agent\n- agent 1: pending",
        options: {
          disable_notification: true,
          message_thread_id: 777
        }
      },
      {
        chatId: -1001,
        text: "Context compacted",
        options: {
          disable_notification: true,
          message_thread_id: 777
        }
      }
    ]);
    expect(harness.telegram.sentPhotos).toEqual([
      {
        chatId: -1001,
        photo: new Uint8Array([1]),
        options: {
          message_thread_id: 777,
          disable_notification: true,
          file_name: "image.png",
          mime_type: "image/png"
        }
      }
    ]);
    expect(harness.telegram.drafts).toEqual([
      {
        chatId: -1001,
        draftId: 1,
        text: "spawning agent · 0s\n\nspawning agent\n- agent 1: pending",
        options: {
          disable_notification: true,
          message_thread_id: 777
        }
      },
      {
        chatId: -1001,
        draftId: 3,
        text: "Context compacted",
        options: {
          disable_notification: true,
          message_thread_id: 777
        }
      }
    ]);
  });

  it("publishes a successful generated image immediately before turn completion", async () => {
    const harness = createHarness("Final answer");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          "Content-Type": "image/png"
        }
      })
    );

    try {
      harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");

      await harness.coordinator.handleItemCompleted("turn-1", {
        type: "imageGeneration",
        id: "image-gen-1",
        status: "completed",
        revisedPrompt: null,
        result: "https://example.com/generated.png"
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://example.com/generated.png");
      expect(harness.telegram.sentPhotos).toEqual([
        {
          chatId: -1001,
          photo: new Uint8Array([1, 2, 3]),
          options: {
            message_thread_id: 777,
            disable_notification: true,
            file_name: "generated.png",
            mime_type: "image/png"
          }
        }
      ]);
      expect(harness.telegram.sentMessages.some((entry) => entry.text === "Final answer")).toBe(false);
      expectNoImagePublicationFailureEntries(harness.runtime.renderActivityLogEntries("turn-1"));
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("does not publish cancelled image generation items inline", async () => {
    const harness = createHarness();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");

      await harness.coordinator.handleItemCompleted("turn-1", {
        type: "imageGeneration",
        id: "image-gen-cancelled",
        status: "cancelled",
        revisedPrompt: null,
        result: "https://example.com/cancelled.png"
      });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(harness.telegram.sentPhotos).toHaveLength(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("records invalid_url image publication failures in the activity log and still finalizes the turn", async () => {
    const harness = createHarness({
      text: "Final answer",
      assistantText: "Final answer"
    });
    const fetchStub = vi.fn(() => {
      throw new Error("fetch should not be called for invalid image URLs");
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchStub as typeof fetch;

    try {
      harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");

      await harness.coordinator.handleItemCompleted("turn-1", {
        type: "imageGeneration",
        id: "image-gen-invalid",
        status: "completed",
        revisedPrompt: null,
        result: "ftp://example.com/generated.png"
      });

      expect(fetchStub).not.toHaveBeenCalled();
      expect(harness.telegram.sentPhotos).toHaveLength(0);
      expectImagePublicationFailureEntry(harness.runtime.renderActivityLogEntries("turn-1"), {
        turnId: "turn-1",
        itemId: "image-gen-invalid",
        stage: "invalid_url",
        url: "ftp://example.com/generated.png"
      });

      await harness.coordinator.completeTurn("thread-1", "turn-1");

      expect(harness.telegram.sentMessages.map((entry) => entry.text)).toContain("Final answer");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("records download failures in the activity log and still finalizes the turn", async () => {
    const harness = createHarness({
      text: "Final answer",
      assistantText: "Final answer"
    });
    const timeoutError = Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError"
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(timeoutError);

    try {
      harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");

      await harness.coordinator.handleItemCompleted("turn-1", {
        type: "imageGeneration",
        id: "image-gen-download",
        status: "completed",
        revisedPrompt: null,
        result: "https://example.com/download-failure.png"
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://example.com/download-failure.png");
      expectImagePublicationFailureEntry(harness.runtime.renderActivityLogEntries("turn-1"), {
        turnId: "turn-1",
        itemId: "image-gen-download",
        stage: "download",
        url: "https://example.com/download-failure.png"
      });
      expect(harness.telegram.sentPhotos).toHaveLength(0);

      await harness.coordinator.completeTurn("thread-1", "turn-1");
      expect(harness.telegram.sentMessages.map((entry) => entry.text)).toContain("Final answer");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("records non-image validation failures in the activity log and still finalizes the turn", async () => {
    const harness = createHarness({
      text: "Final answer",
      assistantText: "Final answer"
    });
    const fetchStub = vi.fn(async () => {
      return new Response("plain text payload", {
        headers: {
          "Content-Type": "text/plain"
        }
      });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchStub as typeof fetch;

    try {
      harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");

      await harness.coordinator.handleItemCompleted("turn-1", {
        type: "imageGeneration",
        id: "image-gen-validation",
        status: "completed",
        revisedPrompt: null,
        result: "https://example.com/not-an-image.txt"
      });

      expect(fetchStub).toHaveBeenCalledTimes(1);
      expect(fetchStub.mock.calls[0]?.[0]).toBe("https://example.com/not-an-image.txt");
      expectImagePublicationFailureEntry(harness.runtime.renderActivityLogEntries("turn-1"), {
        turnId: "turn-1",
        itemId: "image-gen-validation",
        stage: "validation",
        url: "https://example.com/not-an-image.txt"
      });
      expect(harness.telegram.sentPhotos).toHaveLength(0);

      await harness.coordinator.completeTurn("thread-1", "turn-1");
      expect(harness.telegram.sentMessages.map((entry) => entry.text)).toContain("Final answer");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("records Telegram send failures in the activity log and still finalizes the turn", async () => {
    const harness = createHarness({
      text: "Final answer",
      assistantText: "Final answer"
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([9, 8, 7]), {
        headers: {
          "Content-Type": "image/png"
        }
      })
    );
    harness.telegram.nextSendPhotoError = new Error("telegram send failed");

    try {
      harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");

      await harness.coordinator.handleItemCompleted("turn-1", {
        type: "imageGeneration",
        id: "image-gen-telegram",
        status: "completed",
        revisedPrompt: null,
        result: "https://example.com/send-failure.png"
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://example.com/send-failure.png");
      expectImagePublicationFailureEntry(harness.runtime.renderActivityLogEntries("turn-1"), {
        turnId: "turn-1",
        itemId: "image-gen-telegram",
        stage: "telegram_send",
        url: "https://example.com/send-failure.png"
      });
      expect(harness.telegram.sentPhotos).toHaveLength(0);

      await harness.coordinator.completeTurn("thread-1", "turn-1");
      expect(harness.telegram.sentMessages.map((entry) => entry.text)).toContain("Final answer");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("publishes distinct imageGeneration ids even when the same URL is reused", async () => {
    const harness = createHarness();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: {
            "Content-Type": "image/png"
          }
        })
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([4, 5, 6]), {
          headers: {
            "Content-Type": "image/png"
          }
        })
      );

    try {
      harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");

      await harness.coordinator.handleItemCompleted("turn-1", {
        type: "imageGeneration",
        id: "image-gen-1",
        status: "completed",
        revisedPrompt: null,
        result: "https://example.com/duplicate.png"
      });
      await harness.coordinator.handleItemCompleted("turn-1", {
        type: "imageGeneration",
        id: "image-gen-2",
        status: "completed",
        revisedPrompt: null,
        result: "https://example.com/duplicate.png"
      });

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://example.com/duplicate.png");
      expect(fetchSpy.mock.calls[1]?.[0]).toBe("https://example.com/duplicate.png");
      expect(harness.telegram.sentPhotos.map((entry) => Array.from(entry.photo))).toEqual([[1, 2, 3], [4, 5, 6]]);
      expect(harness.telegram.sentPhotos.map((entry) => entry.options)).toEqual([
        expect.objectContaining({
          file_name: "duplicate.png",
          mime_type: "image/png"
        }),
        expect.objectContaining({
          file_name: "duplicate.png",
          mime_type: "image/png"
        })
      ]);
      expectNoImagePublicationFailureEntries(harness.runtime.renderActivityLogEntries("turn-1"));
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("suppresses a replayed imageGeneration id even when the URL changes", async () => {
    const harness = createHarness();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(new Uint8Array([7, 8, 9]), {
          headers: {
            "Content-Type": "image/png"
          }
        })
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 1, 1]), {
          headers: {
            "Content-Type": "image/png"
          }
        })
      );

    try {
      harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");

      await harness.coordinator.handleItemCompleted("turn-1", {
        type: "imageGeneration",
        id: "image-gen-replay",
        status: "completed",
        revisedPrompt: null,
        result: "https://example.com/replay-first.png"
      });
      await harness.coordinator.handleItemCompleted("turn-1", {
        type: "imageGeneration",
        id: "image-gen-replay",
        status: "completed",
        revisedPrompt: null,
        result: "https://example.com/replay-second.png"
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://example.com/replay-first.png");
      expect(harness.telegram.sentPhotos).toHaveLength(1);
      expect(harness.telegram.sentPhotos[0]).toMatchObject({
        photo: new Uint8Array([7, 8, 9]),
        options: expect.objectContaining({
          file_name: "replay-first.png",
          mime_type: "image/png"
        })
      });
      expectNoImagePublicationFailureEntries(harness.runtime.renderActivityLogEntries("turn-1"));
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("retries a replayed imageGeneration id after an earlier publication failure", async () => {
    const harness = createHarness();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("temporary fetch failure"))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([4, 5, 6]), {
          headers: {
            "Content-Type": "image/png"
          }
        })
      );

    try {
      harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");

      await harness.coordinator.handleItemCompleted("turn-1", {
        type: "imageGeneration",
        id: "image-gen-retry",
        status: "completed",
        revisedPrompt: null,
        result: "https://example.com/retry-first.png"
      });
      await harness.coordinator.handleItemCompleted("turn-1", {
        type: "imageGeneration",
        id: "image-gen-retry",
        status: "completed",
        revisedPrompt: null,
        result: "https://example.com/retry-second.png"
      });
      await harness.coordinator.handleItemCompleted("turn-1", {
        type: "imageGeneration",
        id: "image-gen-retry",
        status: "completed",
        revisedPrompt: null,
        result: "https://example.com/retry-third.png"
      });

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://example.com/retry-first.png");
      expect(fetchSpy.mock.calls[1]?.[0]).toBe("https://example.com/retry-second.png");
      expect(harness.telegram.sentPhotos).toHaveLength(1);
      expect(harness.telegram.sentPhotos[0]).toMatchObject({
        photo: new Uint8Array([4, 5, 6]),
        options: expect.objectContaining({
          file_name: "retry-second.png",
          mime_type: "image/png"
        })
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("rejects oversized image payloads as validation failures", async () => {
    const harness = createHarness();
    const oversizedBytes = new Uint8Array(12_000_001);
    const fetchStub = vi.fn(async () => {
      return new Response(oversizedBytes, {
        headers: {
          "Content-Type": "image/png"
        }
      });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchStub as typeof fetch;

    try {
      harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");

      await harness.coordinator.handleItemCompleted("turn-1", {
        type: "imageGeneration",
        id: "image-gen-oversized",
        status: "completed",
        revisedPrompt: null,
        result: "https://example.com/oversized.png"
      });

      expect(fetchStub).toHaveBeenCalledTimes(1);
      expect(fetchStub.mock.calls[0]?.[0]).toBe("https://example.com/oversized.png");
      expectImagePublicationFailureEntry(harness.runtime.renderActivityLogEntries("turn-1"), {
        turnId: "turn-1",
        itemId: "image-gen-oversized",
        stage: "validation",
        url: "https://example.com/oversized.png"
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("publishes multiple generated images in arrival order and still finalizes the turn", async () => {
    const harness = createHarness("Final answer");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1]), {
          headers: {
            "Content-Type": "image/png"
          }
        })
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([2]), {
          headers: {
            "Content-Type": "image/png"
          }
        })
      );

    try {
      harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");

      await harness.coordinator.handleItemCompleted("turn-1", {
        type: "imageGeneration",
        id: "image-gen-1",
        status: "completed",
        revisedPrompt: null,
        result: "https://example.com/one.png"
      });
      await harness.coordinator.handleItemCompleted("turn-1", {
        type: "imageGeneration",
        id: "image-gen-2",
        status: "completed",
        revisedPrompt: null,
        result: "https://example.com/two.png"
      });

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://example.com/one.png");
      expect(fetchSpy.mock.calls[1]?.[0]).toBe("https://example.com/two.png");
      expect(harness.telegram.sentPhotos.map((entry) => Array.from(entry.photo))).toEqual([[1], [2]]);

      await harness.coordinator.completeTurn("thread-1", "turn-1");

      expect(harness.telegram.sentMessages.map((entry) => entry.text)).toContain("Final answer");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("keeps failed command details in commentary without sending a standalone bubble", async () => {
    const harness = createHarness({
      text: "Final answer",
      assistantText: "Final answer"
    });
    harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");

    await harness.coordinator.handleItemCompleted("turn-1", {
      type: "commandExecution",
      id: "cmd-1",
      command: "npm test -- --runInBand",
      cwd: "/workspace/packages/kirbot-core",
      processId: null,
      status: "failed",
      commandActions: [],
      aggregatedOutput: 'FAIL bridge.test.ts\nError: expected "waiting · 6s" to equal "waiting · 5s"',
      exitCode: 1,
      durationMs: 12_000
    });

    expect(harness.telegram.sentMessages).toEqual([]);

    await harness.coordinator.completeTurn("thread-1", "turn-1");

    const finalAnswer = harness.telegram.sentMessages.find((entry) => entry.text === "Final answer");
    expect(finalAnswer).toBeTruthy();
    expect(getInlineButtonTexts(finalAnswer)).toEqual(["Response", "Commentary"]);

    const url = getButtonUrlByButtonText(finalAnswer, "Commentary");
    expect(url).toBeTruthy();
    const encoded = getEncodedMiniAppArtifactFromHash(new URL(url!).hash);
    expect(decodeMiniAppArtifact(encoded!)).toEqual({
      v: 1,
      type: MiniAppArtifactType.Commentary,
      title: "Commentary",
      markdownText:
        ':::details Logs (1)\n**Command failed**\n```\nnpm test -- --runInBand\n```\n\nCWD: `/workspace/packages/kirbot-core`  \nExit code: `1`  \nDuration: `12s`\n\nError\n> FAIL bridge.test.ts\n> Error: expected "waiting · 6s" to equal "waiting · 5s"\n:::'
    });
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
      "<1s • 75% left • 2 files • /home/tester/kirbot • feature/footer • gpt-5 high"
    );
  });

  it("sends the final answer directly before the completion footer", async () => {
    const harness = createHarness({
      text: "Final answer",
      changedFiles: 0,
      cwd: "/workspace",
      branch: "main"
    });

    harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");

    await harness.coordinator.completeTurn("thread-1", "turn-1");

    expect(harness.telegram.sentMessages.at(-2)?.text).toBe("Final answer");
    expect((harness.telegram.sentMessages.at(-2)?.options as Record<string, unknown> | undefined)?.disable_notification).toBeUndefined();
    expect(getInlineButtonTexts(harness.telegram.sentMessages.at(-2))).toEqual(["Response"]);
    expect(harness.telegram.sentMessages.at(-1)?.text).toBe(
      "<1s • 100% left • /workspace • main • gpt-5-codex"
    );
  });

  it("falls back to tracked file-change notifications when the resolved snapshot reports zero files", async () => {
    const harness = createHarness({
      text: "Final answer",
      changedFiles: 0,
      cwd: "/workspace",
      branch: "main"
    });

    harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");
    await harness.coordinator.handleItemStarted("turn-1", {
      type: "fileChange",
      id: "patch-1",
      status: "inProgress",
      changes: [
        { path: "src/app.ts", kind: { type: "update", move_path: null }, diff: "" },
        { path: "src/server.ts", kind: { type: "update", move_path: null }, diff: "" }
      ]
    });

    await harness.coordinator.completeTurn("thread-1", "turn-1");

    expect(harness.telegram.sentMessages.at(-1)?.text).toBe(
      "<1s • 100% left • 2 files • /workspace • main • gpt-5-codex"
    );
  });

  it("adds a plan-mode label to the completion footer for plan turns", async () => {
    const harness = createHarness({
      text: "Plan ready",
      changedFiles: 0,
      cwd: "/workspace",
      branch: "main"
    });

    harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex", null, null, "plan");

    await harness.coordinator.completeTurn("thread-1", "turn-1");

    expect(harness.telegram.sentMessages.at(-2)?.text).toBe("Plan ready");
    expect(harness.telegram.sentMessages.at(-1)?.text).toBe(
      "<1s • 100% left • /workspace • main • gpt-5-codex • planning"
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
      "<1s • 30% left • /workspace • main • gpt-5-codex"
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
      "<1s • 75% left • /workspace • main • gpt-5-codex"
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
      "<1s • 51% left • /workspace • main • gpt-5-codex"
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
      "<1s • 100% left • /workspace • main • gpt-5-codex"
    );
  });

  it("adds the topic command reply keyboard to completion footers when provided", async () => {
    const harness = createHarness("Final answer", {
      buildTopicCommandReplyMarkup: async () => ({
        keyboard: [
          ["/stop", "/plan"],
          ["/standup"]
        ]
      })
    });

    harness.coordinator.activateTurn(message("Start"), "thread-1", "turn-1", "gpt-5-codex");
    await harness.coordinator.completeTurn("thread-1", "turn-1");

    expect(getReplyKeyboardRows(harness.telegram.sentMessages.at(-1))).toEqual([
      ["/stop", "/plan"],
      ["/standup"]
    ]);
  });
});
