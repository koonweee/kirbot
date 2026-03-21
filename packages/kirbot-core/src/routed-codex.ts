import type { AppServerEvent } from "@kirbot/codex-client";
import type { RequestId } from "@kirbot/codex-client/generated/codex/RequestId";
import type { CollaborationMode } from "@kirbot/codex-client/generated/codex/CollaborationMode";
import type { CommandExecutionApprovalDecision } from "@kirbot/codex-client/generated/codex/v2/CommandExecutionApprovalDecision";
import type { FileChangeApprovalDecision } from "@kirbot/codex-client/generated/codex/v2/FileChangeApprovalDecision";
import type { PermissionsRequestApprovalResponse } from "@kirbot/codex-client/generated/codex/v2/PermissionsRequestApprovalResponse";
import type { ToolRequestUserInputResponse } from "@kirbot/codex-client/generated/codex/v2/ToolRequestUserInputResponse";
import type { UserInput } from "@kirbot/codex-client/generated/codex/v2/UserInput";

import type { LoggerLike } from "./logging";
import type { BridgeCodexApi } from "./bridge";
import type { CodexThreadSettingsOverride } from "./bridge/codex-thread-settings";

type GatewayName = "shared" | "isolated";

export class RoutedCodexApi implements BridgeCodexApi {
  readonly #threadRoutes = new Map<string, GatewayName>();
  readonly #requestRoutes = new Map<RequestId, GatewayName>();
  readonly #eventQueue: AppServerEvent[] = [];
  readonly #eventWaiters: Array<(event: AppServerEvent | null) => void> = [];
  readonly #closedGateways = new Set<GatewayName>();
  #eventPumpStarted = false;

  constructor(
    private readonly gateways: {
      shared: BridgeCodexApi;
      isolated: BridgeCodexApi;
    },
    private readonly logger: LoggerLike = console
  ) {}

  async createThread(
    title: string,
    options?: {
      cwd?: string | null;
      settings?: CodexThreadSettingsOverride | null;
    }
  ) {
    const thread = await this.gateways.isolated.createThread(title, options);
    this.#threadRoutes.set(thread.threadId, "isolated");
    return thread;
  }

  async readGlobalSettings() {
    return this.gateways.isolated.readGlobalSettings();
  }

  async updateGlobalSettings(update: CodexThreadSettingsOverride) {
    return this.gateways.isolated.updateGlobalSettings(update);
  }

  async ensureThreadLoaded(threadId: string) {
    return this.#runThreadOperation(threadId, (gateway) => gateway.ensureThreadLoaded(threadId));
  }

  async readThread(threadId: string) {
    return this.#runThreadOperation(threadId, (gateway) => gateway.readThread(threadId));
  }

  async compactThread(threadId: string) {
    return this.#runThreadOperation(threadId, (gateway) => gateway.compactThread(threadId));
  }

  async sendTurn(
    threadId: string,
    input: UserInput[],
    options?: {
      collaborationMode?: CollaborationMode | null;
      overrides?: CodexThreadSettingsOverride | null;
    }
  ) {
    return this.#runThreadOperation(threadId, (gateway) => gateway.sendTurn(threadId, input, options));
  }

  async steerTurn(threadId: string, expectedTurnId: string, input: UserInput[]) {
    return this.#runThreadOperation(threadId, (gateway) => gateway.steerTurn(threadId, expectedTurnId, input));
  }

  async interruptTurn(threadId: string, turnId: string) {
    return this.#runThreadOperation(threadId, (gateway) => gateway.interruptTurn(threadId, turnId));
  }

  async archiveThread(threadId: string) {
    return this.#runThreadOperation(threadId, (gateway) => gateway.archiveThread(threadId));
  }

  async readTurnSnapshot(threadId: string, turnId: string) {
    return this.#runThreadOperation(threadId, (gateway) => gateway.readTurnSnapshot(threadId, turnId));
  }

  async listModels() {
    return this.gateways.isolated.listModels();
  }

  async respondToCommandApproval(id: RequestId, response: { decision: CommandExecutionApprovalDecision }) {
    return this.#runRequestOperation(id, (gateway) => gateway.respondToCommandApproval(id, response));
  }

