import { CodexGateway, spawnCodexAppServer } from "@kirbot/codex-client";
import type { AppConfig as CodexClientAppConfig } from "@kirbot/codex-client";
import type { JsonValue } from "@kirbot/codex-client/generated/codex/serde_json/JsonValue";
import { TelegramCodexBridge, type BridgeCodexApi } from "./bridge";
import type { AppConfig } from "./config";
import { prepareKirbotCodexHome } from "./codex-home";
import { BridgeDatabase } from "./db";
import { createConsoleLogTarget, createSourceLogger, type AppLogTarget, type LoggerLike } from "./logging";
import { TemporaryImageStore } from "./media-store";
import { CodexRpcClient, StdioRpcTransport, type SpawnedAppServer } from "@kirbot/codex-client";
import { RoutedCodexApi } from "./routed-codex";
import {
  TelegramCommandSync,
  initializeTelegramCommandSyncFailOpen,
  type TelegramCommandApi
} from "./telegram-command-sync";
import type { TelegramApi } from "./telegram-messenger";

export type BridgeActivitySnapshot = {
  activeTurnCount: number;
  pendingRequestCount: number;
  activeTopics: Array<{ chatId: number; topicId: number | null }>;
};

export type KirbotRuntime = {
  config: AppConfig;
  bridge: TelegramCodexBridge;
  database: BridgeDatabase;
  codex: BridgeCodexApi;
  shutdown(): Promise<void>;
  getActivitySnapshot(): Promise<BridgeActivitySnapshot>;
};

export type CreateKirbotRuntimeOptions = {
  config?: AppConfig;
  telegramApi: TelegramApi;
  telegramCommandApi?: TelegramCommandApi;
  logTarget?: AppLogTarget;
  fallbackLogger?: LoggerLike;
  codexApi?: BridgeCodexApi;
  restartKirbot?: (reportStep: (command: string) => Promise<void>) => Promise<void>;
};

const CODEX_INITIALIZE_TIMEOUT_MS = 10_000;

export async function createKirbotRuntime(options: CreateKirbotRuntimeOptions): Promise<KirbotRuntime> {
  const config = options.config ?? (await import("./config")).loadConfig();
  const baseLogger = options.fallbackLogger ?? console;
  const logTarget = options.logTarget ?? createConsoleLogTarget(baseLogger);
  const appLogger = createSourceLogger(logTarget, "kirbot");
  const codexLogger = createSourceLogger(logTarget, "codex-app-server");

  const database = new BridgeDatabase(config.database.path, config.codex.routing);
  const mediaStore = new TemporaryImageStore(config.telegram.mediaTempDir);
  await database.migrate();
  await mediaStore.cleanupStaleFiles();

  const expiredPendingRequests = await database.expirePendingRequests();
  if (expiredPendingRequests > 0) {
    appLogger.warn(`Expired ${expiredPendingRequests} pending Codex request(s) from a previous run.`);
  }

  const rpcClients: CodexRpcClient[] = [];
  const spawnedAppServers: SpawnedAppServer[] = [];
  const codex = await initializeCodex(config, options.codexApi, codexLogger).then((result) => {
    rpcClients.push(...result.rpcClients);
    spawnedAppServers.push(...result.spawnedAppServers);
    return result.codex;
  });

  const bridge = new TelegramCodexBridge(
    config,
    database,
    options.telegramApi,
    codex,
    mediaStore,
    appLogger,
    options.restartKirbot
      ? {
          restartKirbot: options.restartKirbot
        }
      : undefined
  );

  if (options.telegramCommandApi) {
    const commandSync = new TelegramCommandSync(
      options.telegramCommandApi,
      config.telegram.workspaceChatId,
      appLogger
    );
    await initializeTelegramCommandSyncFailOpen(commandSync, appLogger);
  }

  return {
    config,
    bridge,
    database,
    codex,
    shutdown: async () => {
      for (const client of rpcClients) {
        await client.close();
      }
      for (const appServer of spawnedAppServers) {
        await appServer.stop();
      }
      await database.close();
    },
    getActivitySnapshot: async () => ({
      activeTurnCount: bridge.getActiveTurnCount(),
      pendingRequestCount: await database.countPendingRequests(),
      activeTopics: bridge.getActiveTopics()
    })
  };
}

