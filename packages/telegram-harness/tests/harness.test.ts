import { mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { BridgeCodexApi } from "@kirbot/core";
import type { AppConfig } from "@kirbot/core";
import type { ServerNotification } from "@kirbot/codex-client/generated/codex/ServerNotification";
import type { ServerRequest } from "@kirbot/codex-client/generated/codex/ServerRequest";
import type { RequestId } from "@kirbot/codex-client/generated/codex/RequestId";
import type { UserInput } from "@kirbot/codex-client/generated/codex/v2/UserInput";
import type { ReasoningEffort } from "@kirbot/codex-client/generated/codex/ReasoningEffort";
import type { AskForApproval } from "@kirbot/codex-client/generated/codex/v2/AskForApproval";
import type { CommandExecutionApprovalDecision } from "@kirbot/codex-client/generated/codex/v2/CommandExecutionApprovalDecision";
import type { FileChangeApprovalDecision } from "@kirbot/codex-client/generated/codex/v2/FileChangeApprovalDecision";
import type { Model } from "@kirbot/codex-client/generated/codex/v2/Model";
import type { PermissionsRequestApprovalResponse } from "@kirbot/codex-client/generated/codex/v2/PermissionsRequestApprovalResponse";
import type { SandboxPolicy } from "@kirbot/codex-client/generated/codex/v2/SandboxPolicy";
import type { ToolRequestUserInputResponse } from "@kirbot/codex-client/generated/codex/v2/ToolRequestUserInputResponse";
import type { ServiceTier } from "@kirbot/codex-client/generated/codex/ServiceTier";
import type { ResolvedTurnSnapshot } from "@kirbot/core";
import { createTelegramHarness, RecordingTelegram, type TelegramHarness } from "../src/index";
import type { AppServerEvent } from "@kirbot/codex-client";

class ScriptedCodex implements BridgeCodexApi {
  cwd = "/workspace";
  branch: string | null = "main";
  model = "gpt-5-codex";
  reasoningEffort: ReasoningEffort | null = null;
  serviceTier: ServiceTier | null = null;
  approvalPolicy: AskForApproval = "on-request";
  sandboxPolicy: SandboxPolicy = {
    type: "workspaceWrite",
    writableRoots: [],
    readOnlyAccess: {
      type: "fullAccess"
    },
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  };
  nextTurnId = 1;
  finalText = "Harness reply";
  tokenUsage: ServerNotification | null = null;
  createThreadCalls: Array<{
    profileId: string;
    title: string;
  }> = [];
  registerThreadProfileCalls: Array<{
    threadId: string;
    profileId: string;
  }> = [];
  createdThreadIds: string[] = [];
  turns: Array<{ threadId: string; turnId: string; input: UserInput[] }> = [];
  steerCalls: Array<{ threadId: string; expectedTurnId: string; input: UserInput[] }> = [];
  commandApprovals: Array<{ id: RequestId; decision: CommandExecutionApprovalDecision }> = [];
  permissionsApprovals: Array<{ id: RequestId; response: PermissionsRequestApprovalResponse }> = [];
  listModelsCalls: string[] = [];
  snapshotDelayMs = 0;

  readonly #eventQueue: AppServerEvent[] = [];
  readonly #eventWaiters: Array<(event: AppServerEvent | null) => void> = [];
  #pendingTurnId: string | null = null;
  #pendingThreadId: string | null = null;

  constructor(
    private readonly behavior: "complete" | "commandApproval" | "lateCommandApprovalDuringCompletion" | "planArtifact" = "complete"
  ) {}

  registerThreadProfile(threadId: string, profileId: string): void {
    this.registerThreadProfileCalls.push({ threadId, profileId });
  }

  async createThread(profileId: string, title: string, options?: {
    cwd?: string | null;
    settings?: {
      model?: string;
      reasoningEffort?: ReasoningEffort | null;
      serviceTier?: ServiceTier | null;
      approvalPolicy?: AskForApproval;
      sandboxPolicy?: SandboxPolicy;
    } | null;
  }): Promise<{
    threadId: string;
    branch: string | null;
    model: string;
    reasoningEffort: ReasoningEffort | null;
    serviceTier: ServiceTier | null;
    cwd: string;
    approvalPolicy: AskForApproval;
    sandboxPolicy: SandboxPolicy;
  }> {
    this.createThreadCalls.push({
      profileId,
      title
    });
    const threadId = `thread-${this.createdThreadIds.length + 1}`;
    this.createdThreadIds.push(title);
    if (options?.settings?.model) {
      this.model = options.settings.model;
    }
    if ("reasoningEffort" in (options?.settings ?? {})) {
      this.reasoningEffort = options?.settings?.reasoningEffort ?? null;
    }
    if ("serviceTier" in (options?.settings ?? {})) {
      this.serviceTier = options?.settings?.serviceTier ?? null;
    }
    if (options?.settings?.approvalPolicy) {
      this.approvalPolicy = options.settings.approvalPolicy;
    }
    if (options?.settings?.sandboxPolicy) {
      this.sandboxPolicy = options.settings.sandboxPolicy;
    }
    return {
      threadId,
      branch: this.branch,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      serviceTier: this.serviceTier,
      cwd: options?.cwd ?? this.cwd,
      approvalPolicy: this.approvalPolicy,
      sandboxPolicy: this.sandboxPolicy
    };
  }

  async readProfileSettings(profileId: string): Promise<{
    model: string;
    reasoningEffort: ReasoningEffort | null;
    serviceTier: ServiceTier | null;
    cwd: string;
    approvalPolicy: AskForApproval;
    sandboxPolicy: SandboxPolicy;
  }> {
    void profileId;
    return {
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      serviceTier: this.serviceTier,
      cwd: this.cwd,
      approvalPolicy: this.approvalPolicy,
      sandboxPolicy: this.sandboxPolicy
    };
  }

  async updateProfileSettings(profileId: string, update: {
    model?: string;
    reasoningEffort?: ReasoningEffort | null;
    serviceTier?: ServiceTier | null;
    approvalPolicy?: AskForApproval;
    sandboxPolicy?: SandboxPolicy;
  }): Promise<{
    model: string;
    reasoningEffort: ReasoningEffort | null;
    serviceTier: ServiceTier | null;
    cwd: string;
    approvalPolicy: AskForApproval;
    sandboxPolicy: SandboxPolicy;
  }> {
    void profileId;
    if (update.model) {
      this.model = update.model;
    }
    if ("reasoningEffort" in update) {
      this.reasoningEffort = update.reasoningEffort ?? null;
    }
    if ("serviceTier" in update) {
      this.serviceTier = update.serviceTier ?? null;
    }
    if (update.approvalPolicy) {
      this.approvalPolicy = update.approvalPolicy;
    }
    if (update.sandboxPolicy) {
      this.sandboxPolicy = update.sandboxPolicy;
    }

    return this.readProfileSettings(profileId);
  }

  async ensureThreadLoaded(): Promise<{
    model: string;
    reasoningEffort: ReasoningEffort | null;
    serviceTier: ServiceTier | null;
    cwd: string;
    approvalPolicy: AskForApproval;
    sandboxPolicy: SandboxPolicy;
  }> {
    return {
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      serviceTier: this.serviceTier,
      cwd: this.cwd,
      approvalPolicy: this.approvalPolicy,
      sandboxPolicy: this.sandboxPolicy
    };
  }

  async readThread(): Promise<{
    name: string | null;
    cwd: string;
  }> {
    return {
      name: null,
      cwd: this.cwd
    };
  }

  async compactThread(): Promise<void> {}

  async sendTurn(
    threadId: string,
    input: UserInput[],
    options?: {
      collaborationMode?: unknown | null;
      overrides?: {
        model?: string;
        reasoningEffort?: ReasoningEffort | null;
        serviceTier?: ServiceTier | null;
        approvalPolicy?: AskForApproval;
        sandboxPolicy?: SandboxPolicy;
      } | null;
    }
  ): Promise<{ id: string }> {
    if (options?.overrides?.model) {
      this.model = options.overrides.model;
    }
    if ("reasoningEffort" in (options?.overrides ?? {})) {
      this.reasoningEffort = options?.overrides?.reasoningEffort ?? null;
    }
    if ("serviceTier" in (options?.overrides ?? {})) {
      this.serviceTier = options?.overrides?.serviceTier ?? null;
    }
    if (options?.overrides?.approvalPolicy) {
      this.approvalPolicy = options.overrides.approvalPolicy;
    }
    if (options?.overrides?.sandboxPolicy) {
      this.sandboxPolicy = options.overrides.sandboxPolicy;
    }

    const turnId = `turn-${this.nextTurnId++}`;
    this.turns.push({ threadId, turnId, input });
    if (this.behavior === "complete") {
      setTimeout(() => {
        if (this.tokenUsage) {
          this.emitNotification({
            ...this.tokenUsage,
            params: {
              ...this.tokenUsage.params,
              threadId,
              turnId
            }
          } as ServerNotification);
        }
        this.emitNotification({
          method: "turn/completed",
          params: {
            threadId,
            turn: {
              id: turnId,
              status: "completed"
            }
          }
        } as ServerNotification);
      }, 0);
    } else if (this.behavior === "lateCommandApprovalDuringCompletion") {
      this.#pendingThreadId = threadId;
      this.#pendingTurnId = turnId;
      setTimeout(() => {
        this.emitNotification({
          method: "turn/completed",
          params: {
            threadId,
            turn: {
              id: turnId,
              status: "completed"
            }
          }
        } as ServerNotification);
      }, 0);
      setTimeout(() => {
        this.emitRequest({
          method: "item/commandExecution/requestApproval",
          id: "approval-1",
          params: {
            threadId,
            turnId,
            itemId: "item-1",
            command: "npm test",
            cwd: "/workspace",
            reason: "Need approval",
            availableDecisions: ["accept", "decline", "cancel"]
          }
        } as ServerRequest);
      }, 10);
    } else if (this.behavior === "planArtifact") {
      setTimeout(() => {
        this.emitNotification({
          method: "item/started",
          params: {
            threadId,
            turnId,
            item: {
              type: "plan",
              id: "plan-1",
              text: ""
            }
          }
        } as ServerNotification);
        this.emitNotification({
          method: "item/completed",
          params: {
            threadId,
            turnId,
            item: {
              type: "plan",
              id: "plan-1",
              text: "1. Draft the rollout"
            }
          }
        } as ServerNotification);
        this.emitNotification({
          method: "turn/completed",
          params: {
            threadId,
            turn: {
              id: turnId,
              status: "completed"
            }
          }
        } as ServerNotification);
      }, 0);
    } else {
      this.#pendingThreadId = threadId;
      this.#pendingTurnId = turnId;
      setTimeout(() => {
        this.emitRequest({
          method: "item/commandExecution/requestApproval",
          id: "approval-1",
          params: {
            threadId,
            turnId,
            itemId: "item-1",
            command: "npm test",
            cwd: "/workspace",
            reason: "Need approval",
            availableDecisions: ["accept", "decline", "cancel"]
          }
        } as ServerRequest);
      }, 0);
    }

    return { id: turnId };
  }

  async steerTurn(threadId: string, expectedTurnId: string, input: UserInput[]): Promise<{ turnId: string }> {
    this.steerCalls.push({ threadId, expectedTurnId, input });
    return { turnId: "turn-steer" };
  }

  async interruptTurn(): Promise<void> {}

  async archiveThread(): Promise<void> {}

  async readTurnSnapshot(): Promise<ResolvedTurnSnapshot> {
    if (this.snapshotDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.snapshotDelayMs));
    }

    return {
      text: this.finalText,
      assistantText: this.finalText,
      planText: "",
      changedFiles: 0,
      cwd: "/workspace",
      branch: "main"
    };
  }

  async respondToCommandApproval(id: RequestId, response: { decision: CommandExecutionApprovalDecision }): Promise<void> {
    this.commandApprovals.push({ id, decision: response.decision });
    const pendingThreadId = this.#pendingThreadId;
    const pendingTurnId = this.#pendingTurnId;
    if (!pendingThreadId || !pendingTurnId) {
      return;
    }

    setTimeout(() => {
      this.emitNotification({
        method: "turn/completed",
        params: {
          threadId: pendingThreadId,
          turn: {
            id: pendingTurnId,
            status: "completed"
          }
        }
      } as ServerNotification);
    }, 0);
  }

  async respondToFileChangeApproval(_id: RequestId, _response: { decision: FileChangeApprovalDecision }): Promise<void> {}

  async respondToPermissionsApproval(id: RequestId, response: PermissionsRequestApprovalResponse): Promise<void> {
    this.permissionsApprovals.push({ id, response });
  }

  async respondToUserInputRequest(_id: RequestId, _response: ToolRequestUserInputResponse): Promise<void> {}

  async respondUnsupportedRequest(): Promise<void> {}

  async listModels(profileId: string): Promise<Model[]> {
    this.listModelsCalls.push(profileId);
    return [
      {
        id: "model-1",
        model: this.model,
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
        displayName: this.model,
        description: "Harness model",
        hidden: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: "medium",
        inputModalities: [],
        supportsPersonality: false,
        isDefault: true
      }
    ];
  }

  async nextEvent(): Promise<AppServerEvent | null> {
    const event = this.#eventQueue.shift();
    if (event) {
      return event;
    }

    return new Promise<AppServerEvent | null>((resolve) => {
      this.#eventWaiters.push(resolve);
    });
  }

  private emitNotification(notification: ServerNotification): void {
    this.emitEvent({
      kind: "notification",
      notification
    });
  }

  private emitRequest(request: ServerRequest): void {
    this.emitEvent({
      kind: "serverRequest",
      request
    });
  }

  private emitEvent(event: AppServerEvent): void {
    const waiter = this.#eventWaiters.shift();
    if (waiter) {
      waiter(event);
      return;
    }

    this.#eventQueue.push(event);
  }
}