  async respondToFileChangeApproval(id: RequestId, response: { decision: FileChangeApprovalDecision }) {
    return this.#runRequestOperation(id, (gateway) => gateway.respondToFileChangeApproval(id, response));
  }

  async respondToPermissionsApproval(id: RequestId, response: PermissionsRequestApprovalResponse) {
    return this.#runRequestOperation(id, (gateway) => gateway.respondToPermissionsApproval(id, response));
  }

  async respondToUserInputRequest(id: RequestId, response: ToolRequestUserInputResponse) {
    return this.#runRequestOperation(id, (gateway) => gateway.respondToUserInputRequest(id, response));
  }

  async respondUnsupportedRequest(id: RequestId, message: string) {
    return this.#runRequestOperation(id, (gateway) => gateway.respondUnsupportedRequest(id, message));
  }

  async nextEvent(): Promise<AppServerEvent | null> {
    this.#startEventPump();

    const queued = this.#eventQueue.shift();
    if (queued) {
      return queued;
    }

    if (this.#closedGateways.size === 2) {
      return null;
    }

    return new Promise<AppServerEvent | null>((resolve) => {
      this.#eventWaiters.push(resolve);
    });
  }

  #startEventPump(): void {
    if (this.#eventPumpStarted) {
      return;
    }

    this.#eventPumpStarted = true;
    void this.#pumpGateway("shared");
    void this.#pumpGateway("isolated");
  }

  async #pumpGateway(name: GatewayName): Promise<void> {
    try {
      while (true) {
        const event = await this.gateways[name].nextEvent();
        if (!event) {
          break;
        }

        this.#rememberEventRoute(name, event);
        this.#enqueueEvent(event);
      }
    } catch (error) {
      this.logger.error(`Codex ${name} gateway event loop failed`, error);
    } finally {
      this.#closedGateways.add(name);
      if (this.#closedGateways.size === 2) {
        this.#resolvePendingEventWaiters(null);
      }
    }
  }

  #enqueueEvent(event: AppServerEvent): void {
    const waiter = this.#eventWaiters.shift();
    if (waiter) {
      waiter(event);
      return;
    }

    this.#eventQueue.push(event);
  }

  #resolvePendingEventWaiters(event: AppServerEvent | null): void {
    while (this.#eventWaiters.length > 0) {
      this.#eventWaiters.shift()?.(event);
    }
  }

  #rememberEventRoute(name: GatewayName, event: AppServerEvent): void {
    const threadId = getEventThreadId(event);
    if (threadId) {
      this.#threadRoutes.set(threadId, name);
    }

    if (event.kind === "serverRequest") {
      this.#requestRoutes.set(event.request.id, name);
    }
  }

  async #runRequestOperation<T>(
    id: RequestId,
    operation: (gateway: BridgeCodexApi) => Promise<T>
  ): Promise<T> {
    const route = this.#requestRoutes.get(id) ?? "isolated";

    try {
      return await operation(this.gateways[route]);
    } finally {
      this.#requestRoutes.delete(id);
    }
  }

  async #runThreadOperation<T>(
    threadId: string,
    operation: (gateway: BridgeCodexApi) => Promise<T>
  ): Promise<T> {
    let lastError: unknown;

    for (const route of this.#candidateThreadRoutes(threadId)) {
      try {
        const result = await operation(this.gateways[route]);
        this.#threadRoutes.set(threadId, route);
        return result;
      } catch (error) {
        lastError = error;
        if (!isMissingThreadError(error)) {
          throw error;
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(`Unable to resolve Codex gateway for thread ${threadId}`);
  }

  #candidateThreadRoutes(threadId: string): GatewayName[] {
    const cached = this.#threadRoutes.get(threadId);
    if (cached === "shared") {
      return ["shared", "isolated"];
    }

    if (cached === "isolated") {
      return ["isolated", "shared"];
    }

    return ["isolated", "shared"];
  }
}

function getEventThreadId(event: AppServerEvent): string | null {
  const params = event.kind === "serverRequest" ? event.request.params : event.notification.params;
  const threadId = params && typeof params === "object" && "threadId" in params ? params.threadId : null;
  return typeof threadId === "string" ? threadId : null;
}

function isMissingThreadError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.toLowerCase().includes("thread not found");
}