async function initializeCodex(
  config: AppConfig,
  codexApi: BridgeCodexApi | undefined,
  logger: LoggerLike
): Promise<{
  codex: BridgeCodexApi;
  rpcClients: CodexRpcClient[];
  spawnedAppServers: SpawnedAppServer[];
}> {
  if (codexApi) {
    return {
      codex: codexApi,
      rpcClients: [],
      spawnedAppServers: []
    };
  }

  const gateways: Record<string, { codex: CodexGateway; rpcClient: CodexRpcClient; spawnedAppServer: SpawnedAppServer }> = {};

  try {
    for (const [profileId, profile] of Object.entries(config.codex.profiles)) {
      prepareKirbotCodexHome({
        targetHomePath: profile.homePath,
        managed: {
          managedConfigToml: renderManagedConfigToml(profile, config.codex.mcps),
          managedSkillIds: profile.skills,
          managedProfilesConfigPath: config.codex.profilesConfigPath
        }
      });

      const gateway = await initializeGateway(buildGatewayConfig(config, profile), logger, profile.homePath);
      gateways[profileId] = gateway;
    }
  } catch (error) {
    await Promise.all(
      Object.values(gateways).map((gateway) =>
        cleanupGatewayResources(gateway.rpcClient, gateway.spawnedAppServer)
      )
    );
    throw error;
  }

  return {
    codex: new RoutedCodexApi(
      Object.fromEntries(Object.entries(gateways).map(([profileId, gateway]) => [profileId, gateway.codex])),
      logger
    ),
    rpcClients: Object.values(gateways).map((gateway) => gateway.rpcClient),
    spawnedAppServers: Object.values(gateways).map((gateway) => gateway.spawnedAppServer)
  };
}

async function initializeGateway(
  config: CodexClientAppConfig["codex"],
  logger: LoggerLike,
  codexHomePath?: string
): Promise<{
  codex: CodexGateway;
  rpcClient: CodexRpcClient;
  spawnedAppServer: SpawnedAppServer;
}> {
  const spawnedAppServer = await spawnCodexAppServer({
    logger,
    ...(codexHomePath ? { codexHomePath } : {})
  });
  let transport: StdioRpcTransport | undefined;
  let rpcClient: CodexRpcClient | undefined;
  try {
    transport = new StdioRpcTransport(spawnedAppServer.process);
    await transport.connect();

    rpcClient = new CodexRpcClient(transport);
    const codex = new CodexGateway(rpcClient, config);
    await withTimeout(codex.initialize(), CODEX_INITIALIZE_TIMEOUT_MS, "Timed out waiting for Codex app server initialization");

    return {
      codex,
      rpcClient,
      spawnedAppServer
    };
  } catch (error) {
    await cleanupGatewayResources(rpcClient, spawnedAppServer);
    throw error;
  }
}

function buildGatewayConfig(
  config: AppConfig,
  profile: AppConfig["codex"]["profiles"][string]
): CodexClientAppConfig["codex"] {
  return {
    defaultCwd: profile.defaultCwd,
    model: config.codex.model,
    modelProvider: config.codex.modelProvider,
    sandbox: config.codex.sandbox,
    approvalPolicy: config.codex.approvalPolicy,
    serviceName: config.codex.serviceName,
    developerInstructions: config.codex.developerInstructions,
    config: config.codex.config
  };
}

async function cleanupGatewayResources(
  rpcClient: CodexRpcClient | undefined,
  spawnedAppServer: SpawnedAppServer | undefined
): Promise<void> {
  await Promise.allSettled([rpcClient?.close(), spawnedAppServer?.stop()]);
}

function renderManagedConfigToml(
  profile: AppConfig["codex"]["profiles"][string],
  mcpRegistry: AppConfig["codex"]["mcps"]
): string {
  const lines: string[] = [];

  if (profile.model) {
    lines.push(`model = ${renderTomlValue(profile.model)}`);
  }
  lines.push(`model_reasoning_effort = ${renderTomlValue(profile.reasoningEffort)}`);
  lines.push(`service_tier = ${renderTomlValue(profile.serviceTier)}`);
  if (profile.sandboxMode) {
    lines.push(`sandbox_mode = ${renderTomlValue(profile.sandboxMode)}`);
  }
  if (profile.approvalPolicy !== undefined) {
    lines.push(`approval_policy = ${renderTomlValue(profile.approvalPolicy as JsonValue)}`);
  }

  for (const mcpId of profile.mcps) {
    const mcpConfig = mcpRegistry[mcpId];
    if (!mcpConfig) {
      throw new Error(`Profile references missing MCP registry entry ${JSON.stringify(mcpId)}`);
    }

    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(`[mcp_servers.${renderTomlKey(mcpId)}]`);
    for (const [key, value] of Object.entries(mcpConfig).sort(([left], [right]) => left.localeCompare(right))) {
      if (value === undefined) {
        continue;
      }

      lines.push(`${renderTomlKey(key)} = ${renderTomlValue(value)}`);
    }
  }

  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function renderTomlValue(value: JsonValue): string {
  if (value === null) {
    throw new Error("Managed Codex config does not support null TOML values");
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`Managed Codex config only supports finite numeric TOML values, got ${value}`);
      }
      return `${value}`;
    case "string":
      return JSON.stringify(value);
    case "object":
      if (Array.isArray(value)) {
      return `[${value.map((entry) => renderTomlValue(entry)).join(", ")}]`;
      }

      return `{ ${Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => `${renderTomlKey(key)} = ${renderTomlValue(entry!)}`)
        .join(", ")} }`;
    default:
      throw new Error(`Unsupported TOML value type: ${typeof value}`);
  }
}

function renderTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
