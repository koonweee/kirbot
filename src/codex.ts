import { spawn } from "node:child_process";
import { once } from "node:events";

import type { AppConfig } from "./config";
import type { UserInput } from "./generated/codex/v2/UserInput";
import type { RequestId } from "./generated/codex/RequestId";
import type { ServerNotification } from "./generated/codex/ServerNotification";
import type { ServerRequest } from "./generated/codex/ServerRequest";
import type { CommandExecutionRequestApprovalParams } from "./generated/codex/v2/CommandExecutionRequestApprovalParams";
import type { CommandExecutionRequestApprovalResponse } from "./generated/codex/v2/CommandExecutionRequestApprovalResponse";
import type { FileChangeRequestApprovalParams } from "./generated/codex/v2/FileChangeRequestApprovalParams";
import type { FileChangeRequestApprovalResponse } from "./generated/codex/v2/FileChangeRequestApprovalResponse";
import type { ToolRequestUserInputParams } from "./generated/codex/v2/ToolRequestUserInputParams";
import type { ToolRequestUserInputResponse } from "./generated/codex/v2/ToolRequestUserInputResponse";
import type { Turn } from "./generated/codex/v2/Turn";
import type { TurnSteerResponse } from "./generated/codex/v2/TurnSteerResponse";
import { CodexRpcClient, type SpawnedAppServer, type WebSocketRpcTransport } from "./rpc";

export type AppServerOptions = {
  url: string;
};

export async function spawnCodexAppServer(options: AppServerOptions): Promise<SpawnedAppServer> {
  const child = spawn("codex", ["app-server", "--listen", options.url], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout?.on("data", (chunk) => {
    process.stdout.write(`[codex-app-server] ${chunk}`);
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(`[codex-app-server] ${chunk}`);
  });

  return {
    process: child,
    stop: async () => {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  };
}

export type ApprovalServerRequest =
  | {
      method: "item/commandExecution/requestApproval";
      id: RequestId;
      params: CommandExecutionRequestApprovalParams;
    }
  | {
      method: "item/fileChange/requestApproval";
      id: RequestId;
      params: FileChangeRequestApprovalParams;
    };

export type UserInputServerRequest = {
  method: "item/tool/requestUserInput";
  id: RequestId;
  params: ToolRequestUserInputParams;
};

export class CodexGateway {
  readonly #loadedThreads = new Set<string>();

  constructor(
    private readonly client: CodexRpcClient,
    private readonly config: AppConfig["codex"]
  ) {
    this.client.on("notification", (notification: ServerNotification) => {
      if (notification.method === "thread/archived" || notification.method === "thread/closed") {
        this.#loadedThreads.delete(notification.params.threadId);
      }
    });
    this.client.on("transportClosed", () => this.#loadedThreads.clear());
  }

  async initialize(): Promise<void> {
    await this.client.initialize({
      clientInfo: {
        name: "telegram-codex-bridge",
        title: "Telegram Codex Bridge",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: false
      }
    });
  }

  async createThread(title: string): Promise<string> {
    const response = await this.client.startThread({
      cwd: this.config.defaultCwd,
      model: this.config.model ?? null,
      modelProvider: this.config.modelProvider ?? null,
      approvalPolicy: this.config.approvalPolicy ?? null,
      sandbox: this.config.sandbox ?? null,
      config: this.config.config ?? null,
      serviceName: this.config.serviceName,
      baseInstructions: this.config.baseInstructions ?? null,
      developerInstructions: this.config.developerInstructions ?? null,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
      ephemeral: false,
      personality: null,
      serviceTier: null
    });

    this.#loadedThreads.add(response.thread.id);
    await this.client.setThreadName({
      threadId: response.thread.id,
      name: title
    });
    return response.thread.id;
  }

  async ensureThreadLoaded(threadId: string): Promise<void> {
    if (this.#loadedThreads.has(threadId)) {
      return;
    }

    await this.client.resumeThread({
      threadId,
      persistExtendedHistory: false
    });
    this.#loadedThreads.add(threadId);
  }

  async sendTurn(threadId: string, input: UserInput[]): Promise<Turn> {
    const response = await this.client.startTurn({
      threadId,
      input
    });

    return response.turn;
  }

  async steerTurn(threadId: string, expectedTurnId: string, input: UserInput[]): Promise<TurnSteerResponse> {
    return this.client.steerTurn({
      threadId,
      expectedTurnId,
      input
    });
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.client.interruptTurn({
      threadId,
      turnId
    });
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.client.archiveThread({ threadId });
    this.#loadedThreads.delete(threadId);
  }

  async readTurnMessages(threadId: string, turnId: string): Promise<string> {
    const response = await this.client.readThread({
      threadId,
      includeTurns: true
    });

    const turn = response.thread.turns.find((candidate) => candidate.id === turnId);
    if (!turn) {
      return "";
    }

    const agentMessages = turn.items.filter(
      (item): item is Extract<(typeof turn.items)[number], { type: "agentMessage" }> => item.type === "agentMessage"
    );
    const finalAnswerText = agentMessages
      .filter((item) => item.phase === "final_answer")
      .map((item) => item.text)
      .join("\n\n");

    if (finalAnswerText.trim().length > 0) {
      return finalAnswerText;
    }

    return agentMessages.map((item) => item.text).join("\n\n");
  }

  async respondToCommandApproval(id: RequestId, response: CommandExecutionRequestApprovalResponse): Promise<void> {
    await this.client.respond(id, response);
  }

  async respondToFileChangeApproval(id: RequestId, response: FileChangeRequestApprovalResponse): Promise<void> {
    await this.client.respond(id, response);
  }

  async respondToUserInputRequest(id: RequestId, response: ToolRequestUserInputResponse): Promise<void> {
    await this.client.respond(id, response);
  }

  async respondUnsupportedRequest(id: RequestId, message: string): Promise<void> {
    await this.client.respondError(id, {
      code: -32601,
      message
    });
  }

  onNotification(listener: (notification: ServerNotification) => void): void {
    this.client.on("notification", listener);
  }

  onServerRequest(listener: (request: ServerRequest) => void): void {
    this.client.on("serverRequest", listener);
  }
}
