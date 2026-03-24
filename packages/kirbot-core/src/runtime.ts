import { existsSync } from "node:fs";
import { CodexGateway, spawnCodexAppServer } from "@kirbot/codex-client";
import { TelegramCodexBridge, type BridgeCodexApi } from "./bridge";
import type { AppConfig } from "./config";
import { prepareKirbotCodexHome, resolveKirbotCodexConfigPath } from "./codex-home";
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

  const database = new BridgeDatabase(config.database.path);
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

  const sharedProfileHomePath = resolveCodexProfileHomePath(config, config.codex.routing.general);
  const isolatedProfileHomePath = resolveCodexProfileHomePath(config, config.codex.routing.thread);

  prepareKirbotCodexHome({
    targetHomePath: sharedProfileHomePath
  });
  prepareKirbotCodexHome({
    targetHomePath: isolatedProfileHomePath
  });

  // The isolated config.toml is Kirbot's global Codex policy source.
  // Code should only override it intentionally for thread-local settings or per-session cwd.
  const shouldBootstrapIsolatedConfig =
    !existsSync(resolveKirbotCodexConfigPath(isolatedProfileHomePath));
  const shared = await initializeGateway(config, logger, sharedProfileHomePath);
  const isolated = await initializeGateway(
    config,
    logger,
    isolatedProfileHomePath
  );
  if (shouldBootstrapIsolatedConfig) {
    await isolated.codex.bootstrapManagedGlobalConfig();
  }

  return {
    codex: new RoutedCodexApi(
      {
        shared: shared.codex,
        isolated: isolated.codex
      },
      logger
    ),
    rpcClients: [shared.rpcClient, isolated.rpcClient],
    spawnedAppServers: [shared.spawnedAppServer, isolated.spawnedAppServer]
  };
}

async function initializeGateway(
  config: AppConfig,
  logger: LoggerLike,
  homePath?: string
): Promise<{
  codex: CodexGateway;
  rpcClient: CodexRpcClient;
  spawnedAppServer: SpawnedAppServer;
}> {
  const spawnedAppServer = await spawnCodexAppServer({
    logger,
    ...(homePath ? { homePath } : {})
  });
  const transport = new StdioRpcTransport(spawnedAppServer.process);
  await transport.connect();

  const rpcClient = new CodexRpcClient(transport);
  const codex = new CodexGateway(rpcClient, config.codex);
  await withTimeout(codex.initialize(), CODEX_INITIALIZE_TIMEOUT_MS, "Timed out waiting for Codex app server initialization");

  return {
    codex,
    rpcClient,
    spawnedAppServer
  };
}

function resolveCodexProfileHomePath(config: AppConfig, profileId: string): string {
  const profile = config.codex.profiles[profileId];
  if (!profile) {
    throw new Error(`Unknown Codex profile referenced by routing: ${profileId}`);
  }

  return profile.homePath;
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
