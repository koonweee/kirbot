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

export class RoutedCodexApi implements BridgeCodexApi {
  readonly #threadRoutes = new Map<string, string>();
  readonly #requestRoutes = new Map<RequestId, string>();
  readonly #eventQueue: AppServerEvent[] = [];
  readonly #eventWaiters: Array<(event: AppServerEvent | null) => void> = [];
  readonly #closedGateways = new Set<string>();
  readonly #gatewayIds: string[];
  #eventPumpStarted = false;

  constructor(
    private readonly gateways: Record<string, BridgeCodexApi>,
    private readonly logger: LoggerLike = console
  ) {
    this.#gatewayIds = Object.keys(gateways);
  }

  registerThreadProfile(threadId: string, profileId: string): void {
    this.#getGateway(profileId).registerThreadProfile(threadId, profileId);
    this.#threadRoutes.set(threadId, profileId);
  }

  async createThread(
    profileId: string,
    title: string,
    options?: {
      cwd?: string | null;
      settings?: CodexThreadSettingsOverride | null;
    }
  ) {
    const gateway = this.#getGateway(profileId);
    const thread = await gateway.createThread(profileId, title, options);
    this.#threadRoutes.set(thread.threadId, profileId);
    return thread;
  }

  async readProfileSettings(profileId: string) {
    return this.#getGateway(profileId).readProfileSettings(profileId);
  }

  async updateProfileSettings(profileId: string, update: CodexThreadSettingsOverride) {
    return this.#getGateway(profileId).updateProfileSettings(profileId, update);
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
    return this.#firstGateway().listModels();
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

    if (this.#closedGateways.size === this.#gatewayIds.length) {
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
    for (const profileId of this.#gatewayIds) {
      void this.#pumpGateway(profileId);
    }
  }

  async #pumpGateway(profileId: string): Promise<void> {
    try {
      while (true) {
        const event = await this.#getGateway(profileId).nextEvent();
        if (!event) {
          break;
        }

        this.#rememberEventRoute(profileId, event);
        this.#enqueueEvent(event);
      }
    } catch (error) {
      this.logger.error(`Codex ${profileId} gateway event loop failed`, error);
    } finally {
      this.#closedGateways.add(profileId);
      if (this.#closedGateways.size === this.#gatewayIds.length) {
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

  #rememberEventRoute(profileId: string, event: AppServerEvent): void {
    const threadId = getEventThreadId(event);
    if (threadId) {
      this.#threadRoutes.set(threadId, profileId);
    }

    if (event.kind === "serverRequest") {
      this.#requestRoutes.set(event.request.id, profileId);
    }
  }

  async #runRequestOperation<T>(
    id: RequestId,
    operation: (gateway: BridgeCodexApi) => Promise<T>
  ): Promise<T> {
    const route = this.#requestRoutes.get(id);
    if (!route) {
      throw new Error(`Unknown Codex request route: ${String(id)}`);
    }

    try {
      return await operation(this.#getGateway(route));
    } finally {
      this.#requestRoutes.delete(id);
    }
  }

  async #runThreadOperation<T>(
    threadId: string,
    operation: (gateway: BridgeCodexApi) => Promise<T>
  ): Promise<T> {
    const route = this.#threadRoutes.get(threadId);
    if (!route) {
      throw new Error(`Unknown Codex thread route: ${threadId}`);
    }

    return operation(this.#getGateway(route));
  }

  #getGateway(profileId: string): BridgeCodexApi {
    const gateway = this.gateways[profileId];
    if (!gateway) {
      throw new Error(`Unknown Codex profile route: ${profileId}`);
    }

    return gateway;
  }
  #firstGateway(): BridgeCodexApi {
    const firstGatewayId = this.#gatewayIds[0];
    if (!firstGatewayId) {
      throw new Error("No Codex gateways configured");
    }

    return this.gateways[firstGatewayId]!;
  }
}

function getEventThreadId(event: AppServerEvent): string | null {
  const params = event.kind === "serverRequest" ? event.request.params : event.notification.params;
  const threadId = params && typeof params === "object" && "threadId" in params ? params.threadId : null;
  return typeof threadId === "string" ? threadId : null;
}