function rateLimitError(retryAfterSeconds: number): Error & {
  error_code: number;
  parameters: {
    retry_after: number;
  };
} {
  const error = new Error("Too Many Requests") as Error & {
    error_code: number;
    parameters: {
      retry_after: number;
    };
  };
  error.error_code = 429;
  error.parameters = {
    retry_after: retryAfterSeconds
  };
  return error;
}

const harnesses: TelegramHarness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) {
    await harnesses.pop()?.stop();
  }
});

describe("Telegram harness", () => {
  it("isolates the default Codex app-server URL and workspace from the base config", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kirbot-harness-test-"));
    const harness = await createTelegramHarness({
      config: createConfig(tempDir),
      stateDir: tempDir,
      codexApi: new ScriptedCodex("complete")
    });
    harnesses.push(harness);

    await harness.start();

    const startupLog = getHarnessStartupLog(harness);
    expect(startupLog).toContain(`state dir ${tempDir}`);
    expect(startupLog).toContain("codex=stdio");
    expect(startupLog).toContain(`cwd=${join(tempDir, "workspace")}`);
    expect(readdirSync(join(tempDir, "workspace"))).toEqual([]);
  });

  it("supports inheriting the base workspace when requested", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kirbot-harness-test-"));
    const harness = await createTelegramHarness({
      config: createConfig(tempDir),
      stateDir: tempDir,
      codexApi: new ScriptedCodex("complete"),
      workspaceMode: "inherit"
    });
    harnesses.push(harness);

    await harness.start();

    expect(getHarnessStartupLog(harness)).toContain("cwd=/workspace");
  });

  it("respects explicit workspace overrides", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kirbot-harness-test-"));
    const workspaceDir = join(tempDir, "custom-workspace");
    const harness = await createTelegramHarness({
      config: createConfig(tempDir),
      stateDir: tempDir,
      codexApi: new ScriptedCodex("complete"),
      workspaceDir
    });
    harnesses.push(harness);

    await harness.start();

    const startupLog = getHarnessStartupLog(harness);
    expect(startupLog).toContain("codex=stdio");
    expect(startupLog).toContain(`cwd=${workspaceDir}`);
    expect(readdirSync(workspaceDir)).toEqual([]);
  });

  it("captures persistent root-thread transcript output and raw Telegram events", async () => {
    const harness = await buildHarness(new ScriptedCodex("complete"));
    harnesses.push(harness);

    await harness.sendRootText("Inspect the repo");
    await harness.waitForIdle();

    const transcript = harness.getTranscript();
    expect(transcript.root.chatId).toBe(-1001);
    expect(transcript.root.messages).toEqual([
      {
        actor: "user",
        messageId: 1,
        text: "Inspect the repo"
      },
      {
        actor: "bot",
        messageId: 502,
        text: "Harness reply",
        inlineButtons: [
          [
            {
              text: "Response",
              url: expect.stringContaining("https://example.com/mini-app/plan#")
            }
          ]
        ]
      },
      {
        actor: "bot",
        messageId: 503,
        text: "<1s • 100% left • /workspace • main • gpt-5-codex",
        entities: [
          {
            type: "pre",
            offset: 0,
            length: 49,
            language: "status"
          }
        ],
      }
    ]);
    expect(transcript.topics).toHaveLength(0);

    const eventTypes = harness.getTelegramEvents().map((event) => event.type);
    expect(eventTypes).toContain("telegram.sendChatAction");
    expect(eventTypes).toContain("telegram.sendMessage");
    expect(eventTypes).toContain("telegram.deleteMessage");
  });

  it("supports root image sends and forwards them to Codex as local images", async () => {
    const codex = new ScriptedCodex("complete");
    const harness = await buildHarness(codex);
    harnesses.push(harness);

    await harness.sendRootImage({
      caption: "Inspect this screenshot",
      bytes: new TextEncoder().encode("root-image"),
      fileName: "root.png",
      mimeType: "image/png"
    });
    await harness.waitForIdle();

    expect(harness.getTranscript().root.messages[0]).toEqual({
      actor: "user",
      messageId: 1,
      text: "Inspect this screenshot"
    });
    expect(codex.turns).toHaveLength(1);
    expect(codex.turns[0]?.input[0]).toEqual({
      type: "text",
      text: "Inspect this screenshot",
      text_elements: []
    });
    expect(codex.turns[0]?.input[1]?.type).toBe("localImage");
  });

  it("routes root and topic session creation through the expected profile ids", async () => {
    const codex = new ScriptedCodex("complete");
    const harness = await buildHarness(codex);
    harnesses.push(harness);

    await harness.sendRootText("Start the root session");
    await harness.waitForIdle();

    await harness.sendRootText("/thread Start a topic session");
    await harness.waitForIdle();

    expect(codex.createThreadCalls).toEqual(
      expect.arrayContaining([
        {
          profileId: "general",
          title: "Root Chat"
        },
        {
          profileId: "coding",
          title: expect.any(String)
        }
      ])
    );
    expect(codex.registerThreadProfileCalls).toEqual(
      expect.arrayContaining([
        {
          threadId: "thread-1",
          profileId: "general"
        },
        {
          threadId: "thread-2",
          profileId: "coding"
        }
      ])
    );
  });

  it("supports topic image sends and records captionless images in the transcript", async () => {
    const codex = new ScriptedCodex("complete");
    const harness = await buildHarness(codex);
    harnesses.push(harness);

    await harness.sendRootText("/thread Inspect the repo");
    await harness.waitForIdle();
    const topicId = harness.getTranscript().topics[0]?.topicId;
    expect(topicId).toBeDefined();

    await harness.sendTopicImage(topicId!, {
      bytes: new TextEncoder().encode("topic-image"),
      fileName: "topic.png",
      mimeType: "image/png"
    });
    await harness.waitForIdle();

    expect(codex.turns.at(-1)?.input).toEqual([
      {
        type: "localImage",
        path: expect.any(String)
      }
    ]);
    expect(harness.getTranscript().topics[0]?.messages.some((message) => message.actor === "user" && message.text === "[Image]")).toBe(true);
  });

  it("supports image follow-ups while a turn is active", async () => {
    const codex = new ScriptedCodex("commandApproval");
    const harness = await buildHarness(codex);
    harnesses.push(harness);

    await harness.sendRootText("/thread Run the tests");
    const topicId = await waitForTopicId(harness);

    await harness.sendTopicImage(topicId, {
      bytes: new TextEncoder().encode("follow-up-image"),
      fileName: "follow-up.png",
      mimeType: "image/png"
    });

    await waitForCondition(() => codex.steerCalls.length === 1);
    expect(codex.steerCalls[0]?.input).toEqual([
      {
        type: "localImage",
        path: expect.any(String)
      }
    ]);
  });

  it("records bot photo sends through the raw Telegram event log", async () => {
    const telegram = new RecordingTelegram(-1001);
    await telegram.sendPhoto({
      chatId: -1001,
      topicId: 777,
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png"
    });

    expect(telegram.getEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "telegram.sendPhoto",
          chatId: -1001,
          messageId: 501,
          options: expect.objectContaining({
            message_thread_id: 777,
            mime_type: "image/png",
            disable_notification: true
          })
        })
      ])
    );
  });

  it("allows button presses to resolve Codex approval requests", async () => {
    const codex = new ScriptedCodex("commandApproval");
    codex.finalText = "Approved result";
    const harness = await buildHarness(codex);
    harnesses.push(harness);

    await harness.sendRootText("/thread Run the tests");
    await waitForCondition(() =>
      harness
        .getTranscript()
        .topics.some((topic) =>
          topic.messages.some((message) => Array.isArray(message.inlineButtons) && message.inlineButtons.length > 0)
        )
    );

    const approvalMessage = harness
      .getTranscript()
      .topics.flatMap((topic) => topic.messages)
      .find((message) => Array.isArray(message.inlineButtons) && message.inlineButtons.length > 0);
    expect(approvalMessage).toBeDefined();

    await harness.pressButton({
      messageId: approvalMessage!.messageId,
      buttonText: "Allow once"
    });
    await harness.waitForIdle();

    expect(codex.commandApprovals).toEqual([
      {
        id: "approval-1",
        decision: "accept"
      }
    ]);

    const transcript = harness.getTranscript();
    expect(transcript.topics[0]?.messages.some((message) => message.text === "Approved result")).toBe(true);
    expect(transcript.topics[0]?.messages.some((message) => message.text.includes('Resolved item/commandExecution/requestApproval with "accept".'))).toBe(true);
    expect(harness.getTelegramEvents().some((event) => event.type === "telegram.answerCallbackQuery")).toBe(true);
    const approvalEvent = harness.getTelegramEvents().find(
      (event) => event.type === "telegram.sendMessage" && event.text.includes("Command approval needed")
    );
    expect(approvalEvent).toBeDefined();
    if (!approvalEvent || approvalEvent.type !== "telegram.sendMessage") {
      throw new Error("Expected command approval sendMessage event");
    }
    expect(approvalEvent.options?.disable_notification).toBeUndefined();
  });

  it("keeps the final assistant message when a visible edit is retried", async () => {
    const codex = new ScriptedCodex("commandApproval");
    codex.finalText = "Final answer";
    const telegram = new RecordingTelegram(-1001);
    const harness = await buildHarness(
      codex,
      telegram,
      {
        visibleSendSpacingMs: 0,
        visibleSendBackoffAfter429Ms: 50,
        visibleEditSpacingMs: 0,
        visibleEditBackoffAfter429Ms: 50,
        topicCreateSpacingMs: 0,
        topicCreateBackoffAfter429Ms: 50,
        chatActionSpacingMs: 0,
        chatActionBackoffAfter429Ms: 50,
        deleteSpacingMs: 0,
        deleteBackoffAfter429Ms: 50,
        callbackAnswerSpacingMs: 0,
        callbackAnswerBackoffAfter429Ms: 0
      }
    );
    harnesses.push(harness);

    await harness.sendRootText("/thread Repro stuck status");
    await waitForCondition(() =>
      harness
        .getTranscript()
        .topics.some((topic) =>
          topic.messages.some(
            (message) =>
              message.text.includes("Command approval needed")
              && Array.isArray(message.inlineButtons)
              && message.inlineButtons.length > 0
          )
        )
    );

    telegram.setNextEditMessageTextError(rateLimitError(1));

    const approvalMessage = harness
      .getTranscript()
      .topics.flatMap((topic) => topic.messages)
      .find(
        (message) =>
          message.text.includes("Command approval needed")
          && Array.isArray(message.inlineButtons)
          && message.inlineButtons.length > 0
      );
    expect(approvalMessage).toBeDefined();

    await harness.pressButton({
      messageId: approvalMessage!.messageId,
      buttonText: "Allow once"
    });
    await harness.waitForIdle();

    const topicMessages = harness.getTranscript().topics[0]?.messages ?? [];
    const finalAnswerIndex = topicMessages.findIndex((message) => message.text === "Final answer");
    const footerIndex = topicMessages.reduce((lastIndex, message, index) => (
      message.text.includes("% left") ? index : lastIndex
    ), -1);
    expect(finalAnswerIndex).toBeGreaterThanOrEqual(0);
    expect(footerIndex).toBeGreaterThan(finalAnswerIndex);
    expect(harness.getTelegramEvents().some((event) => event.type === "telegram.editMessageText")).toBe(true);
  }, 15_000);

  it("answers callback queries before retrying a queued approval edit", async () => {
    const codex = new ScriptedCodex("commandApproval");
    codex.finalText = "Approved result";
    const telegram = new RecordingTelegram(-1001);
    const harness = await buildHarness(
      codex,
      telegram,
      {
        visibleSendSpacingMs: 0,
        visibleSendBackoffAfter429Ms: 50,
        visibleEditSpacingMs: 0,
        visibleEditBackoffAfter429Ms: 50,
        topicCreateSpacingMs: 0,
        topicCreateBackoffAfter429Ms: 50,
        chatActionSpacingMs: 0,
        chatActionBackoffAfter429Ms: 50,
        deleteSpacingMs: 0,
        deleteBackoffAfter429Ms: 50,
        callbackAnswerSpacingMs: 0,
        callbackAnswerBackoffAfter429Ms: 0
      }
    );
    harnesses.push(harness);

    await harness.sendRootText("/thread Run the tests");
    await waitForCondition(() =>
      harness
        .getTranscript()
        .topics.some((topic) =>
          topic.messages.some(
            (message) =>
              message.text.includes("Command approval needed")
              && Array.isArray(message.inlineButtons)
              && message.inlineButtons.length > 0
          )
        )
    );

    const approvalMessage = harness
      .getTranscript()
      .topics.flatMap((topic) => topic.messages)
      .find(
        (message) =>
          message.text.includes("Command approval needed")
          && Array.isArray(message.inlineButtons)
          && message.inlineButtons.length > 0
      );
    expect(approvalMessage).toBeDefined();

    telegram.setNextEditMessageTextError(rateLimitError(1));

    const eventsBeforePress = harness.getTelegramEvents().length;
    await harness.pressButton({
      messageId: approvalMessage!.messageId,
      buttonText: "Allow once"
    });
    await harness.waitForIdle();

    const callbackEvents = harness.getTelegramEvents().slice(eventsBeforePress);
    const callbackEventIndex = callbackEvents.findIndex((event) => event.type === "telegram.answerCallbackQuery");
    const approvalEditIndex = callbackEvents
      .findIndex(
        (event) =>
          event.type === "telegram.editMessageText"
          && event.text.includes('Resolved item/commandExecution/requestApproval with "accept".')
      );
    expect(callbackEventIndex).toBeGreaterThanOrEqual(0);
    expect(approvalEditIndex).toBeGreaterThan(callbackEventIndex);
  }, 15_000);

  it("retries temporary 429s on topic creation", async () => {
    const telegram = new RecordingTelegram(-1001);
    telegram.setNextCreateForumTopicError(rateLimitError(1));
    const harness = await buildHarness(
      new ScriptedCodex("complete"),
      telegram,
      {
        visibleSendSpacingMs: 0,
        visibleSendBackoffAfter429Ms: 50,
        visibleEditSpacingMs: 0,
        visibleEditBackoffAfter429Ms: 50,
        topicCreateSpacingMs: 0,
        topicCreateBackoffAfter429Ms: 50,
        chatActionSpacingMs: 0,
        chatActionBackoffAfter429Ms: 50,
        deleteSpacingMs: 0,
        deleteBackoffAfter429Ms: 50,
        callbackAnswerSpacingMs: 0,
        callbackAnswerBackoffAfter429Ms: 0
      }
    );
    harnesses.push(harness);

    await harness.sendRootText("/plan Ship the fix");
    await harness.waitForIdle();

    const transcript = harness.getTranscript();
    expect(transcript.topics).toHaveLength(1);
    expect(transcript.topics[0]?.messages.some((message) => message.text === "Harness reply")).toBe(true);
    expect(harness.getTelegramEvents().some((event) => event.type === "telegram.createForumTopic")).toBe(true);
  }, 15_000);

  it("retries temporary 429s on visible completion delivery", async () => {
    const telegram = new RecordingTelegram(-1001);
    telegram.setNextSendMessageError(rateLimitError(1));
    const harness = await buildHarness(
      new ScriptedCodex("complete"),
      telegram,
      {
        visibleSendSpacingMs: 0,
        visibleSendBackoffAfter429Ms: 50,
        visibleEditSpacingMs: 0,
        visibleEditBackoffAfter429Ms: 50,
        topicCreateSpacingMs: 0,
        topicCreateBackoffAfter429Ms: 50,
        chatActionSpacingMs: 0,
        chatActionBackoffAfter429Ms: 50,
        deleteSpacingMs: 0,
        deleteBackoffAfter429Ms: 50,
        callbackAnswerSpacingMs: 0,
        callbackAnswerBackoffAfter429Ms: 0
      }
    );
    harnesses.push(harness);

    await harness.sendRootText("Inspect the repo");
    await harness.waitForIdle();

    const transcript = harness.getTranscript();
    expect(transcript.root.messages.some((message) => message.text === "Harness reply")).toBe(true);
    expect(harness.getTelegramEvents().some((event) => event.type === "telegram.sendMessage")).toBe(true);
  }, 15_000);

  it("does not recreate the status draft when a late approval request arrives during turn finalization", async () => {
    const codex = new ScriptedCodex("lateCommandApprovalDuringCompletion");
    codex.finalText = "Final answer";
    codex.snapshotDelayMs = 150;
    const harness = await buildHarness(codex);
    harnesses.push(harness);

    await harness.sendRootText("/thread Repro stuck status");
    await waitForCondition(() => {
      const transcript = harness.getTranscript();
      return (
        transcript.topics[0]?.messages.some((message) => message.text === "Final answer") === true &&
        transcript.topics[0]?.messages.some((message) => message.text.includes("Command approval needed")) === true
      );
    });

    const transcript = harness.getTranscript();
    expect(transcript.drafts).toEqual([]);

    const eventTexts = harness.getTelegramEvents().flatMap((event) => {
      if (
        event.type === "telegram.sendMessage"
        || event.type === "telegram.sendMessageDraft"
        || event.type === "telegram.editMessageText"
      ) {
        return [event.text];
      }
      return [];
    });
    const mutableEventTexts = harness.getTelegramEvents().flatMap((event) => {
      if (event.type === "telegram.sendMessageDraft" || event.type === "telegram.editMessageText") {
        return [event.text];
      }
      return [];
    });
    expect(eventTexts).toContain("Final answer");
    expect(mutableEventTexts).not.toContain("thinking · 0s");
    expect(harness.getTelegramEvents().some((event) => event.type === "telegram.sendMessageDraft")).toBe(false);
  });

  it("shows codex-cli-aligned context left in the harness transcript footer", async () => {
    const codex = new ScriptedCodex("complete");
    codex.finalText = "Footer observation";
    codex.tokenUsage = {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-ignored",
        turnId: "turn-ignored",
        tokenUsage: {
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
        }
      }
    } as ServerNotification;
    const harness = await buildHarness(codex);
    harnesses.push(harness);

    await harness.sendRootText("/thread Observe context footer");
    await harness.waitForIdle();

    const footer = harness.getTranscript().topics[0]?.messages.at(-1)?.text;
    expect(footer).toBe("<1s • 30% left • /workspace • main • gpt-5-codex");
  });

  it("records Mini App buttons on plan artifact stubs", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kirbot-harness-test-"));
    const config = createConfig(tempDir);
    config.telegram.miniApp = {
      publicUrl: "https://example.com/mini-app"
    };
    const harness = await createTelegramHarness({
      config,
      stateDir: tempDir,
      codexApi: new ScriptedCodex("planArtifact")
    });
    harnesses.push(harness);

    await harness.start();
    await harness.sendRootText("/thread Plan the rollout");
    await harness.waitForIdle();

    const topicMessages = harness.getTranscript().topics[0]?.messages ?? [];
    const stub = topicMessages.find((message) => message.text === "Plan is ready");
    const button = stub?.inlineButtons?.[0]?.[0];
    expect(button?.text).toBe("Plan");
    expect(button && "url" in button ? button.url : null).toMatch(/^https:\/\/example\.com\/mini-app\/plan#d=/);
    const stubEvent = harness.getTelegramEvents().find(
      (event) => event.type === "telegram.sendMessage" && event.text === "Plan is ready"
    );
    expect(stubEvent).toBeDefined();
    if (!stubEvent || stubEvent.type !== "telegram.sendMessage") {
      throw new Error("Expected plan-ready sendMessage event");
    }
    expect(stubEvent.options?.disable_notification).toBeUndefined();
  });

  it("records topic reply keyboards separately from inline buttons", async () => {
    const harness = await buildHarness(new ScriptedCodex("complete"));
    harnesses.push(harness);

    await harness.sendRootText("/thread Inspect the repo");
    await harness.waitForIdle();

    const topicMessages = harness.getTranscript().topics[0]?.messages ?? [];
    const footer = topicMessages[0];
    expect(footer?.replyKeyboard).toBeUndefined();
    expect(footer?.inlineButtons).toBeUndefined();
  });
});

