import { spawn } from "node:child_process";
import { once } from "node:events";

import type { AppConfig } from "./config";
import type { CollaborationMode } from "./generated/codex/CollaborationMode";
import type { ReasoningEffort } from "./generated/codex/ReasoningEffort";
import type { ServiceTier } from "./generated/codex/ServiceTier";
import type { UserInput } from "./generated/codex/v2/UserInput";
import type { RequestId } from "./generated/codex/RequestId";
import type { ServerNotification } from "./generated/codex/ServerNotification";
import type { AskForApproval } from "./generated/codex/v2/AskForApproval";
import type { CommandExecutionRequestApprovalParams } from "./generated/codex/v2/CommandExecutionRequestApprovalParams";
import type { CommandExecutionRequestApprovalResponse } from "./generated/codex/v2/CommandExecutionRequestApprovalResponse";
import type { FileChangeRequestApprovalParams } from "./generated/codex/v2/FileChangeRequestApprovalParams";
import type { FileChangeRequestApprovalResponse } from "./generated/codex/v2/FileChangeRequestApprovalResponse";
import type { Model } from "./generated/codex/v2/Model";
import type { PermissionsRequestApprovalParams } from "./generated/codex/v2/PermissionsRequestApprovalParams";
import type { PermissionsRequestApprovalResponse } from "./generated/codex/v2/PermissionsRequestApprovalResponse";
import type { Config } from "./generated/codex/v2/Config";
import type { ConfigEdit } from "./generated/codex/v2/ConfigEdit";
import type { JsonValue } from "./generated/codex/serde_json/JsonValue";
import type { SandboxPolicy } from "./generated/codex/v2/SandboxPolicy";
import type { SandboxMode } from "./generated/codex/v2/SandboxMode";
import type { SandboxWorkspaceWrite } from "./generated/codex/v2/SandboxWorkspaceWrite";
import type { ToolRequestUserInputParams } from "./generated/codex/v2/ToolRequestUserInputParams";
import type { ToolRequestUserInputResponse } from "./generated/codex/v2/ToolRequestUserInputResponse";
import type { Turn } from "./generated/codex/v2/Turn";
import type { TurnSteerResponse } from "./generated/codex/v2/TurnSteerResponse";
import type { ThreadItem } from "./generated/codex/v2/ThreadItem";
import { resolvePinnedCodexInvocation } from "./codex-cli";
import { CodexRpcClient, type AppServerEvent, type SpawnedAppServer } from "./rpc";
import type { ResolvedTurnSnapshot } from "./bridge/turn-finalization";
import type { LoggerLike } from "./logging";

export type ThreadStartSettings = {
  model: string;
  reasoningEffort: ReasoningEffort | null;
  serviceTier: ServiceTier | null;
  cwd: string;
  approvalPolicy: AskForApproval;
  sandboxPolicy: SandboxPolicy;
};

export type ThreadMetadata = {
  name: string | null;
  cwd: string;
};

export type ThreadSettingsOverride = Partial<ThreadStartSettings>;
export type CreatedThread = {
  threadId: string;
  branch: string | null;
} & ThreadStartSettings;

export type AppServerOptions = {
  logger?: LoggerLike;
  homePath?: string;
};

export function buildAppServerSpawnEnv(
  env: NodeJS.ProcessEnv,
  homePath?: string
): NodeJS.ProcessEnv {
  return {
    ...env,
    ...(homePath ? { HOME: homePath, CODEX_HOME: homePath } : {})
  };
}

export async function spawnCodexAppServer(options: AppServerOptions): Promise<SpawnedAppServer> {
  const codex = resolvePinnedCodexInvocation();
  const child = spawn(codex.command, [...codex.args, "app-server"], {
    env: buildAppServerSpawnEnv(process.env, options.homePath),
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stderr?.on("data", (chunk) => {
    if (options.logger) {
      options.logger.error(String(chunk).trimEnd());
      return;
    }

    process.stderr.write(`[codex-app-server] ${chunk}`);
  });

  return {
    process: child,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }

      child.kill("SIGTERM");
      await once(child, "exit");
    }
  };
}

