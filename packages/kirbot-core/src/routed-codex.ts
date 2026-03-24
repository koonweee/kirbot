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

type ThreadRoute = {
  profileId: string;
  upstreamThreadId: string;
  publicThreadId: string;
};

type RequestRoute = {
  profileId: string;
  upstreamRequestId: RequestId;
  publicRequestId: RequestId;
};

const THREAD_ROUTE_PREFIX = "kirbot-route:thread:";
const REQUEST_ROUTE_PREFIX = "kirbot-route:request:";

export class RoutedCodexApi implements BridgeCodexApi {
  readonly #threadRoutes = new Map<string, ThreadRoute>();
  readonly #threadRoutesByUpstreamKey = new Map<string, ThreadRoute>();
  readonly #requestRoutes = new Map<string, RequestRoute>();
  readonly #requestRoutesByUpstreamKey = new Map<string, RequestRoute>();
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
    const route = this.#rememberThreadRoute(
      profileId,
      requireUpstreamThreadId(threadId, profileId),
      threadId
    );
    this.#getGateway(profileId).registerThreadProfile(route.upstreamThreadId, profileId);
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
    const route = this.#rememberThreadRoute(profileId, thread.threadId);
    return {
      ...thread,
      threadId: route.publicThreadId
    };
  }

  async readProfileSettings(profileId: string) {
    return this.#getGateway(profileId).readProfileSettings(profileId);
  }

  async ensureThreadLoaded(threadId: string) {
    return this.#runThreadOperation(threadId, (gateway, upstreamThreadId) => gateway.ensureThreadLoaded(upstreamThreadId));
  }

  async readThread(threadId: string) {
    return this.#runThreadOperation(threadId, (gateway, upstreamThreadId) => gateway.readThread(upstreamThreadId));
  }

  async compactThread(threadId: string) {
    return this.#runThreadOperation(threadId, (gateway, upstreamThreadId) => gateway.compactThread(upstreamThreadId));
  }

  async sendTurn(
    threadId: string,
    input: UserInput[],
    options?: {
      collaborationMode?: CollaborationMode | null;
      overrides?: CodexThreadSettingsOverride | null;
    }
  ) {
    return this.#runThreadOperation(
      threadId,
      (gateway, upstreamThreadId) => gateway.sendTurn(upstreamThreadId, input, options)
    );
  }

  async steerTurn(threadId: string, expectedTurnId: string, input: UserInput[]) {
    return this.#runThreadOperation(
      threadId,
      (gateway, upstreamThreadId) => gateway.steerTurn(upstreamThreadId, expectedTurnId, input)
    );
  }

  async interruptTurn(threadId: string, turnId: string) {
    return this.#runThreadOperation(
      threadId,
      (gateway, upstreamThreadId) => gateway.interruptTurn(upstreamThreadId, turnId)
    );
  }

  async archiveThread(threadId: string) {
    const result = await this.#runThreadOperation(threadId, (gateway, upstreamThreadId) => gateway.archiveThread(upstreamThreadId));
    this.#deleteThreadRoute(threadId);
    return result;
  }

  async readTurnSnapshot(threadId: string, turnId: string) {
    return this.#runThreadOperation(
      threadId,
      (gateway, upstreamThreadId) => gateway.readTurnSnapshot(upstreamThreadId, turnId)
    );
  }

  async listModels(profileId: string) {
    return this.#getGateway(profileId).listModels(profileId);
  }

  async respondToCommandApproval(id: RequestId, response: { decision: CommandExecutionApprovalDecision }) {
    return this.#runRequestOperation(id, (gateway, upstreamRequestId) =>
      gateway.respondToCommandApproval(upstreamRequestId, response)
    );
  }

  async respondToFileChangeApproval(id: RequestId, response: { decision: FileChangeApprovalDecision }) {
    return this.#runRequestOperation(id, (gateway, upstreamRequestId) =>
      gateway.respondToFileChangeApproval(upstreamRequestId, response)
    );
  }

  async respondToPermissionsApproval(id: RequestId, response: PermissionsRequestApprovalResponse) {
    return this.#runRequestOperation(id, (gateway, upstreamRequestId) =>
      gateway.respondToPermissionsApproval(upstreamRequestId, response)
    );
  }

  async respondToUserInputRequest(id: RequestId, response: ToolRequestUserInputResponse) {
    return this.#runRequestOperation(id, (gateway, upstreamRequestId) =>
      gateway.respondToUserInputRequest(upstreamRequestId, response)
    );
  }

  async respondUnsupportedRequest(id: RequestId, message: string) {
    return this.#runRequestOperation(id, (gateway, upstreamRequestId) =>
      gateway.respondUnsupportedRequest(upstreamRequestId, message)
    );
  }

  async nextEvent(): Promise<AppServerEvent | null> {
    this.#startEventPump();

    const queued = this.#eventQueue.shift();
    if (queued) {
      this.#pruneThreadRouteForDeliveredEvent(queued);
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

        this.#enqueueEvent(this.#rememberEventRoute(profileId, event));
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
    const shouldPruneAfterDelivery = event.kind === "notification" && isTerminalThreadNotification(event.notification.method);
    const threadId = shouldPruneAfterDelivery ? getEventThreadId(event) : null;
    const waiter = this.#eventWaiters.shift();
    if (waiter) {
      waiter(event);
      if (threadId) {
        this.#deleteThreadRoute(threadId);
      }
      return;
    }

    this.#eventQueue.push(event);
  }

  #resolvePendingEventWaiters(event: AppServerEvent | null): void {
    while (this.#eventWaiters.length > 0) {
      this.#eventWaiters.shift()?.(event);
    }
  }

  #rememberEventRoute(profileId: string, event: AppServerEvent): AppServerEvent {
    const upstreamThreadId = getEventThreadId(event);
    const threadRoute = upstreamThreadId ? this.#rememberThreadRoute(profileId, upstreamThreadId) : null;
    let rewritten = threadRoute ? replaceEventThreadId(event, threadRoute.publicThreadId) : event;

    if (rewritten.kind === "serverRequest") {
      const requestRoute = this.#rememberRequestRoute(profileId, rewritten.request.id);
      rewritten = {
        kind: "serverRequest",
        request: {
          ...rewritten.request,
          id: requestRoute.publicRequestId
        }
      };
    } else if (rewritten.notification.method === "serverRequest/resolved") {
      const requestRoute = this.#rememberRequestRoute(profileId, rewritten.notification.params.requestId);
      rewritten = {
        kind: "notification",
        notification: {
          ...rewritten.notification,
          params: {
            ...rewritten.notification.params,
            requestId: requestRoute.publicRequestId
          }
        }
      };
    }

    return rewritten;
  }

  async #runRequestOperation<T>(
    id: RequestId,
    operation: (gateway: BridgeCodexApi, upstreamRequestId: RequestId) => Promise<T>
  ): Promise<T> {
    const routeKey = serializeRequestId(id);
    const route = this.#requestRoutes.get(routeKey);
    if (!route) {
      throw new Error(`Unknown Codex request route: ${String(id)}`);
    }

    const result = await operation(this.#getGateway(route.profileId), route.upstreamRequestId);
    this.#requestRoutes.delete(routeKey);
    this.#requestRoutesByUpstreamKey.delete(buildRequestRouteKey(route.profileId, route.upstreamRequestId));
    return result;
  }

  async #runThreadOperation<T>(
    threadId: string,
    operation: (gateway: BridgeCodexApi, upstreamThreadId: string, route: ThreadRoute) => Promise<T>
  ): Promise<T> {
    const route = this.#threadRoutes.get(threadId);
    if (!route) {
      throw new Error(`Unknown Codex thread route: ${threadId}`);
    }

    return operation(this.#getGateway(route.profileId), route.upstreamThreadId, route);
  }

  #getGateway(profileId: string): BridgeCodexApi {
    const gateway = this.gateways[profileId];
    if (!gateway) {
      throw new Error(`Unknown Codex profile route: ${profileId}`);
    }

    return gateway;
  }

  #pruneThreadRouteForDeliveredEvent(event: AppServerEvent): void {
    if (event.kind !== "notification" || !isTerminalThreadNotification(event.notification.method)) {
      return;
    }

    const threadId = getEventThreadId(event);
    if (threadId) {
      this.#deleteThreadRoute(threadId);
    }
  }

  #rememberThreadRoute(profileId: string, upstreamThreadId: string, preferredPublicThreadId?: string): ThreadRoute {
    const upstreamKey = buildThreadRouteKey(profileId, upstreamThreadId);
    const existing = this.#threadRoutesByUpstreamKey.get(upstreamKey);
    if (existing && preferredPublicThreadId === undefined) {
      this.#threadRoutes.set(existing.publicThreadId, existing);
      return existing;
    }

    const publicThreadId = preferredPublicThreadId ?? encodeThreadId(profileId, upstreamThreadId);
    if (existing && existing.publicThreadId === publicThreadId) {
      this.#threadRoutes.set(existing.publicThreadId, existing);
      return existing;
    }

    if (existing) {
      this.#threadRoutes.delete(existing.publicThreadId);
    }

    const route = {
      profileId,
      upstreamThreadId,
      publicThreadId
    };
    this.#threadRoutes.set(publicThreadId, route);
    this.#threadRoutesByUpstreamKey.set(upstreamKey, route);
    return route;
  }

  #rememberRequestRoute(profileId: string, upstreamRequestId: RequestId): RequestRoute {
    const upstreamKey = buildRequestRouteKey(profileId, upstreamRequestId);
    const existing = this.#requestRoutesByUpstreamKey.get(upstreamKey);
    if (existing) {
      this.#requestRoutes.set(serializeRequestId(existing.publicRequestId), existing);
      return existing;
    }

    const route = {
      profileId,
      upstreamRequestId,
      publicRequestId: encodeRequestId(profileId, upstreamRequestId)
    };
    this.#requestRoutes.set(serializeRequestId(route.publicRequestId), route);
    this.#requestRoutesByUpstreamKey.set(upstreamKey, route);
    return route;
  }

  #deleteThreadRoute(publicThreadId: string): void {
    const route = this.#threadRoutes.get(publicThreadId);
    if (!route) {
      return;
    }

    this.#threadRoutes.delete(publicThreadId);
    this.#threadRoutesByUpstreamKey.delete(buildThreadRouteKey(route.profileId, route.upstreamThreadId));
  }
}