async function buildHarness(
  codex: BridgeCodexApi,
  telegram?: RecordingTelegram,
  messengerDeliveryPolicy?: Partial<{
    callbackAnswerSpacingMs: number;
    callbackAnswerBackoffAfter429Ms: number;
    visibleSendSpacingMs: number;
    visibleSendBackoffAfter429Ms: number;
    topicCreateSpacingMs: number;
    topicCreateBackoffAfter429Ms: number;
    visibleEditSpacingMs: number;
    visibleEditBackoffAfter429Ms: number;
    chatActionSpacingMs: number;
    chatActionBackoffAfter429Ms: number;
    deleteSpacingMs: number;
    deleteBackoffAfter429Ms: number;
  }>
): Promise<TelegramHarness> {
  const tempDir = mkdtempSync(join(tmpdir(), "kirbot-harness-test-"));
  const harness = await createTelegramHarness({
    config: createConfig(tempDir),
    stateDir: tempDir,
    codexApi: codex,
    ...(telegram ? { telegram } : {}),
    ...(messengerDeliveryPolicy ? { messengerDeliveryPolicy } : {})
  });
  await harness.start();
  return harness;
}

function createConfig(tempDir: string): AppConfig {
  return {
    telegram: {
      botToken: "token",
      workspaceChatId: -1001,
      mediaTempDir: join(tempDir, "media"),
      miniApp: {
        publicUrl: "https://example.com/mini-app"
      }
    },
    database: {
      path: join(tempDir, "bridge.sqlite")
    },
    codex: {
      defaultCwd: "/workspace",
      profiles: {
        general: { homePath: join(tempDir, "codex-general") },
        coding: { homePath: join(tempDir, "codex-coding") }
      },
      routing: {
        general: "general",
        thread: "coding",
        plan: "coding"
      },
      model: undefined,
      modelProvider: undefined,
      sandbox: undefined,
      approvalPolicy: undefined,
      serviceName: "telegram-codex-bridge",
      baseInstructions: undefined,
      developerInstructions: "prompt",
      config: undefined
    }
  };
}

async function waitForCondition(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("Timed out waiting for condition");
}

function getHarnessStartupLog(harness: TelegramHarness): string {
  const startupLog = harness.getLogs().find((entry) => entry.source === "harness" && entry.message.startsWith("Started harness"));
  expect(startupLog).toBeDefined();
  return startupLog!.message;
}

async function waitForTopicId(harness: TelegramHarness, timeoutMs = 2_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const topicId = harness.getTranscript().topics[0]?.topicId;
    if (topicId !== undefined) {
      return topicId;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("Timed out waiting for topic id");
}
