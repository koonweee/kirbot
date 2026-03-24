import { describe, expect, it } from "vitest";

import type { AppServerEvent, ResolvedTurnSnapshot } from "@kirbot/codex-client";
import type { CollaborationMode } from "@kirbot/codex-client/generated/codex/CollaborationMode";
import type { Model } from "@kirbot/codex-client/generated/codex/v2/Model";
import type { RequestId } from "@kirbot/codex-client/generated/codex/RequestId";
import type { CommandExecutionApprovalDecision } from "@kirbot/codex-client/generated/codex/v2/CommandExecutionApprovalDecision";
import type { FileChangeApprovalDecision } from "@kirbot/codex-client/generated/codex/v2/FileChangeApprovalDecision";
import type { PermissionsRequestApprovalResponse } from "@kirbot/codex-client/generated/codex/v2/PermissionsRequestApprovalResponse";
import type { ToolRequestUserInputResponse } from "@kirbot/codex-client/generated/codex/v2/ToolRequestUserInputResponse";
import type { UserInput } from "@kirbot/codex-client/generated/codex/v2/UserInput";

import type { BridgeCodexApi } from "../src/bridge";
import { RoutedCodexApi } from "../src/routed-codex";

const DEFAULT_SETTINGS = {
  model: "gpt-5-codex",
  reasoningEffort: null,
  serviceTier: null,
  cwd: "/workspace",
  approvalPolicy: "never" as const,
  sandboxPolicy: {
    type: "dangerFullAccess" as const
  }
};

class FakeCodexApi implements BridgeCodexApi {
  readonly createThreadCalls: Array<{
    profileId: string;
    title: string;
    options?: {
      cwd?: string | null;
      settings?: Record<string, unknown> | null;
    };
  }> = [];
  readonly readProfileSettingsCalls: string[] = [];
  readonly updateProfileSettingsCalls: Array<{ profileId: string; update: Record<string, unknown> }> = [];
  readonly ensureThreadLoadedCalls: string[] = [];
  readonly readThreadCalls: string[] = [];
  readonly sendTurnCalls: string[] = [];
  readonly commandApprovalResponses: RequestId[] = [];
  readonly fileChangeApprovalResponses: RequestId[] = [];
  readonly permissionsApprovalResponses: RequestId[] = [];
  readonly userInputResponses: RequestId[] = [];
  readonly unsupportedResponses: RequestId[] = [];
  readonly events: AppServerEvent[] = [];
  readonly threadIds = new Set<string>();
  readonly missingThreadIds = new Set<string>();

  constructor(
    readonly profileId: string
  ) {}

  registerThreadProfile(_threadId: string, _profileId: string): void {}

  async createThread(
    profileId: string,
    title: string,
    options?: {
      cwd?: string | null;
      settings?: Record<string, unknown> | null;
    }
  ): Promise<{ threadId: string; branch: string | null } & typeof DEFAULT_SETTINGS> {
    const threadId = `${this.profileId}-thread-${this.createThreadCalls.length + 1}`;
    this.createThreadCalls.push({
      profileId,
      title,
      ...(options !== undefined ? { options } : {})
    });
    this.threadIds.add(threadId);
    return {
      threadId,
      branch: "main",
      ...DEFAULT_SETTINGS
    };
  }

  async readProfileSettings(profileId: string): Promise<typeof DEFAULT_SETTINGS> {
    this.readProfileSettingsCalls.push(profileId);
    return DEFAULT_SETTINGS;
  }

  async updateProfileSettings(
    profileId: string,
    update: Record<string, unknown>
  ): Promise<typeof DEFAULT_SETTINGS> {
    this.updateProfileSettingsCalls.push({
      profileId,
      update
    });
    return DEFAULT_SETTINGS;
  }

  async ensureThreadLoaded(threadId: string): Promise<typeof DEFAULT_SETTINGS> {
    this.ensureThreadLoadedCalls.push(threadId);
    this.#assertThreadExists(threadId);
    return DEFAULT_SETTINGS;
  }

  async readThread(threadId: string): Promise<{
    name: string | null;
    cwd: string;
  }> {
    this.readThreadCalls.push(threadId);
    this.#assertThreadExists(threadId);
    return {
      name: null,
      cwd: "/workspace"
    };
  }

  async compactThread(threadId: string): Promise<void> {
    this.#assertThreadExists(threadId);
  }

