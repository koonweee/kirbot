import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CodexGateway, spawnCodexAppServer } from "../src/codex";
import { resolvePinnedCodexExecutablePath } from "../src/codex-cli";
import { CodexRpcClient, StdioRpcTransport, type RpcTransport } from "../src/rpc";

class FakeTransport implements RpcTransport {
  readonly sent: unknown[] = [];
  #messageListener: ((message: unknown) => void) | null = null;
  #closeListener: (() => void) | null = null;
  #errorListener: ((error: Error) => void) | null = null;

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

  onError(listener: (error: Error) => void): void {
    this.#errorListener = listener;
  }

  emitMessage(message: unknown): void {
    this.#messageListener?.(message);
  }
}

describe("CodexGateway", () => {
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

  it("passes null instruction fields to thread/start when config does not provide them", async () => {
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

    void gateway.createThread("Test thread");
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

    const listPromise = gateway.listModels();
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
