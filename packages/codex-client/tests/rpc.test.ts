import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { CodexRpcClient, StdioRpcTransport, type RpcTransport } from "../src/rpc";

class FakeTransport implements RpcTransport {
  readonly sent: unknown[] = [];
  #messageListener: ((message: unknown) => void) | null = null;
  #closeListener: (() => void) | null = null;
  #errorListener: ((error: Error) => void) | null = null;
  onSend: ((message: unknown) => Promise<void> | void) | null = null;

  async connect(): Promise<void> {}

  async close(): Promise<void> {
    this.#closeListener?.();
  }

  async send(message: unknown): Promise<void> {
    this.sent.push(message);
    await this.onSend?.(message);
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

class FakeStdioChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
}

describe("StdioRpcTransport", () => {
  it("writes newline-delimited JSON payloads to stdin", async () => {
    const child = new FakeStdioChild();
    const transport = new StdioRpcTransport(child as never);

    let written = "";
    child.stdin.setEncoding("utf8");
    child.stdin.on("data", (chunk) => {
      written += chunk;
    });

    await transport.connect();
    await transport.send({
      jsonrpc: "2.0",
      method: "initialized"
    });

    expect(written).toBe('{"jsonrpc":"2.0","method":"initialized"}\n');
  });

  it("parses newline-delimited messages from stdout", async () => {
    const child = new FakeStdioChild();
    const transport = new StdioRpcTransport(child as never);

    const received: unknown[] = [];
    transport.onMessage((message) => received.push(message));

    await transport.connect();
    child.stdout.write("\n");
    child.stdout.write('{"method":"thread/started","params":{"thread":{"id":"thread-1"}}}\n');

    expect(received).toEqual([
      {
        method: "thread/started",
        params: {
          thread: {
            id: "thread-1"
          }
        }
      }
    ]);
  });

  it("surfaces invalid JSON as a transport error and closes the transport", async () => {
    const child = new FakeStdioChild();
    const transport = new StdioRpcTransport(child as never);

    const errors: Error[] = [];
    let closeCount = 0;
    transport.onError((error) => errors.push(error));
    transport.onClose(() => {
      closeCount += 1;
    });

    await transport.connect();
    child.stdout.write("{not-json}\n");

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("invalid JSON");
    expect(closeCount).toBe(1);
  });

  it("treats child exit as a transport failure", async () => {
    const child = new FakeStdioChild();
    const transport = new StdioRpcTransport(child as never);

    const errors: Error[] = [];
    let closeCount = 0;
    transport.onError((error) => errors.push(error));
    transport.onClose(() => {
      closeCount += 1;
    });

    await transport.connect();
    child.emit("exit", 7, null);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("code 7");
    expect(closeCount).toBe(1);
  });
});

describe("CodexRpcClient", () => {
  it("completes the initialize handshake with an initialized notification", async () => {
    const transport = new FakeTransport();
    const client = new CodexRpcClient(transport);

    const initializePromise = client.initialize({
      clientInfo: {
        name: "test",
        title: "Test",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
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
    await initializePromise;

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
          capabilities: {
            experimentalApi: true
          }
        }
      },
      {
        jsonrpc: "2.0",
        method: "initialized"
      }
    ]);
  });

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

  it("tracks pending requests before send completes so fast responses are not dropped", async () => {
    const transport = new FakeTransport();
    const client = new CodexRpcClient(transport);

    transport.onSend = (message) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "method" in message &&
        message.method === "turn/steer" &&
        "id" in message
      ) {
        transport.emitMessage({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            turnId: "turn-9"
          }
        });
      }
    };

    await expect(
      client.steerTurn({
        threadId: "thread-1",
        expectedTurnId: "turn-9",
        input: [
          {
            type: "text",
            text: "Follow up",
            text_elements: []
          }
        ]
      })
    ).resolves.toEqual({
      turnId: "turn-9"
    });
  });

  it("buffers initialize-phase events until the handshake is completed", async () => {
    const transport = new FakeTransport();
    const client = new CodexRpcClient(transport);

    const notifications: unknown[] = [];
    const serverRequests: unknown[] = [];
    client.on("notification", (notification) => notifications.push(notification));
    client.on("serverRequest", (request) => serverRequests.push(request));

    const initializePromise = client.initialize({
      clientInfo: {
        name: "test",
        title: "Test",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
    await Promise.resolve();

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
      id: "init-request",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        command: "npm test",
        cwd: "/workspace",
        reason: "Need approval",
        availableDecisions: ["accept", "decline", "cancel"]
      }
    });

    expect(notifications).toEqual([]);
    expect(serverRequests).toEqual([]);

    transport.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        userAgent: "codex-test"
      }
    });

    await initializePromise;

    expect(notifications).toHaveLength(1);
    expect(serverRequests).toHaveLength(1);
    expect(transport.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "initialized"
    });
  });

  it("rejects unknown initialize-phase server requests with method-not-found", async () => {
    const transport = new FakeTransport();
    const client = new CodexRpcClient(transport);

    const initializePromise = client.initialize({
      clientInfo: {
        name: "test",
        title: "Test",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
    await Promise.resolve();

    transport.emitMessage({
      jsonrpc: "2.0",
      id: "unknown-request",
      method: "unsupported/request",
      params: {
        threadId: "thread-1"
      }
    });

    transport.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        userAgent: "codex-test"
      }
    });

    await initializePromise;

    expect(transport.sent).toContainEqual({
      jsonrpc: "2.0",
      id: "unknown-request",
      error: {
        code: -32601,
        message: "unsupported remote app-server request `unsupported/request`"
      }
    });
  });

  it("rejects unknown server requests after initialize with method-not-found", async () => {
    const transport = new FakeTransport();
    const client = new CodexRpcClient(transport);

    const serverRequests: unknown[] = [];
    client.on("serverRequest", (request) => serverRequests.push(request));

    const initializePromise = client.initialize({
      clientInfo: {
        name: "test",
        title: "Test",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
    await Promise.resolve();

    transport.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        userAgent: "codex-test"
      }
    });
    await initializePromise;

    transport.emitMessage({
      jsonrpc: "2.0",
      id: "unknown-after-init",
      method: "unsupported/request",
      params: {
        threadId: "thread-1"
      }
    });

    expect(serverRequests).toEqual([]);
    expect(transport.sent).toContainEqual({
      jsonrpc: "2.0",
      id: "unknown-after-init",
      error: {
        code: -32601,
        message: "unsupported remote app-server request `unsupported/request`"
      }
    });
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
