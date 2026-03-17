import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CodexGateway } from "../src/codex";
import { resolvePinnedCodexExecutablePath } from "../src/codex-cli";
import { CodexRpcClient, type RpcTransport } from "../src/rpc";

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

  it("initializes with explicit capabilities to match codex-cli", async () => {
    const transport = new FakeTransport();
    const client = new CodexRpcClient(transport);
    const gateway = new CodexGateway(client, {
      appServerUrl: "ws://127.0.0.1:8787",
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
            experimentalApi: false
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
      appServerUrl: "ws://127.0.0.1:8787",
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

  it("prefers final-answer agent messages when reading a completed turn", async () => {
    const transport = new FakeTransport();
    const client = new CodexRpcClient(transport);
    const gateway = new CodexGateway(client, {
      appServerUrl: "ws://127.0.0.1:8787",
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

    const readPromise = gateway.readTurnMessages("thread-1", "turn-1");
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

    await expect(readPromise).resolves.toBe("Ship this patch.");
  });
});
