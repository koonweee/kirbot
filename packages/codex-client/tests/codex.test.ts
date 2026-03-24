import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CodexGateway,
  buildAppServerSpawnEnv,
  buildManagedGlobalConfigEdits,
  spawnCodexAppServer
} from "../src/codex";
import { resolvePinnedCodexExecutablePath } from "../src/codex-cli";
import { CodexRpcClient, StdioRpcTransport, type RpcTransport } from "../src/rpc";

class FakeTransport implements RpcTransport {
  readonly sent: unknown[] = [];
  #messageListener: ((message: unknown) => void) | null = null;
  #closeListener: (() => void) | null = null;

  async connect(): Promise<void> {}

  async close(): Promise<void> {
    this.#closeListener?.();
  }

  async send(message: unknown): Promise<void> {
    this.sent.push(message);
  }

  onMessage(listener: (message: unknown) => void): void {
    this.#messageListener = listener;
  }

  onClose(listener: () => void): void {
    this.#closeListener = listener;
  }

  onError(_listener: (error: Error) => void): void {
  }

  emitMessage(message: unknown): void {
    this.#messageListener?.(message);
  }
}

describe("CodexGateway", () => {
  it("adds CODEX_HOME to the app-server environment when requested", () => {
    const env = buildAppServerSpawnEnv({
      HOME: "/home/dev",
      PATH: "/usr/bin"
    }, "/srv/kirbot/data/codex-home");

    expect(env).toMatchObject({
      HOME: "/home/dev",
      PATH: "/usr/bin",
      CODEX_HOME: "/srv/kirbot/data/codex-home"
    });
  });

  it("builds config-file bootstrap edits from managed Codex settings", () => {
    expect(
      buildManagedGlobalConfigEdits({
        defaultCwd: "/workspace",
        homePath: "/srv/kirbot/data/codex-home",
        model: "gpt-5-codex",
        modelProvider: "openai",
        sandbox: "danger-full-access",
        approvalPolicy: "never",
        serviceName: "telegram-codex-bridge",
        baseInstructions: undefined,
        developerInstructions: undefined,
        config: {
          model_reasoning_effort: "high",
          sandbox_workspace_write: {
            writable_roots: ["/workspace"],
            network_access: true,
            exclude_tmpdir_env_var: false,
            exclude_slash_tmp: false
          }
        }
      })
    ).toEqual([
      {
        keyPath: "model_reasoning_effort",
        value: "high",
        mergeStrategy: "replace"
      },
      {
        keyPath: "sandbox_workspace_write",
        value: {
          writable_roots: ["/workspace"],
          network_access: true,
          exclude_tmpdir_env_var: false,
          exclude_slash_tmp: false
        },
        mergeStrategy: "replace"
      },
      {
        keyPath: "model",
        value: "gpt-5-codex",
        mergeStrategy: "replace"
      },
      {
        keyPath: "model_provider",
        value: "openai",
        mergeStrategy: "replace"
      },
      {
        keyPath: "approval_policy",
        value: "never",
        mergeStrategy: "replace"
      },
      {
        keyPath: "sandbox_mode",
        value: "danger-full-access",
        mergeStrategy: "replace"
      }
    ]);
  });

  it("resolves the pinned local Codex executable from node_modules", () => {
    const executablePath = resolvePinnedCodexExecutablePath();

    expect(existsSync(executablePath)).toBe(true);
    expect(executablePath).toContain("@openai/codex");
  });

  it("completes the initialize handshake against the pinned app-server over stdio", async () => {
    const appServer = await spawnCodexAppServer({});
    const transport = new StdioRpcTransport(appServer.process);
    const client = new CodexRpcClient(transport);

    try {
      await transport.connect();
      const response = await withTimeout(
        client.initialize({
          clientInfo: {
            name: "telegram-codex-bridge-test",
            title: "Telegram Codex Bridge Test",
            version: "0.1.0"
          },
          capabilities: {
            experimentalApi: true
          }
        }),
        10000
      );

      expect(response.userAgent).toContain("codex");
    } finally {
      await client.close();
      await appServer.stop();
    }
  });

  it("initializes with explicit capabilities to match codex-cli", async () => {
    const transport = new FakeTransport();
    const client = new CodexRpcClient(transport);
    const gateway = new CodexGateway(client, {
      defaultCwd: "/workspace",
      model: undefined,
      modelProvider: undefined,
      sandbox: undefined,
      approvalPolicy: undefined,
      serviceName: "telegram-codex-bridge",
      baseInstructions: undefined,
      developerInstructions: undefined,
      config: undefined
    });

    const initializePromise = gateway.initialize();
    await Promise.resolve();

    expect(transport.sent).toEqual([
      {
        jsonrpc: "2.0",
        method: "initialize",
        id: 1,
        params: {
          clientInfo: {
            name: "telegram-codex-bridge",
            title: "Telegram Codex Bridge",
            version: "0.1.0"
          },
          capabilities: {
            experimentalApi: true
          }
        }
      }
    ]);

    transport.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        userAgent: "codex-test"
      }
    });

    await expect(initializePromise).resolves.toBeUndefined();
  });

  it("passes null instruction fields and cwd overrides to thread/start", async () => {
    const transport = new FakeTransport();
    const client = new CodexRpcClient(transport);
    const gateway = new CodexGateway(client, {
      defaultCwd: "/workspace",
      model: undefined,
      modelProvider: undefined,
      sandbox: undefined,
      approvalPolicy: undefined,
      serviceName: "telegram-codex-bridge",
      baseInstructions: undefined,
      developerInstructions: undefined,
      config: undefined
    });

    const initializePromise = gateway.initialize();
    await Promise.resolve();
    transport.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        userAgent: "codex-test"
      }
    });
    await initializePromise;

    const createThreadPromise = gateway.createThread("general", "Test thread", {
      cwd: "/workspace/packages/kirbot-core"
    });
    await Promise.resolve();

    expect(transport.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "thread/start",
      id: 2,
      params: {
        cwd: "/workspace/packages/kirbot-core",
        model: null,
        modelProvider: null,
        approvalPolicy: null,
        sandbox: null,
        config: null,
        serviceName: "telegram-codex-bridge",
        baseInstructions: null,
        developerInstructions: null,
        experimentalRawEvents: false,
        persistExtendedHistory: false,
        ephemeral: false,
        personality: null,
        serviceTier: null
      }
    });

    transport.emitMessage({
      jsonrpc: "2.0",
      id: 2,
      result: {
        thread: {
          id: "thread-1",
          preview: "",
          ephemeral: false,
          modelProvider: "openai",
          createdAt: 1,
          updatedAt: 1,
          status: "idle",
          path: null,
          cwd: "/workspace/packages/kirbot-core",
          cliVersion: "0.0.0",
          source: "appServer",
          agentNickname: null,
          agentRole: null,
          gitInfo: {
            sha: null,
            branch: "main",
            originUrl: null
          },
          name: null,
          turns: []
        },
        model: "gpt-5-codex",
        modelProvider: "openai",
        serviceTier: null,
        cwd: "/workspace/packages/kirbot-core",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: {
          type: "workspaceWrite",
          writableRoots: [],
          readOnlyAccess: {
            type: "fullAccess"
          },
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false
        },
        reasoningEffort: null
      }
    });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(transport.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "thread/name/set",
      id: 3,
      params: {
        threadId: "thread-1",
        name: "Test thread"
      }
    });

    transport.emitMessage({
      jsonrpc: "2.0",
      id: 3,
      result: {}
    });

    await expect(createThreadPromise).resolves.toEqual({
      threadId: "thread-1",
      branch: "main",
      model: "gpt-5-codex",
      reasoningEffort: null,
      serviceTier: null,
      cwd: "/workspace/packages/kirbot-core",
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [],
        readOnlyAccess: {
          type: "fullAccess"
        },
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false
      }
    });
  });

  it("passes explicit initial settings through on thread/start", async () => {
    const transport = new FakeTransport();
    const client = new CodexRpcClient(transport);
    const gateway = new CodexGateway(client, {
      defaultCwd: "/workspace",
      model: undefined,
      modelProvider: undefined,
      sandbox: undefined,
      approvalPolicy: undefined,
      serviceName: "telegram-codex-bridge",
      baseInstructions: undefined,
      developerInstructions: undefined,
      config: undefined
    });

    const initializePromise = gateway.initialize();
    await Promise.resolve();
    transport.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        userAgent: "codex-test"
      }
    });
    await initializePromise;

    const createThreadPromise = gateway.createThread("general", "Test thread", {
      settings: {
        model: "gpt-5.3-codex",
        reasoningEffort: "high",
        serviceTier: "fast",
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "dangerFullAccess"
        }
      }
    });
    await Promise.resolve();

    expect(transport.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "thread/start",
      id: 2,
      params: {
        cwd: "/workspace",
        model: "gpt-5.3-codex",
        modelProvider: null,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        config: {
          model_reasoning_effort: "high"
        },
        serviceName: "telegram-codex-bridge",
        baseInstructions: null,
        developerInstructions: null,
        experimentalRawEvents: false,
        persistExtendedHistory: false,
        ephemeral: false,
        personality: null,
        serviceTier: "fast"
      }
    });

    transport.emitMessage({
      jsonrpc: "2.0",
      id: 2,
      result: {
        thread: {
          id: "thread-1",
          preview: "",
          ephemeral: false,
          modelProvider: "openai",
          createdAt: 1,
          updatedAt: 1,
          status: "idle",
          path: null,
          cwd: "/workspace",
          cliVersion: "0.0.0",
          source: "appServer",
          agentNickname: null,
          agentRole: null,
          gitInfo: {
            sha: null,
            branch: "main",
            originUrl: null
          },
          name: null,
          turns: []
        },
        model: "gpt-5.3-codex",
        modelProvider: "openai",
        serviceTier: "fast",
        cwd: "/workspace",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: {
          type: "dangerFullAccess"
        },
        reasoningEffort: "high"
      }
    });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    transport.emitMessage({
      jsonrpc: "2.0",
      id: 3,
      result: {}
    });

    await expect(createThreadPromise).resolves.toEqual({
      threadId: "thread-1",
      branch: "main",
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
      serviceTier: "fast",
      cwd: "/workspace",
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "dangerFullAccess"
      }
    });
  });

  it("starts thread compaction with thread/compact/start", async () => {
    const transport = new FakeTransport();
    const client = new CodexRpcClient(transport);
    const gateway = new CodexGateway(client, {
      defaultCwd: "/workspace",
      model: undefined,
      modelProvider: undefined,
      sandbox: undefined,
      approvalPolicy: undefined,
      serviceName: "telegram-codex-bridge",
      baseInstructions: undefined,
      developerInstructions: undefined,
      config: undefined
    });

    const compactPromise = gateway.compactThread("thread-1");
    await Promise.resolve();

    expect(transport.sent).toEqual([
      {
        jsonrpc: "2.0",
        method: "thread/compact/start",
        id: 1,
        params: {
          threadId: "thread-1"
        }
      }
    ]);

    transport.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {}
    });

    await expect(compactPromise).resolves.toBeUndefined();
  });

  it("reads thread metadata with thread/read and includeTurns disabled", async () => {
    const transport = new FakeTransport();
    const client = new CodexRpcClient(transport);
    const gateway = new CodexGateway(client, {
      defaultCwd: "/workspace",
      model: undefined,
      modelProvider: undefined,
      sandbox: undefined,
      approvalPolicy: undefined,
      serviceName: "telegram-codex-bridge",
      baseInstructions: undefined,
      developerInstructions: undefined,
      config: undefined
    });

    const readPromise = gateway.readThread("thread-1");
    await Promise.resolve();

    expect(transport.sent).toEqual([
      {
        jsonrpc: "2.0",
        method: "thread/read",
        id: 1,
        params: {
          threadId: "thread-1",
          includeTurns: false
        }
      }
    ]);

    transport.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        thread: {
          id: "thread-1",
          preview: "",
          ephemeral: false,
          modelProvider: "openai",
          createdAt: 1,
          updatedAt: 1,
          status: "idle",
          path: null,
          cwd: "/workspace/packages/kirbot-core",
          cliVersion: "0.0.0",
          source: "appServer",
          agentNickname: null,
          agentRole: null,
          gitInfo: {
            sha: null,
            branch: "main",
            originUrl: null
          },
          name: "Fresh Thread",
          turns: []
        }
      }
    });

    await expect(readPromise).resolves.toEqual({
      name: "Fresh Thread",
      cwd: "/workspace/packages/kirbot-core"
    });
  });

  it("omits null reasoning effort from thread/start overrides", async () => {
    const transport = new FakeTransport();
    const client = new CodexRpcClient(transport);
    const gateway = new CodexGateway(client, {
      defaultCwd: "/workspace",
      model: undefined,
      modelProvider: undefined,
      sandbox: undefined,
      approvalPolicy: undefined,
      serviceName: "telegram-codex-bridge",
      baseInstructions: undefined,
      developerInstructions: undefined,
      config: undefined
    });

    const initializePromise = gateway.initialize();
    await Promise.resolve();
    transport.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        userAgent: "codex-test"
      }
    });
    await initializePromise;

    const createThreadPromise = gateway.createThread("general", "Test thread", {
      settings: {
        model: "gpt-5.3-codex",
        reasoningEffort: null,
        serviceTier: null,
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "dangerFullAccess"
        }
      }
    });
    await Promise.resolve();

    expect(transport.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "thread/start",
      id: 2,
      params: {
        cwd: "/workspace",
        model: "gpt-5.3-codex",
        modelProvider: null,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        config: null,
        serviceName: "telegram-codex-bridge",
        baseInstructions: null,
        developerInstructions: null,
        experimentalRawEvents: false,
        persistExtendedHistory: false,
        ephemeral: false,
        personality: null,
        serviceTier: null
      }
    });

    transport.emitMessage({
      jsonrpc: "2.0",
      id: 2,
      result: {
        thread: {
          id: "thread-1",
          preview: "",
          ephemeral: false,
          modelProvider: "openai",
          createdAt: 1,
          updatedAt: 1,
          status: "idle",
          path: null,
          cwd: "/workspace",
          cliVersion: "0.0.0",
          source: "appServer",
          agentNickname: null,
          agentRole: null,
          gitInfo: {
            sha: null,
            branch: "main",
            originUrl: null
          },
          name: null,
          turns: []
        },
        model: "gpt-5.3-codex",
        modelProvider: "openai",
        serviceTier: null,
        cwd: "/workspace",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: {
          type: "dangerFullAccess"
        },
        reasoningEffort: null
      }
    });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    transport.emitMessage({
      jsonrpc: "2.0",
      id: 3,
      result: {}
    });

    await expect(createThreadPromise).resolves.toEqual({
      threadId: "thread-1",
      branch: "main",
      model: "gpt-5.3-codex",
      reasoningEffort: null,
      serviceTier: null,
      cwd: "/workspace",
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "dangerFullAccess"
      }
    });
  });

  it("does not pass managed global config back into thread/start when no per-thread override is requested", async () => {
    const transport = new FakeTransport();
    const client = new CodexRpcClient(transport);
    const gateway = new CodexGateway(client, {
      defaultCwd: "/workspace",
      homePath: "/srv/kirbot/data/codex-home",
      model: "gpt-5-codex",
      modelProvider: "openai",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      serviceName: "telegram-codex-bridge",
      baseInstructions: undefined,
      developerInstructions: undefined,
      config: {
        model_provider: "openai",
        sandbox_workspace_write: {
          writable_roots: ["/workspace"],
          network_access: true,
          exclude_tmpdir_env_var: false,
          exclude_slash_tmp: false
        }
      }
    });

    const initializePromise = gateway.initialize();
    await Promise.resolve();
    transport.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        userAgent: "codex-test"
      }
    });
    await initializePromise;

    const createThreadPromise = gateway.createThread("general", "Test thread");
    await Promise.resolve();

    expect(transport.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "thread/start",
      id: 2,
      params: {
        cwd: "/workspace",
        model: null,
        modelProvider: null,
        approvalPolicy: null,
        sandbox: null,
        config: null,
        serviceName: "telegram-codex-bridge",
        baseInstructions: null,
        developerInstructions: null,
        experimentalRawEvents: false,
        persistExtendedHistory: false,
        ephemeral: false,
        personality: null,
        serviceTier: null
      }
    });

    transport.emitMessage({
      jsonrpc: "2.0",
      id: 2,
      result: {
        thread: {
          id: "thread-1",
          preview: "",
          ephemeral: false,
          modelProvider: "openai",
          createdAt: 1,
          updatedAt: 1,
          status: "idle",
          path: null,
          cwd: "/workspace",
          cliVersion: "0.0.0",
          source: "appServer",
          agentNickname: null,
          agentRole: null,
          gitInfo: {
            sha: null,
            branch: "main",
            originUrl: null
          },
          name: null,
          turns: []
        },
        model: "gpt-5-codex",
        modelProvider: "openai",
        serviceTier: null,
        cwd: "/workspace",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: {
          type: "dangerFullAccess"
        },
        reasoningEffort: null
      }
    });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    transport.emitMessage({
      jsonrpc: "2.0",
      id: 3,
      result: {}
    });

    await expect(createThreadPromise).resolves.toMatchObject({
      threadId: "thread-1",
      approvalPolicy: "never"
    });
  });

  it("prefers final-answer agent messages when reading a completed turn snapshot", async () => {
    const transport = new FakeTransport();
    const client = new CodexRpcClient(transport);
    const gateway = new CodexGateway(client, {
      defaultCwd: "/workspace",
      model: undefined,
      modelProvider: undefined,
      sandbox: undefined,
      approvalPolicy: undefined,
      serviceName: "telegram-codex-bridge",
      baseInstructions: undefined,
      developerInstructions: undefined,
      config: undefined
    });

    const initializePromise = gateway.initialize();
    await Promise.resolve();
    transport.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        userAgent: "codex-test"
      }
    });
    await initializePromise;

    const readPromise = gateway.readTurnSnapshot("thread-1", "turn-1");
    await Promise.resolve();

    expect(transport.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "thread/read",
      id: 2,
      params: {
        threadId: "thread-1",
        includeTurns: true
      }
    });

    transport.emitMessage({
      jsonrpc: "2.0",
      id: 2,
      result: {
        thread: {
          id: "thread-1",
          cwd: "/workspace",
          gitInfo: {
            branch: "main"
          },
          turns: [
            {
              id: "turn-1",
              items: [
                {
                  type: "agentMessage",
                  id: "item-1",
                  text: "Inspecting files",
                  phase: "commentary"
                },
                {
                  type: "agentMessage",
                  id: "item-2",
                  text: "Ship this patch.",
                  phase: "final_answer"
                }
              ]
            }
          ]
        }
      }
    });

    await expect(readPromise).resolves.toEqual({
      text: "Ship this patch.",
      assistantText: "Ship this patch.",
      planText: "",
      changedFiles: 0,
      cwd: "/workspace",
      branch: "main"
    });
  });

  it("does not treat commentary as final assistant output when plan items are present", async () => {
    const transport = new FakeTransport();
    const client = new CodexRpcClient(transport);
    const gateway = new CodexGateway(client, {
      defaultCwd: "/workspace",
      model: undefined,
      modelProvider: undefined,
      sandbox: undefined,
      approvalPolicy: undefined,
      serviceName: "telegram-codex-bridge",
      baseInstructions: undefined,
      developerInstructions: undefined,
      config: undefined
    });

    const initializePromise = gateway.initialize();
    await Promise.resolve();
    transport.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        userAgent: "codex-test"
      }
    });
    await initializePromise;

    const readPromise = gateway.readTurnSnapshot("thread-1", "turn-1");
    await Promise.resolve();

    transport.emitMessage({
      jsonrpc: "2.0",
      id: 2,
      result: {
        thread: {
          id: "thread-1",
          cwd: "/workspace",
          gitInfo: {
            branch: "main"
          },
          turns: [
            {
              id: "turn-1",
              items: [
                {
                  type: "agentMessage",
                  id: "item-1",
                  text: "Inspecting files",
                  phase: "commentary"
                },
                {
                  type: "plan",
                  id: "plan-1",
                  text: "1. Draft the rollout"
                }
              ]
            }
          ]
        }
      }
    });

    await expect(readPromise).resolves.toEqual({
      text: "1. Draft the rollout",
      assistantText: "",
      planText: "1. Draft the rollout",
      changedFiles: 0,
      cwd: "/workspace",
      branch: "main"
    });
  });

  it("prefers the cached live thread cwd over thread/read cwd when reading a turn snapshot", async () => {
    const transport = new FakeTransport();
    const client = new CodexRpcClient(transport);
    const gateway = new CodexGateway(client, {
      defaultCwd: "/workspace",
      model: undefined,
      modelProvider: undefined,
      sandbox: undefined,
      approvalPolicy: undefined,
      serviceName: "telegram-codex-bridge",
      baseInstructions: undefined,
      developerInstructions: undefined,
      config: undefined
    });

    const initializePromise = gateway.initialize();
    await Promise.resolve();
    transport.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        userAgent: "codex-test"
      }
    });
    await initializePromise;

    const resumePromise = gateway.ensureThreadLoaded("thread-1");
    await Promise.resolve();

    expect(transport.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "thread/resume",
      id: 2,
      params: {
        threadId: "thread-1",
        persistExtendedHistory: false
      }
    });

    transport.emitMessage({
      jsonrpc: "2.0",
      id: 2,
      result: {
        thread: {
          id: "thread-1"
        },
        model: "gpt-5-codex",
        modelProvider: "openai",
        serviceTier: null,
        cwd: "/live-cwd",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: {
          type: "workspaceWrite",
          writableRoots: [],
          readOnlyAccess: {
            type: "fullAccess"
          },
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false
        },
        reasoningEffort: null
      }
    });

    await expect(resumePromise).resolves.toMatchObject({
      cwd: "/live-cwd"
    });

    const readPromise = gateway.readTurnSnapshot("thread-1", "turn-1");
    await Promise.resolve();

    transport.emitMessage({
      jsonrpc: "2.0",
      id: 3,
      result: {
        thread: {
          id: "thread-1",
          cwd: "/snapshot-cwd",
          gitInfo: {
            branch: "main"
          },
          turns: [
            {
              id: "turn-1",
              items: [
                {
                  type: "agentMessage",
                  id: "item-1",
                  text: "Final answer",
                  phase: "final_answer"
                }
              ]
            }
          ]
        }
      }
    });

    await expect(readPromise).resolves.toEqual({
      text: "Final answer",
      assistantText: "Final answer",
      planText: "",
      changedFiles: 0,
      cwd: "/live-cwd",
      branch: "main"
    });
  });

  it.each([
    "thread/archived",
    "thread/closed"
  ] as const)("reloads a thread after %s notifications clear the cache", async (method) => {
    const transport = new FakeTransport();
    const client = new CodexRpcClient(transport);
    const gateway = new CodexGateway(client, {
      defaultCwd: "/workspace",
      model: undefined,
      modelProvider: undefined,
      sandbox: undefined,
      approvalPolicy: undefined,
      serviceName: "telegram-codex-bridge",
      baseInstructions: undefined,
      developerInstructions: undefined,
      config: undefined
    });

    const initializePromise = gateway.initialize();
    await Promise.resolve();
    transport.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        userAgent: "codex-test"
      }
    });
    await initializePromise;

    const firstLoad = gateway.ensureThreadLoaded("thread-1");
    await Promise.resolve();
    expect(transport.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "thread/resume",
      id: 2,
      params: {
        threadId: "thread-1",
        persistExtendedHistory: false
      }
    });

    transport.emitMessage({
      jsonrpc: "2.0",
      id: 2,
      result: {
        thread: {
          id: "thread-1"
        },
        model: "gpt-5-codex",
        modelProvider: "openai",
        serviceTier: null,
        cwd: "/workspace",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: {
          type: "workspaceWrite",
          writableRoots: [],
          readOnlyAccess: {
            type: "fullAccess"
          },
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false
        },
        reasoningEffort: null
      }
    });
    await expect(firstLoad).resolves.toMatchObject({ cwd: "/workspace" });

    transport.emitMessage({
      jsonrpc: "2.0",
      method,
      params: {
        threadId: "thread-1"
      }
    });
    await expect(gateway.nextEvent()).resolves.toEqual({
      kind: "notification",
      notification: {
        jsonrpc: "2.0",
        method,
        params: {
          threadId: "thread-1"
        }
      }
    });

    const secondLoad = gateway.ensureThreadLoaded("thread-1");
    await Promise.resolve();
    expect(transport.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "thread/resume",
      id: 3,
      params: {
        threadId: "thread-1",
        persistExtendedHistory: false
      }
    });

    transport.emitMessage({
      jsonrpc: "2.0",
      id: 3,
      result: {
        thread: {
          id: "thread-1"
        },
        model: "gpt-5-codex",
        modelProvider: "openai",
        serviceTier: null,
        cwd: "/workspace",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: {
          type: "workspaceWrite",
          writableRoots: [],
          readOnlyAccess: {
            type: "fullAccess"
          },
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false
        },
        reasoningEffort: null
      }
    });
    await expect(secondLoad).resolves.toMatchObject({ cwd: "/workspace" });
  });

  it("updates cached thread settings on model/rerouted notifications", async () => {
    const transport = new FakeTransport();
    const client = new CodexRpcClient(transport);
    const gateway = new CodexGateway(client, {
      defaultCwd: "/workspace",
      model: undefined,
      modelProvider: undefined,
      sandbox: undefined,
      approvalPolicy: undefined,
      serviceName: "telegram-codex-bridge",
      baseInstructions: undefined,
      developerInstructions: undefined,
      config: undefined
    });

    const initializePromise = gateway.initialize();
    await Promise.resolve();
    transport.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        userAgent: "codex-test"
      }
    });
    await initializePromise;

    const firstLoad = gateway.ensureThreadLoaded("thread-1");
    await Promise.resolve();
    transport.emitMessage({
      jsonrpc: "2.0",
      id: 2,
      result: {
        thread: {
          id: "thread-1"
        },
        model: "gpt-5-codex",
        modelProvider: "openai",
        serviceTier: null,
        cwd: "/workspace",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: {
          type: "workspaceWrite",
          writableRoots: [],
          readOnlyAccess: {
            type: "fullAccess"
          },
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false
        },
        reasoningEffort: null
      }
    });
    await expect(firstLoad).resolves.toMatchObject({ model: "gpt-5-codex" });

    transport.emitMessage({
      jsonrpc: "2.0",
      method: "model/rerouted",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        toModel: "gpt-5.3-codex"
      }
    });
    await expect(gateway.nextEvent()).resolves.toEqual({
      kind: "notification",
      notification: {
        jsonrpc: "2.0",
        method: "model/rerouted",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          toModel: "gpt-5.3-codex"
        }
      }
    });

    await expect(gateway.ensureThreadLoaded("thread-1")).resolves.toMatchObject({
      model: "gpt-5.3-codex"
    });
    expect(transport.sent.filter((message) => typeof message === "object" && message !== null && "method" in message && message.method === "thread/resume")).toHaveLength(1);
  });

  it("passes collaborationMode through on turn/start when provided", async () => {
    const transport = new FakeTransport();
    const client = new CodexRpcClient(transport);
    const gateway = new CodexGateway(client, {
      defaultCwd: "/workspace",
      model: undefined,
      modelProvider: undefined,
      sandbox: undefined,
      approvalPolicy: undefined,
      serviceName: "telegram-codex-bridge",
      baseInstructions: undefined,
      developerInstructions: undefined,
      config: undefined
    });

    const initializePromise = gateway.initialize();
    await Promise.resolve();
    transport.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        userAgent: "codex-test"
      }
    });
    await initializePromise;

    void gateway.sendTurn("thread-1", [
      {
        type: "text",
        text: "plan this change",
        text_elements: []
      }
    ], {
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5-codex",
          reasoning_effort: "high",
          developer_instructions: null
        }
      }
    });
    await Promise.resolve();

    expect(transport.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "turn/start",
      id: 2,
      params: {
        threadId: "thread-1",
        input: [
          {
            type: "text",
            text: "plan this change",
            text_elements: []
          }
        ],
        collaborationMode: {
          mode: "plan",
          settings: {
            model: "gpt-5-codex",
            reasoning_effort: "high",
            developer_instructions: null
          }
        }
      }
    });
  });

  it("passes local image inputs through on turn/start", async () => {
    const transport = new FakeTransport();
    const client = new CodexRpcClient(transport);
    const gateway = new CodexGateway(client, {
      defaultCwd: "/workspace",
      model: undefined,
      modelProvider: undefined,
      sandbox: undefined,
      approvalPolicy: undefined,
      serviceName: "telegram-codex-bridge",
      baseInstructions: undefined,
      developerInstructions: undefined,
      config: undefined
    });

    const initializePromise = gateway.initialize();
    await Promise.resolve();
    transport.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        userAgent: "codex-test"
      }
    });
    await initializePromise;

    void gateway.sendTurn("thread-1", [
      {
        type: "text",
        text: "inspect this image",
        text_elements: []
      },
      {
        type: "localImage",
        path: "/tmp/test-image.png"
      }
    ]);
    await Promise.resolve();

    expect(transport.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "turn/start",
      id: 2,
      params: {
        threadId: "thread-1",
        input: [
          {
            type: "text",
            text: "inspect this image",
            text_elements: []
          },
          {
            type: "localImage",
            path: "/tmp/test-image.png"
          }
        ]
      }
    });
  });

  it("passes native turn-start overrides through when provided", async () => {
    const transport = new FakeTransport();
    const client = new CodexRpcClient(transport);
    const gateway = new CodexGateway(client, {
      defaultCwd: "/workspace",
      model: undefined,
      modelProvider: undefined,
      sandbox: undefined,
      approvalPolicy: undefined,
      serviceName: "telegram-codex-bridge",
      baseInstructions: undefined,
      developerInstructions: undefined,
      config: undefined
    });

    const initializePromise = gateway.initialize();
    await Promise.resolve();
    transport.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        userAgent: "codex-test"
      }
    });
    await initializePromise;

    void gateway.sendTurn("thread-1", [
      {
        type: "text",
        text: "use custom settings",
        text_elements: []
      }
    ], {
      overrides: {
        model: "gpt-5.3-codex",
        reasoningEffort: "high",
        serviceTier: "fast",
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "dangerFullAccess"
        }
      }
    });
    await Promise.resolve();

    expect(transport.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "turn/start",
      id: 2,
      params: {
        threadId: "thread-1",
        input: [
          {
            type: "text",
            text: "use custom settings",
            text_elements: []
          }
        ],
        model: "gpt-5.3-codex",
        effort: "high",
        serviceTier: "fast",
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "dangerFullAccess"
        }
      }
    });
  });

  it("passes local image inputs through on turn/steer", async () => {
    const transport = new FakeTransport();
    const client = new CodexRpcClient(transport);
    const gateway = new CodexGateway(client, {
      defaultCwd: "/workspace",
      model: undefined,
      modelProvider: undefined,
      sandbox: undefined,
      approvalPolicy: undefined,
      serviceName: "telegram-codex-bridge",
      baseInstructions: undefined,
      developerInstructions: undefined,
      config: undefined
    });

    const initializePromise = gateway.initialize();
    await Promise.resolve();
    transport.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        userAgent: "codex-test"
      }
    });
    await initializePromise;

    void gateway.steerTurn("thread-1", "turn-1", [
      {
        type: "localImage",
        path: "/tmp/test-image.png"
      }
    ]);
    await Promise.resolve();

    expect(transport.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "turn/steer",
      id: 2,
      params: {
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        input: [
          {
            type: "localImage",
            path: "/tmp/test-image.png"
          }
        ]
      }
    });
  });

  it("reads global settings through config/read", async () => {
    const transport = new FakeTransport();
    const client = new CodexRpcClient(transport);
    const gateway = new CodexGateway(client, {
      defaultCwd: "/workspace",
      model: undefined,
      modelProvider: undefined,
      sandbox: undefined,
      approvalPolicy: undefined,
      serviceName: "telegram-codex-bridge",
      baseInstructions: undefined,
      developerInstructions: undefined,
      config: undefined
    });

    const initializePromise = gateway.initialize();
    await Promise.resolve();
    transport.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        userAgent: "codex-test"
      }
    });
    await initializePromise;

    const settingsPromise = gateway.readProfileSettings("general");
    await Promise.resolve();

    expect(transport.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "config/read",
      id: 2,
      params: {
        includeLayers: false
      }
    });

    transport.emitMessage({
      jsonrpc: "2.0",
      id: 2,
      result: {
        config: {
          model: "gpt-5.3-codex",
          approval_policy: "never",
          sandbox_mode: "danger-full-access",
          sandbox_workspace_write: null,
          model_reasoning_effort: "high",
          service_tier: "fast"
        },
        origins: {},
        layers: null
      }
    });

    await expect(settingsPromise).resolves.toEqual({
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
      serviceTier: "fast",
      cwd: "/workspace",
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "dangerFullAccess"
      }
    });
  });

  it("updates global settings through config/batchWrite without reloading loaded threads", async () => {
    const transport = new FakeTransport();
    const client = new CodexRpcClient(transport);
    const gateway = new CodexGateway(client, {
      defaultCwd: "/workspace",
      model: undefined,
      modelProvider: undefined,
      sandbox: undefined,
      approvalPolicy: undefined,
      serviceName: "telegram-codex-bridge",
      baseInstructions: undefined,
      developerInstructions: undefined,
      config: undefined
    });

    const initializePromise = gateway.initialize();
    await Promise.resolve();
    transport.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        userAgent: "codex-test"
      }
    });
    await initializePromise;

    const settingsPromise = gateway.updateProfileSettings("general", {
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
      serviceTier: "fast"
    });
    await Promise.resolve();

    expect(transport.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "config/batchWrite",
      id: 2,
      params: {
        edits: [
          {
            keyPath: "model",
            value: "gpt-5.3-codex",
            mergeStrategy: "replace"
          },
          {
            keyPath: "model_reasoning_effort",
            value: "high",
            mergeStrategy: "replace"
          },
          {
            keyPath: "service_tier",
            value: "fast",
            mergeStrategy: "replace"
          }
        ]
      }
    });

    transport.emitMessage({
      jsonrpc: "2.0",
      id: 2,
      result: {
        status: "ok",
        version: "v2",
        filePath: "/home/test/.codex/config.toml",
        overriddenMetadata: null
      }
    });
    for (let attempt = 0; attempt < 10 && transport.sent.length < 4; attempt += 1) {
      await Promise.resolve();
    }

    expect(transport.sent[3]).toEqual({
      jsonrpc: "2.0",
      method: "config/read",
      id: 3,
      params: {
        includeLayers: false
      }
    });

    transport.emitMessage({
      jsonrpc: "2.0",
      id: 3,
      result: {
        config: {
          model: "gpt-5.3-codex",
          approval_policy: "on-request",
          sandbox_mode: "workspace-write",
          sandbox_workspace_write: {
            writable_roots: [],
            network_access: false,
            exclude_tmpdir_env_var: false,
            exclude_slash_tmp: false
          },
          model_reasoning_effort: "high",
          service_tier: "fast"
        },
        origins: {},
        layers: null
      }
    });

    await expect(settingsPromise).resolves.toEqual({
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
      serviceTier: "fast",
      cwd: "/workspace",
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [],
        readOnlyAccess: {
          type: "fullAccess"
        },
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false
      }
    });
  });

  it("responds to permissions approval requests with a JSON-RPC result", async () => {
    const transport = new FakeTransport();
    const client = new CodexRpcClient(transport);
    const gateway = new CodexGateway(client, {
      defaultCwd: "/workspace",
      model: undefined,
      modelProvider: undefined,
      sandbox: undefined,
      approvalPolicy: undefined,
      serviceName: "telegram-codex-bridge",
      baseInstructions: undefined,
      developerInstructions: undefined,
      config: undefined
    });

    await gateway.respondToPermissionsApproval(7, {
      permissions: {
        fileSystem: {
          read: null,
          write: ["/tmp/export"]
        }
      },
      scope: "session"
    });

    expect(transport.sent).toEqual([
      {
        jsonrpc: "2.0",
        id: 7,
        result: {
          permissions: {
            fileSystem: {
              read: null,
              write: ["/tmp/export"]
            }
          },
          scope: "session"
        }
      }
    ]);
  });

  it("lists visible models across paginated model/list responses", async () => {
    const transport = new FakeTransport();
    const client = new CodexRpcClient(transport);
    const gateway = new CodexGateway(client, {
      defaultCwd: "/workspace",
      model: undefined,
      modelProvider: undefined,
      sandbox: undefined,
      approvalPolicy: undefined,
      serviceName: "telegram-codex-bridge",
      baseInstructions: undefined,
      developerInstructions: undefined,
      config: undefined
    });

    const initializePromise = gateway.initialize();
    await Promise.resolve();
    transport.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        userAgent: "codex-test"
      }
    });
    await initializePromise;

    const listPromise = gateway.listModels("general");
    await Promise.resolve();

    expect(transport.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "model/list",
      id: 2,
      params: {
        limit: 100,
        includeHidden: false
      }
    });

    transport.emitMessage({
      jsonrpc: "2.0",
      id: 2,
      result: {
        data: [
          {
            id: "model-1",
            model: "gpt-5-codex",
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            displayName: "gpt-5-codex",
            description: "Default model",
            hidden: false,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: "medium",
            inputModalities: [],
            supportsPersonality: false,
            isDefault: true
          }
        ],
        nextCursor: "cursor-2"
      }
    });
    await waitFor(() =>
      transport.sent.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "method" in message &&
          message.method === "model/list" &&
          "params" in message &&
          typeof message.params === "object" &&
          message.params !== null &&
          "cursor" in message.params &&
          message.params.cursor === "cursor-2"
      )
    );

    expect(transport.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "model/list",
      id: 3,
      params: {
        limit: 100,
        includeHidden: false,
        cursor: "cursor-2"
      }
    });

    transport.emitMessage({
      jsonrpc: "2.0",
      id: 3,
      result: {
        data: [
          {
            id: "model-2",
            model: "gpt-5.3-codex",
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            displayName: "gpt-5.3-codex",
            description: "Alternative model",
            hidden: false,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: "low",
            inputModalities: [],
            supportsPersonality: false,
            isDefault: false
          }
        ],
        nextCursor: null
      }
    });

    await expect(listPromise).resolves.toMatchObject([
      {
        model: "gpt-5-codex"
      },
      {
        model: "gpt-5.3-codex"
      }
    ]);
  });
});

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start >= timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms`);
    }
    await Promise.resolve();
  }
}
