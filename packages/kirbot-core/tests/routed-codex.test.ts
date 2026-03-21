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
  readonly createThreadCalls: string[] = [];
  readonly ensureThreadLoadedCalls: string[] = [];
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
    readonly name: "shared" | "isolated"
  ) {}

  async createThread(): Promise<{ threadId: string; branch: string | null } & typeof DEFAULT_SETTINGS> {
    const threadId = `${this.name}-thread-${this.createThreadCalls.length + 1}`;
    this.createThreadCalls.push(threadId);
    this.threadIds.add(threadId);
    return {
      threadId,
      branch: "main",
      ...DEFAULT_SETTINGS
    };
  }

  async readGlobalSettings(): Promise<typeof DEFAULT_SETTINGS> {
    return DEFAULT_SETTINGS;
  }

  async updateGlobalSettings(): Promise<typeof DEFAULT_SETTINGS> {
    return DEFAULT_SETTINGS;
  }

  async ensureThreadLoaded(threadId: string): Promise<typeof DEFAULT_SETTINGS> {
    this.ensureThreadLoadedCalls.push(threadId);
    this.#assertThreadExists(threadId);
    return DEFAULT_SETTINGS;
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
  it("creates new threads on the isolated gateway and remembers their route", async () => {
    const shared = new FakeCodexApi("shared");
    const isolated = new FakeCodexApi("isolated");
    const routed = new RoutedCodexApi({ shared, isolated });

    const thread = await routed.createThread("New session");
    await routed.ensureThreadLoaded(thread.threadId);

    expect(thread.threadId).toBe("isolated-thread-1");
    expect(isolated.createThreadCalls).toEqual(["isolated-thread-1"]);
    expect(isolated.ensureThreadLoadedCalls).toEqual(["isolated-thread-1"]);
    expect(shared.ensureThreadLoadedCalls).toEqual([]);
  });

  it("falls back to the shared gateway for legacy thread ids and caches the result", async () => {
    const shared = new FakeCodexApi("shared");
    shared.threadIds.add("legacy-thread-1");
    const isolated = new FakeCodexApi("isolated");
    const routed = new RoutedCodexApi({ shared, isolated });

    await routed.ensureThreadLoaded("legacy-thread-1");
    await routed.sendTurn("legacy-thread-1", []);

    expect(isolated.ensureThreadLoadedCalls).toEqual(["legacy-thread-1"]);
    expect(shared.ensureThreadLoadedCalls).toEqual(["legacy-thread-1"]);
    expect(shared.sendTurnCalls).toEqual(["legacy-thread-1"]);
    expect(isolated.sendTurnCalls).toEqual([]);
  });

  it("routes approval responses back to the gateway that emitted the request", async () => {
    const shared = new FakeCodexApi("shared");
    const isolated = new FakeCodexApi("isolated");
    isolated.events.push({
      kind: "serverRequest",
      request: {
        jsonrpc: "2.0",
        method: "item/commandExecution/requestApproval",
        id: 42,
        params: {
          threadId: "isolated-thread-1"
        }
      } as never
    });

    const routed = new RoutedCodexApi({ shared, isolated });
    const event = await routed.nextEvent();

    expect(event?.kind).toBe("serverRequest");

    await routed.respondToCommandApproval(42, {
      decision: "accept"
    });

    expect(isolated.commandApprovalResponses).toEqual([42]);
    expect(shared.commandApprovalResponses).toEqual([]);
  });
});
