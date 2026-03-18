import { CodexGateway, spawnCodexAppServer } from "./codex";
import { TelegramCodexBridge, type BridgeCodexApi } from "./bridge";
import type { AppConfig } from "./config";
import { BridgeDatabase } from "./db";
import { createConsoleLogTarget, createSourceLogger, type AppLogTarget, type LoggerLike } from "./logging";
import { TemporaryImageStore } from "./media-store";
import { CodexRpcClient, StdioRpcTransport, type SpawnedAppServer } from "./rpc";
import {
  TelegramCommandSync,
  initializeTelegramCommandSyncFailOpen,
  type TelegramCommandApi
} from "./telegram-command-sync";
import type { TelegramApi } from "./telegram-messenger";
import { startMiniAppServer } from "./mini-app/server";
import { normalizeTelegramMiniAppPublicUrl } from "./mini-app/url";

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

const CODEX_INITIALIZE_TIMEOUT_MS = 10_000;

export async function createKirbotRuntime(options: CreateKirbotRuntimeOptions): Promise<KirbotRuntime> {
  const config = options.config ?? (await import("./config")).loadConfig();
  const normalizedMiniAppPublicUrl = normalizeTelegramMiniAppPublicUrl(config.telegram.miniApp.publicUrl);
  const normalizedMiniAppApiPublicUrl = normalizeTelegramMiniAppPublicUrl(config.telegram.miniApp.apiPublicUrl);
  const effectiveConfig: AppConfig =
    normalizedMiniAppPublicUrl === config.telegram.miniApp.publicUrl &&
      normalizedMiniAppApiPublicUrl === config.telegram.miniApp.apiPublicUrl
      ? config
      : {
          ...config,
          telegram: {
            ...config.telegram,
            miniApp: {
              ...config.telegram.miniApp,
              publicUrl: normalizedMiniAppPublicUrl ?? undefined,
              apiPublicUrl: normalizedMiniAppApiPublicUrl ?? undefined
            }
          }
        };
  const baseLogger = options.fallbackLogger ?? console;
  const logTarget = options.logTarget ?? createConsoleLogTarget(baseLogger);
  const appLogger = createSourceLogger(logTarget, "kirbot");
  const codexLogger = createSourceLogger(logTarget, "codex-app-server");

  if (config.telegram.miniApp.publicUrl && !normalizedMiniAppPublicUrl) {
    appLogger.warn(
      "Ignoring TELEGRAM_MINI_APP_PUBLIC_URL because Telegram Mini App buttons require an https URL."
    );
  }
  if (config.telegram.miniApp.apiPublicUrl && !normalizedMiniAppApiPublicUrl) {
    appLogger.warn(
      "Ignoring TELEGRAM_MINI_APP_API_PUBLIC_URL because the Mini App artifact API requires an https URL."
    );
  }

  const database = new BridgeDatabase(effectiveConfig.database.path);
  const mediaStore = new TemporaryImageStore(effectiveConfig.telegram.mediaTempDir);
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
  const codex = await initializeCodex(effectiveConfig, options.codexApi, codexLogger).then((result) => {
    rpcClient = result.rpcClient;
    spawnedAppServer = result.spawnedAppServer;
    return result.codex;
  });
  const miniAppServer = await startMiniAppServer({
    config: effectiveConfig.telegram,
    database,
    logger: appLogger
  }).catch((error) => {
    appLogger.warn("Mini App server failed during startup; continuing without Mini App support.", error);
    return null;
  });

  const bridge = new TelegramCodexBridge(
    effectiveConfig,
    database,
    options.telegramApi,
    codex,
    mediaStore,
    appLogger
  );

  if (options.telegramCommandApi) {
    const commandSync = new TelegramCommandSync(options.telegramCommandApi, effectiveConfig.telegram.userId, appLogger);
    await initializeTelegramCommandSyncFailOpen(commandSync, appLogger);
  }

  return {
    config: effectiveConfig,
    bridge,
    database,
    codex,
    shutdown: async () => {
      await miniAppServer?.stop();
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
    logger
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