export function buildManagedGlobalConfigEdits(config: AppConfig["codex"]): ConfigEdit[] {
  const managedConfig = {
    ...(config.config ?? {})
  } as Record<string, JsonValue | undefined>;

  if (config.model !== undefined) {
    managedConfig.model = config.model;
  }

  if (config.modelProvider !== undefined) {
    managedConfig.model_provider = config.modelProvider;
  }

  if (config.approvalPolicy !== undefined) {
    managedConfig.approval_policy = config.approvalPolicy;
  }

  if (config.sandbox !== undefined) {
    managedConfig.sandbox_mode = config.sandbox;
  }

  return Object.entries(managedConfig)
    .filter(([, value]) => value !== undefined)
    .map(([keyPath, value]) => ({
      keyPath,
      value: value ?? null,
      mergeStrategy: "replace"
    }));
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
    }
  | {
      method: "item/permissions/requestApproval";
      id: RequestId;
      params: PermissionsRequestApprovalParams;
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

  async createThread(
    profileId: string,
    title: string,
    options?: {
      cwd?: string | null;
      settings?: ThreadSettingsOverride | null;
    }
  ): Promise<CreatedThread> {
    void profileId;
    const threadStartOverrides = omitNullReasoningEffortForThreadStart(buildThreadStartOverrides(
      options?.settings ?? null,
      options?.settings ? sanitizeThreadStartConfig(this.config.config) : null
    ), options?.settings);
    const response = await this.client.startThread({
      cwd: options?.cwd ?? this.config.defaultCwd,
      model: threadStartOverrides.model ?? null,
      modelProvider: options?.settings ? this.config.modelProvider ?? null : null,
      approvalPolicy: threadStartOverrides.approvalPolicy ?? null,
      sandbox: threadStartOverrides.sandbox ?? null,
      config: threadStartOverrides.config ?? null,
      serviceName: this.config.serviceName,
      baseInstructions: null,
      developerInstructions: this.config.developerInstructions ?? null,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
      ephemeral: false,
      personality: null,
      serviceTier: threadStartOverrides.serviceTier ?? null
    });

    this.#loadedThreads.add(response.thread.id);
    this.#threadSettings.set(response.thread.id, threadSettingsFromResponse(response));
    await this.client.setThreadName({
      threadId: response.thread.id,
      name: title
    });
    return {
      threadId: response.thread.id,
      branch: response.thread.gitInfo?.branch ?? null,
      ...threadSettingsFromResponse(response)
    };
  }

  async readProfileSettings(profileId: string): Promise<ThreadStartSettings> {
    void profileId;
    const response = await this.client.readConfig({
      includeLayers: false
    });

    return threadSettingsFromConfig(response.config, this.config);
  }

  registerThreadProfile(_threadId: string, _profileId: string): void {}

  async bootstrapManagedGlobalConfig(): Promise<void> {
    const edits = buildManagedGlobalConfigEdits(this.config);
    if (edits.length === 0) {
      return;
    }

    await this.client.batchWriteConfig({
      edits,
      reloadUserConfig: true
    });
  }

  async ensureThreadLoaded(threadId: string): Promise<ThreadStartSettings> {
    if (this.#loadedThreads.has(threadId)) {
      const settings = this.#threadSettings.get(threadId);
      return {
        model: settings?.model ?? this.config.model ?? "unknown-model",
        reasoningEffort: settings?.reasoningEffort ?? null,
        serviceTier: settings?.serviceTier ?? null,
        cwd: settings?.cwd ?? this.config.defaultCwd,
        approvalPolicy: settings?.approvalPolicy ?? this.config.approvalPolicy ?? "on-request",
        sandboxPolicy: settings?.sandboxPolicy ?? defaultWorkspaceWriteSandboxPolicy()
      };
    }

    const response = await this.client.resumeThread({
      threadId,
      persistExtendedHistory: false
    });
    this.#loadedThreads.add(threadId);
    const settings = threadSettingsFromResponse(response);
    this.#threadSettings.set(threadId, settings);
    return settings;
  }

  async readThread(threadId: string): Promise<ThreadMetadata> {
    const response = await this.client.readThread({
      threadId,
      includeTurns: false
    });

    return {
      name: response.thread.name,
      cwd: response.thread.cwd
    };
  }

  async sendTurn(
    threadId: string,
    input: UserInput[],
    options?: {
      collaborationMode?: CollaborationMode | null;
      overrides?: ThreadSettingsOverride | null;
    }
  ): Promise<Turn> {
    const response = await this.client.startTurn({
      threadId,
      input,
      ...(options?.collaborationMode ? { collaborationMode: options.collaborationMode } : {}),
      ...(options?.overrides?.model ? { model: options.overrides.model } : {}),
      ...("reasoningEffort" in (options?.overrides ?? {}) ? { effort: options?.overrides?.reasoningEffort ?? null } : {}),
      ...("serviceTier" in (options?.overrides ?? {}) ? { serviceTier: options?.overrides?.serviceTier ?? null } : {}),
      ...("approvalPolicy" in (options?.overrides ?? {}) ? { approvalPolicy: options?.overrides?.approvalPolicy ?? null } : {}),
      ...("sandboxPolicy" in (options?.overrides ?? {}) ? { sandboxPolicy: options?.overrides?.sandboxPolicy ?? null } : {})
    });
    const currentSettings = this.#threadSettings.get(threadId);
    if (currentSettings && options?.overrides) {
      this.#threadSettings.set(threadId, {
        ...currentSettings,
        ...options.overrides
      });
    }

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
    this.#threadSettings.delete(threadId);
  }

  async compactThread(threadId: string): Promise<void> {
    await this.client.threadCompactStart({ threadId });
  }

  async readTurnSnapshot(threadId: string, turnId: string): Promise<ResolvedTurnSnapshot> {
    const response = await this.client.readThread({
      threadId,
      includeTurns: true
    });
    const cwd = this.#threadSettings.get(threadId)?.cwd ?? response.thread.cwd ?? this.config.defaultCwd;

    const turn = response.thread.turns.find((candidate) => candidate.id === turnId);
    if (!turn) {
      return {
        text: "",
        assistantText: "",
        planText: "",
        changedFiles: 0,
        cwd,
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
      finalAnswerText.trim().length > 0
        ? finalAnswerText
        : agentMessages
            .filter((item) => item.phase !== "commentary")
            .map((item) => item.text)
            .join("\n\n");
    const planText = planItems.map((item) => item.text).join("\n\n");

    return {
      text: assistantText.trim().length > 0 ? assistantText : planText,
      assistantText,
      planText,
      changedFiles: countChangedFiles(turn.items),
      cwd,
      branch: response.thread.gitInfo?.branch ?? null
    };
  }

  async respondToCommandApproval(id: RequestId, response: CommandExecutionRequestApprovalResponse): Promise<void> {
    await this.client.respond(id, response);
  }

  async respondToFileChangeApproval(id: RequestId, response: FileChangeRequestApprovalResponse): Promise<void> {
    await this.client.respond(id, response);
  }

  async respondToPermissionsApproval(id: RequestId, response: PermissionsRequestApprovalResponse): Promise<void> {
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

  async nextEvent(): Promise<AppServerEvent | null> {
    const event = await this.client.nextEvent();
    if (!event || event.kind !== "notification") {
      return event;
    }

    this.handleNotificationSideEffects(event.notification);
    return event;
  }

  async listModels(profileId: string): Promise<Model[]> {
    void profileId;
    const models: Model[] = [];
    let cursor: string | null = null;

    while (true) {
      const response = await this.client.listModels({
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {})
      });
      models.push(...response.data.filter((model) => !model.hidden));
      if (!response.nextCursor) {
        return models;
      }
      cursor = response.nextCursor;
    }
  }

  private handleNotificationSideEffects(notification: ServerNotification): void {
    if (notification.method === "thread/archived" || notification.method === "thread/closed") {
      this.#loadedThreads.delete(notification.params.threadId);
      this.#threadSettings.delete(notification.params.threadId);
      return;
    }

    if (notification.method === "model/rerouted") {
      const existing = this.#threadSettings.get(notification.params.threadId);
      this.#threadSettings.set(notification.params.threadId, {
        model: notification.params.toModel,
        reasoningEffort: existing?.reasoningEffort ?? null,
        serviceTier: existing?.serviceTier ?? null,
        cwd: existing?.cwd ?? this.config.defaultCwd,
        approvalPolicy: existing?.approvalPolicy ?? this.config.approvalPolicy ?? "on-request",
        sandboxPolicy: existing?.sandboxPolicy ?? defaultWorkspaceWriteSandboxPolicy()
      });
    }
  }
}

