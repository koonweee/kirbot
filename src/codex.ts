import { spawn } from "node:child_process";
import { once } from "node:events";

import type { AppConfig } from "./config";
import type { CollaborationMode } from "./generated/codex/CollaborationMode";
import type { ReasoningEffort } from "./generated/codex/ReasoningEffort";
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
import type { ThreadItem } from "./generated/codex/v2/ThreadItem";
import { resolvePinnedCodexInvocation } from "./codex-cli";
import { CodexRpcClient, type SpawnedAppServer, type WebSocketRpcTransport } from "./rpc";
import type { ResolvedTurnSnapshot } from "./bridge/turn-finalization";

export type ThreadStartSettings = {
  model: string;
  reasoningEffort: ReasoningEffort | null;
};

export type AppServerOptions = {
  url: string;
};

export async function spawnCodexAppServer(options: AppServerOptions): Promise<SpawnedAppServer> {
  const codex = resolvePinnedCodexInvocation();
  const child = spawn(codex.command, [...codex.args, "app-server", "--listen", options.url], {
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
  readonly #threadSettings = new Map<string, ThreadStartSettings>();

  constructor(
    private readonly client: CodexRpcClient,
    private readonly config: AppConfig["codex"]
  ) {
    this.client.on("notification", (notification: ServerNotification) => {
      if (notification.method === "thread/archived" || notification.method === "thread/closed") {
        this.#loadedThreads.delete(notification.params.threadId);
        this.#threadSettings.delete(notification.params.threadId);
      }

      if (notification.method === "model/rerouted") {
        const existing = this.#threadSettings.get(notification.params.threadId);
        this.#threadSettings.set(notification.params.threadId, {
          model: notification.params.toModel,
          reasoningEffort: existing?.reasoningEffort ?? null
        });
      }
    });
    this.client.on("transportClosed", () => {
      this.#loadedThreads.clear();
      this.#threadSettings.clear();
    });
  }

  async initialize(): Promise<void> {
    await this.client.initialize({
      clientInfo: {
        name: "telegram-codex-bridge",
        title: "Telegram Codex Bridge",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
  }

  async createThread(title: string): Promise<{ threadId: string } & ThreadStartSettings> {
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
    this.#threadSettings.set(response.thread.id, {
      model: response.model,
      reasoningEffort: response.reasoningEffort
    });
    await this.client.setThreadName({
      threadId: response.thread.id,
      name: title
    });
    return {
      threadId: response.thread.id,
      model: response.model,
      reasoningEffort: response.reasoningEffort
    };
  }

  async ensureThreadLoaded(threadId: string): Promise<ThreadStartSettings> {
    if (this.#loadedThreads.has(threadId)) {
      const settings = this.#threadSettings.get(threadId);
      return {
        model: settings?.model ?? this.config.model ?? "unknown-model",
        reasoningEffort: settings?.reasoningEffort ?? null
      };
    }

    const response = await this.client.resumeThread({
      threadId,
      persistExtendedHistory: false
    });
    this.#loadedThreads.add(threadId);
    this.#threadSettings.set(threadId, {
      model: response.model,
      reasoningEffort: response.reasoningEffort
    });
    return {
      model: response.model,
      reasoningEffort: response.reasoningEffort
    };
  }

  async sendTurn(threadId: string, input: UserInput[], collaborationMode?: CollaborationMode | null): Promise<Turn> {
    const response = await this.client.startTurn({
      threadId,
      input,
      ...(collaborationMode ? { collaborationMode } : {})
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

  async readTurnSnapshot(threadId: string, turnId: string): Promise<ResolvedTurnSnapshot> {
    const response = await this.client.readThread({
      threadId,
      includeTurns: true
    });

    const turn = response.thread.turns.find((candidate) => candidate.id === turnId);
    if (!turn) {
      return {
        text: "",
        assistantText: "",
        planText: "",
        changedFiles: 0,
        cwd: response.thread.cwd,
        branch: response.thread.gitInfo?.branch ?? null
      };
    }

    const agentMessages = turn.items.filter(
      (item): item is Extract<(typeof turn.items)[number], { type: "agentMessage" }> => item.type === "agentMessage"
    );
    const planItems = turn.items.filter(
      (item): item is Extract<(typeof turn.items)[number], { type: "plan" }> => item.type === "plan"
    );
    const finalAnswerText = agentMessages
      .filter((item) => item.phase === "final_answer")
      .map((item) => item.text)
      .join("\n\n");
    const assistantText =
      finalAnswerText.trim().length > 0 ? finalAnswerText : agentMessages.map((item) => item.text).join("\n\n");
    const planText = planItems.map((item) => item.text).join("\n\n");

    return {
      text: assistantText.trim().length > 0 ? assistantText : planText,
      assistantText,
      planText,
      changedFiles: countChangedFiles(turn.items),
      cwd: response.thread.cwd,
      branch: response.thread.gitInfo?.branch ?? null
    };
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

function countChangedFiles(items: ThreadItem[]): number {
  const paths = new Set<string>();

  for (const item of items) {
    if (item.type !== "fileChange") {
      continue;
    }

    for (const change of item.changes) {
      if (change.path) {
        paths.add(change.path);
      }
    }
  }

  return paths.size;
}