function getEventThreadId(event: AppServerEvent): string | null {
  const params = event.kind === "serverRequest" ? event.request.params : event.notification.params;
  const threadId = params && typeof params === "object" && "threadId" in params ? params.threadId : null;
  return typeof threadId === "string" ? threadId : null;
}

function isTerminalThreadNotification(method: string): boolean {
  return method === "thread/archived" || method === "thread/closed";
}

function buildThreadRouteKey(profileId: string, upstreamThreadId: string): string {
  return `${profileId}\u0000${upstreamThreadId}`;
}

function buildRequestRouteKey(profileId: string, upstreamRequestId: RequestId): string {
  return `${profileId}\u0000${serializeRequestId(upstreamRequestId)}`;
}

function encodeThreadId(profileId: string, upstreamThreadId: string): string {
  return `${THREAD_ROUTE_PREFIX}${encodeURIComponent(profileId)}:${encodeURIComponent(upstreamThreadId)}`;
}

function encodeRequestId(profileId: string, upstreamRequestId: RequestId): string {
  return `${REQUEST_ROUTE_PREFIX}${encodeURIComponent(profileId)}:${serializeRequestIdComponent(upstreamRequestId)}`;
}

function requireUpstreamThreadId(threadId: string, profileId: string): string {
  const parsed = parseThreadId(threadId);
  if (!parsed) {
    throw new Error(`Unsupported raw Codex thread id: ${threadId}`);
  }

  if (parsed.profileId !== profileId) {
    throw new Error(`Codex thread route ${threadId} is registered to ${parsed.profileId}, not ${profileId}`);
  }

  return parsed.upstreamThreadId;
}

