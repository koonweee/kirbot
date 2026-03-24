import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const mocks = vi.hoisted(() => {
  const spawnCodexAppServer = vi.fn();
  const prepareKirbotCodexHome = vi.fn();
  const initializeTelegramCommandSyncFailOpen = vi.fn();
  const codexGatewayInstances: Array<{
    initialize: ReturnType<typeof vi.fn>;
    bootstrapManagedGlobalConfig: ReturnType<typeof vi.fn>;
  }> = [];

  return {
    spawnCodexAppServer,
    prepareKirbotCodexHome,
    initializeTelegramCommandSyncFailOpen,
    codexGatewayInstances
  };
});

vi.mock("@kirbot/codex-client", () => {
  class CodexGateway {
    readonly initialize = vi.fn(async () => undefined);
    readonly bootstrapManagedGlobalConfig = vi.fn(async () => undefined);

    constructor(
      readonly rpcClient: unknown,
      readonly config: unknown
    ) {
      mocks.codexGatewayInstances.push(this);
    }
  }

  class CodexRpcClient {
    readonly close = vi.fn(async () => undefined);

    constructor(readonly transport: unknown) {}
  }

  class StdioRpcTransport {
    readonly connect = vi.fn(async () => undefined);

    constructor(readonly process: unknown) {}
  }

  return {
    CodexGateway,
    CodexRpcClient,
    StdioRpcTransport,
    spawnCodexAppServer: mocks.spawnCodexAppServer
  };
});

vi.mock("../src/codex-home", () => ({
  prepareKirbotCodexHome: mocks.prepareKirbotCodexHome,
  resolveKirbotCodexConfigPath: (homePath: string) => join(homePath, "config.toml")
}));

vi.mock("../src/db", () => {
  class BridgeDatabase {
    constructor(readonly path: string) {}

    migrate = vi.fn(async () => undefined);
    cleanupStaleFiles = vi.fn(async () => undefined);
    expirePendingRequests = vi.fn(async () => 0);
    countPendingRequests = vi.fn(async () => 0);
    close = vi.fn(async () => undefined);
  }

  return { BridgeDatabase };
});

vi.mock("../src/media-store", () => {
  class TemporaryImageStore {
    constructor(readonly path: string) {}

    cleanupStaleFiles = vi.fn(async () => undefined);
  }

  return { TemporaryImageStore };
});

vi.mock("../src/bridge", () => {
  class TelegramCodexBridge {
    constructor(..._args: unknown[]) {}

    getActiveTurnCount = vi.fn(() => 0);
    getActiveTopics = vi.fn(() => []);
  }

  return { TelegramCodexBridge };
});

vi.mock("../src/telegram-command-sync", () => ({
  TelegramCommandSync: class TelegramCommandSync {
    constructor(..._args: unknown[]) {}
  },
  initializeTelegramCommandSyncFailOpen: mocks.initializeTelegramCommandSyncFailOpen
}));

vi.mock("../src/logging", () => ({
  createConsoleLogTarget: () => ({}),
  createSourceLogger: () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn()
  })
}));

import type { AppConfig } from "../src/config";
import type { TelegramApi } from "../src/telegram-messenger";
import { createKirbotRuntime } from "../src/runtime";

describe("createKirbotRuntime temporary profile routing", () => {
  beforeEach(() => {
    mocks.spawnCodexAppServer.mockImplementation(async () => ({
      process: {},
      stop: vi.fn()
    }));
  });

  afterEach(() => {
    vi.clearAllMocks();
    mocks.codexGatewayInstances.length = 0;
  });

  it("routes general traffic to the shared profile and thread traffic to the isolated profile", async () => {
    const sharedHomePath = join(tmpdir(), `kirbot-runtime-shared-${randomUUID()}`);
    const isolatedHomePath = join(tmpdir(), `kirbot-runtime-isolated-${randomUUID()}`);
    const config = buildConfig(sharedHomePath, isolatedHomePath);

    await createKirbotRuntime({
      config,
      telegramApi: {} as TelegramApi
    });

    expect(mocks.prepareKirbotCodexHome.mock.calls).toEqual([
      [{ targetHomePath: sharedHomePath }],
      [{ targetHomePath: isolatedHomePath }]
    ]);
    expect(mocks.spawnCodexAppServer.mock.calls.map(([options]) => options?.homePath)).toEqual([
      sharedHomePath,
      isolatedHomePath
    ]);
  });

  it("bootstraps managed config only for the isolated gateway in the temporary two-gateway model", async () => {
    const sharedHomePath = join(tmpdir(), `kirbot-runtime-shared-${randomUUID()}`);
    const isolatedHomePath = join(tmpdir(), `kirbot-runtime-isolated-${randomUUID()}`);
    const config = buildConfig(sharedHomePath, isolatedHomePath);

    await createKirbotRuntime({
      config,
      telegramApi: {} as TelegramApi
    });

    expect(mocks.codexGatewayInstances).toHaveLength(2);
    expect(mocks.codexGatewayInstances[0]!.bootstrapManagedGlobalConfig).not.toHaveBeenCalled();
    expect(mocks.codexGatewayInstances[1]!.bootstrapManagedGlobalConfig).toHaveBeenCalledTimes(1);
  });
});

function buildConfig(sharedHomePath: string, isolatedHomePath: string): AppConfig {
  return {
    telegram: {
      botToken: "token",
      workspaceChatId: -100123,
      mediaTempDir: join(tmpdir(), `kirbot-media-${randomUUID()}`),
      miniApp: {
        publicUrl: "https://example.com/mini-app"
      }
    },
    database: {
      path: join(tmpdir(), `kirbot-db-${randomUUID()}.sqlite`)
    },
    codex: {
      defaultCwd: "/srv/kirbot",
      profiles: {
        general: { homePath: sharedHomePath },
        coding: { homePath: isolatedHomePath }
      },
      routing: {
        general: "general",
        thread: "coding",
        plan: "coding"
      },
      model: undefined,
      modelProvider: undefined,
      sandbox: undefined,
      approvalPolicy: undefined,
      serviceName: "telegram-codex-bridge",
      baseInstructions: undefined,
      developerInstructions: "prompt",
      config: undefined
    }
  };
}
