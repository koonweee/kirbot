import { EventEmitter } from "node:events";

import type { ChildProcess } from "node:child_process";

import type { ClientRequest } from "./generated/codex/ClientRequest";
import type { InitializeParams } from "./generated/codex/InitializeParams";
import type { InitializeResponse } from "./generated/codex/InitializeResponse";
import type { RequestId } from "./generated/codex/RequestId";
import type { ServerNotification } from "./generated/codex/ServerNotification";
import type { ServerRequest } from "./generated/codex/ServerRequest";
import type { ThreadArchiveParams } from "./generated/codex/v2/ThreadArchiveParams";
import type { ThreadArchiveResponse } from "./generated/codex/v2/ThreadArchiveResponse";
import type { ThreadReadParams } from "./generated/codex/v2/ThreadReadParams";
import type { ThreadReadResponse } from "./generated/codex/v2/ThreadReadResponse";
import type { ThreadResumeParams } from "./generated/codex/v2/ThreadResumeParams";
import type { ThreadResumeResponse } from "./generated/codex/v2/ThreadResumeResponse";
import type { ThreadSetNameParams } from "./generated/codex/v2/ThreadSetNameParams";
import type { ThreadSetNameResponse } from "./generated/codex/v2/ThreadSetNameResponse";
import type { ThreadStartParams } from "./generated/codex/v2/ThreadStartParams";
import type { ThreadStartResponse } from "./generated/codex/v2/ThreadStartResponse";
import type { TurnInterruptParams } from "./generated/codex/v2/TurnInterruptParams";
import type { TurnInterruptResponse } from "./generated/codex/v2/TurnInterruptResponse";
import type { TurnSteerParams } from "./generated/codex/v2/TurnSteerParams";
import type { TurnSteerResponse } from "./generated/codex/v2/TurnSteerResponse";
import type { TurnStartParams } from "./generated/codex/v2/TurnStartParams";
import type { TurnStartResponse } from "./generated/codex/v2/TurnStartResponse";

type JsonRpcResponse =
  | {
      jsonrpc: "2.0";
      id: RequestId;
      result: unknown;
    }
  | {
      jsonrpc: "2.0";
      id: RequestId | null;
      error: {
        code: number;
        message: string;
        data?: unknown;
      };
    };

type RpcEnvelope = ClientRequest | ServerNotification | ServerRequest | JsonRpcResponse;

type JsonRpcErrorPayload = Extract<JsonRpcResponse, { error: unknown }>["error"];

type SupportedMethodMap = {
  initialize: {
    params: InitializeParams;
    result: InitializeResponse;
  };
  "thread/start": {
    params: ThreadStartParams;
    result: ThreadStartResponse;
  };
  "thread/resume": {
    params: ThreadResumeParams;
    result: ThreadResumeResponse;
  };
  "thread/read": {
    params: ThreadReadParams;
    result: ThreadReadResponse;
  };
  "thread/archive": {
    params: ThreadArchiveParams;
    result: ThreadArchiveResponse;
  };
  "thread/name/set": {
    params: ThreadSetNameParams;
    result: ThreadSetNameResponse;
  };
  "turn/start": {
    params: TurnStartParams;
    result: TurnStartResponse;
  };
  "turn/steer": {
    params: TurnSteerParams;
    result: TurnSteerResponse;
  };
  "turn/interrupt": {
    params: TurnInterruptParams;
    result: TurnInterruptResponse;
  };
};

type PendingRequest = {
  method: keyof SupportedMethodMap;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

export class JsonRpcMethodError extends Error {
  readonly code: number;
  readonly data?: unknown;
  readonly method: string;
  readonly requestId: RequestId | null;

  constructor(method: string, requestId: RequestId | null, error: JsonRpcErrorPayload) {
    super(error.message);
    this.name = "JsonRpcMethodError";
    this.code = error.code;
    this.data = error.data;
    this.method = method;
    this.requestId = requestId;
  }
}

export interface RpcTransport {
  connect(): Promise<void>;
  close(): Promise<void>;
  send(message: unknown): Promise<void>;
  onMessage(listener: (message: unknown) => void): void;
  onClose(listener: () => void): void;
  onError(listener: (error: Error) => void): void;
}

export class WebSocketRpcTransport implements RpcTransport {
  #websocket: WebSocket | null = null;
  readonly #messageListeners = new Set<(message: unknown) => void>();
  readonly #closeListeners = new Set<() => void>();
  readonly #errorListeners = new Set<(error: Error) => void>();

  constructor(private readonly url: string) {}

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const websocket = new WebSocket(this.url);
      this.#websocket = websocket;

      websocket.addEventListener("open", () => resolve(), { once: true });
      websocket.addEventListener(
        "error",
        (event) => {
          reject(new Error(`Failed to connect to Codex app server at ${this.url}: ${String(event.type)}`));
        },
        { once: true }
      );

      websocket.addEventListener("message", async (event) => {
        const payload =
          typeof event.data === "string"
            ? event.data
            : event.data instanceof Blob
              ? await event.data.text()
              : Buffer.from(event.data as ArrayBuffer).toString("utf8");
        const message = JSON.parse(payload) as RpcEnvelope;
        for (const listener of this.#messageListeners) {
          listener(message);
        }
      });

      websocket.addEventListener("close", () => {
        for (const listener of this.#closeListeners) {
          listener();
        }
      });

      websocket.addEventListener("error", () => {
        const error = new Error("Codex app server WebSocket emitted an error event");
        for (const listener of this.#errorListeners) {
          listener(error);
        }
      });
    });
  }

  async close(): Promise<void> {
    if (!this.#websocket) {
      return;
    }

    this.#websocket.close();
    this.#websocket = null;
  }

  async send(message: unknown): Promise<void> {
    if (!this.#websocket || this.#websocket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app server transport is not connected");
    }

    this.#websocket.send(JSON.stringify(message));
  }

  onMessage(listener: (message: unknown) => void): void {
    this.#messageListeners.add(listener);
  }

  onClose(listener: () => void): void {
    this.#closeListeners.add(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.#errorListeners.add(listener);
  }
}