function parseThreadId(threadId: string): { profileId: string; upstreamThreadId: string } | null {
  if (!threadId.startsWith(THREAD_ROUTE_PREFIX)) {
    return null;
  }

  const encoded = threadId.slice(THREAD_ROUTE_PREFIX.length);
  const separatorIndex = encoded.indexOf(":");
  if (separatorIndex < 0) {
    return null;
  }

  return {
    profileId: decodeURIComponent(encoded.slice(0, separatorIndex)),
    upstreamThreadId: decodeURIComponent(encoded.slice(separatorIndex + 1))
  };
}

function serializeRequestId(id: RequestId): string {
  return typeof id === "number" ? `n:${id}` : `s:${id}`;
}

function serializeRequestIdComponent(id: RequestId): string {
  return typeof id === "number" ? `n:${id}` : `s:${encodeURIComponent(id)}`;
}

function replaceEventThreadId(event: AppServerEvent, threadId: string): AppServerEvent {
  if (event.kind === "serverRequest") {
    return {
      kind: "serverRequest",
      request: {
        ...event.request,
        params: replaceParamsThreadId(event.request.params, threadId)
      } as typeof event.request
    };
  }

  return {
    kind: "notification",
    notification: {
      ...event.notification,
      params: replaceParamsThreadId(event.notification.params, threadId)
    } as typeof event.notification
  };
}

function replaceParamsThreadId<T>(params: T, threadId: string): T {
  if (!params || typeof params !== "object" || !("threadId" in params)) {
    return params;
  }

  return {
    ...params,
    threadId
  } as T;
}
