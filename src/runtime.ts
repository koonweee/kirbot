import { CodexGateway, spawnCodexAppServer } from "./codex";
import { TelegramCodexBridge, type BridgeCodexApi } from "./bridge";
import { loadConfig, type AppConfig } from "./config";
import { BridgeDatabase } from "./db";
import { createConsoleLogTarget, createSourceLogger, type AppLogTarget, type LoggerLike } from "./logging";
import { TemporaryImageStore } from "./media-store";
import { CodexRpcClient, WebSocketRpcTransport, type SpawnedAppServer } from "./rpc";
import {
  TelegramCommandSync,
  initializeTelegramCommandSyncFailOpen,
  type TelegramCommandApi
} from "./telegram-command-sync";
import type { TelegramApi } from "./telegram-messenger";

export type BridgeActivitySnapshot = {
  activeTurnCount: number;
  pendingRequestCount: number;
  activeTopics: Array<{ chatId: number; topicId: number }>;
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
};

export async function createKirbotRuntime(options: CreateKirbotRuntimeOptions): Promise<KirbotRuntime> {
  const config = options.config ?? loadConfig();
  const baseLogger = options.fallbackLogger ?? console;
  const logTarget = options.logTarget ?? createConsoleLogTarget(baseLogger);
  const appLogger = createSourceLogger(logTarget, "kirbot");
  const codexLogger = createSourceLogger(logTarget, "codex-app-server");

  const database = new BridgeDatabase(config.database.path);
  const mediaStore = new TemporaryImageStore(config.telegram.mediaTempDir);
  await database.migrate();
  await mediaStore.cleanupStaleFiles();

  const expiredPendingRequests = await database.expirePendingRequests(
    JSON.stringify({
      reason: "expired_on_startup",
      message: "Pending request expired because the Telegram bridge restarted."
    })
  );
  if (expiredPendingRequests > 0) {
    appLogger.warn(`Expired ${expiredPendingRequests} pending Codex request(s) from a previous run.`);
  }

  let rpcClient: CodexRpcClient | null = null;
  let spawnedAppServer: SpawnedAppServer | null = null;
  const codex = await initializeCodex(config, options.codexApi, codexLogger).then((result) => {
    rpcClient = result.rpcClient;
    spawnedAppServer = result.spawnedAppServer;
    return result.codex;
  });

  const bridge = new TelegramCodexBridge(config, database, options.telegramApi, codex, mediaStore, appLogger);

  if (options.telegramCommandApi) {
    const commandSync = new TelegramCommandSync(options.telegramCommandApi, config.telegram.userId, appLogger);
    await initializeTelegramCommandSyncFailOpen(commandSync, appLogger);
  }

  return {
    config,
    bridge,
    database,
    codex,
    shutdown: async () => {
      await rpcClient?.close();
      if (spawnedAppServer) {
        await spawnedAppServer.stop();
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
  rpcClient: CodexRpcClient | null;
  spawnedAppServer: SpawnedAppServer | null;
}> {
  if (codexApi) {
    return {
      codex: codexApi,
      rpcClient: null,
      spawnedAppServer: null
    };
  }

  const spawnedAppServer = await spawnCodexAppServer({
    url: config.codex.appServerUrl,
    logger
  });
  const transport = new WebSocketRpcTransport(config.codex.appServerUrl);
  await connectWithRetry(transport);

  const rpcClient = new CodexRpcClient(transport);
  const codex = new CodexGateway(rpcClient, config.codex);
  await codex.initialize();

  return {
    codex,
    rpcClient,
    spawnedAppServer
  };
}

async function connectWithRetry(transport: WebSocketRpcTransport, attempts = 30): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await transport.connect();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