  async sendTurn(
    threadId: string,
    _input: UserInput[],
    _options?: {
      collaborationMode?: CollaborationMode | null;
      overrides?: Record<string, unknown> | null;
    }
  ): Promise<{ id: string }> {
    this.sendTurnCalls.push(threadId);
    this.#assertThreadExists(threadId);
    return { id: `${threadId}-turn-1` };
  }

  async steerTurn(): Promise<{ turnId: string }> {
    return { turnId: "turn-1" };
  }

  async interruptTurn(threadId: string): Promise<void> {
    this.#assertThreadExists(threadId);
  }

  async archiveThread(threadId: string): Promise<void> {
    this.#assertThreadExists(threadId);
  }

  async readTurnSnapshot(threadId: string): Promise<ResolvedTurnSnapshot> {
    this.#assertThreadExists(threadId);
    return {
      text: "",
      assistantText: "",
      planText: "",
      changedFiles: 0,
      cwd: "/workspace",
      branch: "main"
    };
  }

  async listModels(): Promise<Model[]> {
    return [];
  }

  async respondToCommandApproval(id: RequestId, _response: { decision: CommandExecutionApprovalDecision }): Promise<void> {
    this.commandApprovalResponses.push(id);
  }

  async respondToFileChangeApproval(id: RequestId, _response: { decision: FileChangeApprovalDecision }): Promise<void> {
    this.fileChangeApprovalResponses.push(id);
  }

  async respondToPermissionsApproval(id: RequestId, _response: PermissionsRequestApprovalResponse): Promise<void> {
    this.permissionsApprovalResponses.push(id);
  }

  async respondToUserInputRequest(id: RequestId, _response: ToolRequestUserInputResponse): Promise<void> {
    this.userInputResponses.push(id);
  }

  async respondUnsupportedRequest(id: RequestId): Promise<void> {
    this.unsupportedResponses.push(id);
  }

  async nextEvent(): Promise<AppServerEvent | null> {
    return this.events.shift() ?? null;
  }

  #assertThreadExists(threadId: string): void {
    if (this.missingThreadIds.has(threadId) || !this.threadIds.has(threadId)) {
      throw new Error(`Thread not found: ${threadId}`);
    }
  }
}

describe("RoutedCodexApi", () => {
  it("creates new threads on the requested profile gateway", async () => {
    const general = new FakeCodexApi("general");
    const coding = new FakeCodexApi("coding");
    const routed = new RoutedCodexApi({ general, coding });

    const thread = await routed.createThread("coding", "New session");

    expect(thread.threadId).toBe("coding-thread-1");
    expect(coding.createThreadCalls).toEqual([
      {
        profileId: "coding",
        title: "New session"
      }
    ]);
    expect(general.createThreadCalls).toEqual([]);
  });

  it("retains request and thread routing per profile", async () => {
    const general = new FakeCodexApi("general");
    const coding = new FakeCodexApi("coding");
    const routed = new RoutedCodexApi({ general, coding });
    const thread = await routed.createThread("coding", "New session");
    coding.events.push({
      kind: "serverRequest",
      request: {
        jsonrpc: "2.0",
        method: "item/commandExecution/requestApproval",
        id: 42,
        params: {
          threadId: thread.threadId
        }
      } as never
    });

    const event = await routed.nextEvent();
    await routed.respondToCommandApproval(42, {
      decision: "accept"
    });

    routed.registerThreadProfile(thread.threadId, "coding");
    await routed.ensureThreadLoaded(thread.threadId);
    await routed.sendTurn(thread.threadId, []);

    expect(event?.kind).toBe("serverRequest");
    expect(coding.commandApprovalResponses).toEqual([42]);
    expect(general.commandApprovalResponses).toEqual([]);
    expect(coding.ensureThreadLoadedCalls).toEqual([thread.threadId]);
    expect(general.ensureThreadLoadedCalls).toEqual([]);
    expect(coding.sendTurnCalls).toEqual([thread.threadId]);
    expect(general.sendTurnCalls).toEqual([]);
  });

  it("fails immediately for unknown thread ids without probing another gateway", async () => {
    const general = new FakeCodexApi("general");
    const coding = new FakeCodexApi("coding");
    const routed = new RoutedCodexApi({ general, coding });

    await expect(routed.ensureThreadLoaded("missing-thread")).rejects.toThrow(
      "Unknown Codex thread route"
    );

    expect(general.ensureThreadLoadedCalls).toEqual([]);
    expect(coding.ensureThreadLoadedCalls).toEqual([]);
  });
});