function defaultWorkspaceWriteSandboxPolicy(): SandboxPolicy {
  return {
    type: "workspaceWrite",
    writableRoots: [],
    readOnlyAccess: {
      type: "fullAccess"
    },
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  };
}

function sanitizeThreadStartConfig(
  config: AppConfig["codex"]["config"]
): NonNullable<AppConfig["codex"]["config"]> | null {
  if (!config) {
    return null;
  }

  const nextConfig = { ...config };
  delete nextConfig.model;
  delete nextConfig.approval_policy;
  delete nextConfig.sandbox_mode;
  delete nextConfig.sandbox_workspace_write;
  delete nextConfig.model_reasoning_effort;
  delete nextConfig.service_tier;
  return nextConfig;
}

function buildThreadStartOverrides(
  update: ThreadSettingsOverride | null | undefined,
  baseConfig?: NonNullable<AppConfig["codex"]["config"]> | null
): {
  model: string | null | undefined;
  serviceTier: ServiceTier | null | undefined;
  approvalPolicy: AskForApproval | null | undefined;
  sandbox: SandboxMode | null | undefined;
  config: Record<string, JsonValue | undefined> | null | undefined;
} {
  const config = {
    ...(baseConfig ?? {})
  } as Record<string, JsonValue | undefined>;

  if ("reasoningEffort" in (update ?? {})) {
    config.model_reasoning_effort = update?.reasoningEffort ?? null;
  }

  if ("sandboxPolicy" in (update ?? {}) && update?.sandboxPolicy) {
    const { mode, workspaceWrite } = sandboxConfigFromPolicy(update.sandboxPolicy);
    if (workspaceWrite !== null) {
      config.sandbox_workspace_write = workspaceWrite;
    }
    return {
      model: "model" in (update ?? {}) ? update?.model ?? null : undefined,
      serviceTier: "serviceTier" in (update ?? {}) ? update?.serviceTier ?? null : undefined,
      approvalPolicy: "approvalPolicy" in (update ?? {}) ? update?.approvalPolicy ?? null : undefined,
      sandbox: mode,
      config: Object.keys(config).length > 0 ? config : null
    };
  }

  return {
    model: "model" in (update ?? {}) ? update?.model ?? null : baseConfig ? null : undefined,
    serviceTier: "serviceTier" in (update ?? {}) ? update?.serviceTier ?? null : baseConfig ? null : undefined,
    approvalPolicy: "approvalPolicy" in (update ?? {}) ? update?.approvalPolicy ?? null : baseConfig ? null : undefined,
    sandbox: baseConfig ? null : undefined,
    config: Object.keys(config).length > 0 ? config : baseConfig ? null : undefined
  };
}

