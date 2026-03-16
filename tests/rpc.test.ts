import { describe, expect, it } from "vitest";

import { CodexRpcClient, JsonRpcMethodError, type RpcTransport } from "../src/rpc";

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

  emitError(error: Error): void {
    this.#errorListener?.(error);
  }
}

describe("CodexRpcClient", () => {
  it("correlates requests and surfaces notifications", async () => {
    const transport = new FakeTransport();
    const client = new CodexRpcClient(transport);

    const notifications: unknown[] = [];
    client.on("notification", (notification) => notifications.push(notification));

    const initializePromise = client.initialize({
      clientInfo: {
        name: "test",
        title: "Test",
        version: "0.1.0"
      },
      capabilities: null
    });
    await Promise.resolve();

    expect(transport.sent).toEqual([
      {
        jsonrpc: "2.0",
        method: "initialize",
        id: 1,
        params: {
          clientInfo: {
            name: "test",
            title: "Test",
            version: "0.1.0"
          },
          capabilities: null
        }
      }
    ]);

    transport.emitMessage({
      method: "thread/started",
      params: {
        thread: {
          id: "thread-1",
          title: "Hello",
          ephemeral: false,
          modelProvider: "openai",
          createdAt: 1,
          updatedAt: 1,
          status: "ready",
          path: null,
          cwd: "/workspace",
          cliVersion: "0.0.0",
          source: "appServer",
          origin: null,
          gitInfo: null,
          threadName: "Hello",
          turns: []
        }
      }
    });

    transport.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        userAgent: "codex-test"
      }
    });

    await expect(initializePromise).resolves.toEqual({
      userAgent: "codex-test"
    });
    expect(notifications).toHaveLength(1);
  });

  it("sends turn/steer requests with typed params", async () => {
    const transport = new FakeTransport();
    const client = new CodexRpcClient(transport);

    const steerPromise = client.steerTurn({
      threadId: "thread-1",
      expectedTurnId: "turn-9",
      input: [
        {
          type: "text",
          text: "Follow up",
          text_elements: []
        }
      ]
    });
    await Promise.resolve();

    expect(transport.sent).toEqual([
      {
        jsonrpc: "2.0",
        method: "turn/steer",
        id: 1,
        params: {
          threadId: "thread-1",
          expectedTurnId: "turn-9",
          input: [
            {
              type: "text",
              text: "Follow up",
              text_elements: []
            }
          ]
        }
      }
    ]);

    transport.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        turnId: "turn-9"
      }
    });

    await expect(steerPromise).resolves.toEqual({
      turnId: "turn-9"
    });
  });

  it("rejects pending requests when the transport closes", async () => {
    const transport = new FakeTransport();
    const client = new CodexRpcClient(transport);

    const initializePromise = client.initialize({
      clientInfo: {
        name: "test",
        title: "Test",
        version: "0.1.0"
      },
      capabilities: null
    });
    await Promise.resolve();

    await transport.close();

    await expect(initializePromise).rejects.toThrow("Codex app server transport closed");
  });

  it("surfaces JSON-RPC errors with method metadata", async () => {
    const transport = new FakeTransport();
    const client = new CodexRpcClient(transport);

    const steerPromise = client.steerTurn({
      threadId: "thread-1",
      expectedTurnId: "turn-9",
      input: [
        {
          type: "text",
          text: "Follow up",
          text_elements: []
        }
      ]
    });
    await Promise.resolve();

    transport.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32600,
        message: "expectedTurnId does not match the current active turn",
        data: {
          kind: "invalid_active_turn"
        }
      }
    });

    await expect(steerPromise).rejects.toMatchObject({
      name: "JsonRpcMethodError",
      method: "turn/steer",
      code: -32600,
      data: {
        kind: "invalid_active_turn"
      },
      message: "expectedTurnId does not match the current active turn"
    });
  });
});