export class CodexRpcClient extends EventEmitter {
  #requestId = 1;
  readonly #pending = new Map<RequestId, PendingRequest>();

  constructor(private readonly transport: RpcTransport) {
    super();

    this.transport.onMessage((message) => this.#handleMessage(message as RpcEnvelope));
    this.transport.onClose(() => {
      this.emit("transportClosed");
      this.#rejectAllPending(new Error("Codex app server transport closed"));
    });
    this.transport.onError((error) => this.emit("transportError", error));
  }

  async connect(): Promise<void> {
    await this.transport.connect();
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  async initialize(params: InitializeParams): Promise<InitializeResponse> {
    return this.call("initialize", params);
  }

  async startThread(params: ThreadStartParams): Promise<ThreadStartResponse> {
    return this.call("thread/start", params);
  }

  async resumeThread(params: ThreadResumeParams): Promise<ThreadResumeResponse> {
    return this.call("thread/resume", params);
  }

  async readThread(params: ThreadReadParams): Promise<ThreadReadResponse> {
    return this.call("thread/read", params);
  }

  async archiveThread(params: ThreadArchiveParams): Promise<ThreadArchiveResponse> {
    return this.call("thread/archive", params);
  }

  async setThreadName(params: ThreadSetNameParams): Promise<ThreadSetNameResponse> {
    return this.call("thread/name/set", params);
  }

  async startTurn(params: TurnStartParams): Promise<TurnStartResponse> {
    return this.call("turn/start", params);
  }

  async steerTurn(params: TurnSteerParams): Promise<TurnSteerResponse> {
    return this.call("turn/steer", params);
  }

  async interruptTurn(params: TurnInterruptParams): Promise<TurnInterruptResponse> {
    return this.call("turn/interrupt", params);
  }

  async respond(id: RequestId, result: unknown): Promise<void> {
    await this.transport.send({
      jsonrpc: "2.0",
      id,
      result
    });
  }

  async respondError(id: RequestId, error: { code: number; message: string; data?: unknown }): Promise<void> {
    await this.transport.send({
      jsonrpc: "2.0",
      id,
      error
    });
  }

  async call<TMethod extends keyof SupportedMethodMap>(
    method: TMethod,
    params: SupportedMethodMap[TMethod]["params"]
  ): Promise<SupportedMethodMap[TMethod]["result"]> {
    const id = this.#requestId++;
    const request = {
      jsonrpc: "2.0",
      method,
      id,
      params
    } satisfies { jsonrpc: "2.0"; method: TMethod; id: number; params: SupportedMethodMap[TMethod]["params"] };

    await this.transport.send(request);

    return new Promise<SupportedMethodMap[TMethod]["result"]>((resolve, reject) => {
      this.#pending.set(id, {
        method,
        resolve: (result) => resolve(result as SupportedMethodMap[TMethod]["result"]),
        reject
      });
    });
  }

  #handleMessage(message: RpcEnvelope): void {
    if ("method" in message && "id" in message) {
      this.emit("serverRequest", message as ServerRequest);
      return;
    }

    if ("method" in message) {
      this.emit("notification", message as ServerNotification);
      return;
    }

    const pending = this.#pending.get(message.id as RequestId);
    if (!pending) {
      return;
    }

    this.#pending.delete(message.id as RequestId);

    if ("error" in message) {
      pending.reject(new JsonRpcMethodError(String(pending.method), message.id, message.error));
      return;
    }

    pending.resolve(message.result);
  }

  #rejectAllPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }

    this.#pending.clear();
  }
}

export type SpawnedAppServer = {
  process: ChildProcess;
  stop: () => Promise<void>;
};