function omitNullReasoningEffortForThreadStart(
  overrides: ReturnType<typeof buildThreadStartOverrides>,
  settings: ThreadSettingsOverride | null | undefined
): ReturnType<typeof buildThreadStartOverrides> {
  if (!("reasoningEffort" in (settings ?? {})) || settings?.reasoningEffort !== null || overrides.config === undefined || overrides.config === null) {
    return overrides;
  }

  const nextConfig = { ...overrides.config };
  delete nextConfig.model_reasoning_effort;

  return {
    ...overrides,
    config: Object.keys(nextConfig).length > 0 ? nextConfig : null
  };
}

function threadSettingsFromResponse(
  response:
    | Awaited<ReturnType<CodexRpcClient["startThread"]>>
    | Awaited<ReturnType<CodexRpcClient["resumeThread"]>>
): ThreadStartSettings {
  return {
    model: response.model,
    reasoningEffort: response.reasoningEffort,
    serviceTier: response.serviceTier,
    cwd: response.cwd,
    approvalPolicy: response.approvalPolicy,
    sandboxPolicy: response.sandbox
  };
}

function threadSettingsFromConfig(config: Config, defaults: AppConfig["codex"]): ThreadStartSettings {
  return {
    model: config.model ?? defaults.model ?? "unknown-model",
    reasoningEffort: config.model_reasoning_effort ?? null,
    serviceTier: config.service_tier ?? null,
    cwd: defaults.defaultCwd,
    approvalPolicy: config.approval_policy ?? defaults.approvalPolicy ?? "on-request",
    sandboxPolicy: sandboxPolicyFromConfig(config, defaults)
  };
}

function sandboxPolicyFromConfig(config: Config, defaults: AppConfig["codex"]): SandboxPolicy {
  switch (config.sandbox_mode ?? defaults.sandbox ?? "workspace-write") {
    case "danger-full-access":
      return {
        type: "dangerFullAccess"
      };
    case "read-only":
      return {
        type: "readOnly",
        access: {
          type: "fullAccess"
        },
        networkAccess: false
      };
    case "workspace-write": {
      const workspaceWrite = config.sandbox_workspace_write;
      return {
        type: "workspaceWrite",
        writableRoots: workspaceWrite?.writable_roots ?? [],
        readOnlyAccess: {
          type: "fullAccess"
        },
        networkAccess: workspaceWrite?.network_access ?? false,
        excludeTmpdirEnvVar: workspaceWrite?.exclude_tmpdir_env_var ?? false,
        excludeSlashTmp: workspaceWrite?.exclude_slash_tmp ?? false
      };
    }
  }
}

function sandboxConfigFromPolicy(
  sandboxPolicy: SandboxPolicy
): {
  mode: SandboxMode;
  workspaceWrite: SandboxWorkspaceWrite | null;
} {
  switch (sandboxPolicy.type) {
    case "dangerFullAccess":
      return {
        mode: "danger-full-access",
        workspaceWrite: null
      };
    case "readOnly":
      return {
        mode: "read-only",
        workspaceWrite: null
      };
    case "workspaceWrite":
      return {
        mode: "workspace-write",
        workspaceWrite: {
          writable_roots: sandboxPolicy.writableRoots,
          network_access: sandboxPolicy.networkAccess,
          exclude_tmpdir_env_var: sandboxPolicy.excludeTmpdirEnvVar,
          exclude_slash_tmp: sandboxPolicy.excludeSlashTmp
        }
      };
    case "externalSandbox":
      return {
        mode: "read-only",
        workspaceWrite: null
      };
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
