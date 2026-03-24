import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const mocks = vi.hoisted(() => {
  const existsSync = vi.fn();
  const loadConfig = vi.fn();
  const spawnCodexAppServer = vi.fn();
  const prepareKirbotCodexHome = vi.fn();
  const initializeTelegramCommandSyncFailOpen = vi.fn();
  const spawnedAppServers: Array<{ process: unknown; stop: ReturnType<typeof vi.fn> }> = [];
  const rpcClients: Array<{ close: ReturnType<typeof vi.fn> }> = [];
  const codexGatewayInstances: Array<{
    initialize: ReturnType<typeof vi.fn>;
    bootstrapManagedGlobalConfig: ReturnType<typeof vi.fn>;
  }> = [];
  const codexGatewayInitializeErrors: Array<Error | undefined> = [];
  const codexGatewayBootstrapErrors: Array<Error | undefined> = [];

  return {
    existsSync,
    loadConfig,
    spawnCodexAppServer,
    prepareKirbotCodexHome,
    initializeTelegramCommandSyncFailOpen,
    spawnedAppServers,
    rpcClients,
    codexGatewayInstances,
    codexGatewayInitializeErrors,
    codexGatewayBootstrapErrors
  };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: mocks.existsSync
  };
});

vi.mock("../src/config", async () => {
  const actual = await vi.importActual<typeof import("../src/config")>("../src/config");
  return {
    ...actual,
    loadConfig: mocks.loadConfig
  };
});

vi.mock("@kirbot/codex-client", () => {
  class CodexGateway {
    readonly initialize = vi.fn(async () => {
      const error = mocks.codexGatewayInitializeErrors.shift();
      if (error) {
        throw error;
      }
    });
    readonly bootstrapManagedGlobalConfig = vi.fn(async () => {
      const error = mocks.codexGatewayBootstrapErrors.shift();
      if (error) {
        throw error;
      }
    });

    constructor(
      readonly rpcClient: unknown,
      readonly config: unknown
    ) {
      mocks.codexGatewayInstances.push(this);
    }
  }

  class CodexRpcClient {
    readonly close = vi.fn(async () => undefined);

    constructor(readonly transport: unknown) {
      mocks.rpcClients.push(this);
    }
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

describe("createKirbotRuntime profile routing", () => {
  beforeEach(() => {
    mocks.existsSync.mockReset();
    mocks.loadConfig.mockReset();
    mocks.spawnCodexAppServer.mockImplementation(async ({ homePath }: { homePath?: string }) => {
      const stop = vi.fn(async () => undefined);
      const server = {
        process: { homePath },
        stop
      };
      mocks.spawnedAppServers.push(server);
      return server;
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    mocks.existsSync.mockReset();
    mocks.loadConfig.mockReset();
    mocks.codexGatewayInstances.length = 0;
    mocks.spawnedAppServers.length = 0;
    mocks.rpcClients.length = 0;
    mocks.codexGatewayInitializeErrors.length = 0;
    mocks.codexGatewayBootstrapErrors.length = 0;
  });

  it("spawns one app-server per configured profile with the configured home path", async () => {
    const generalHomePath = join(tmpdir(), `kirbot-runtime-general-${randomUUID()}`);
    const codingHomePath = join(tmpdir(), `kirbot-runtime-coding-${randomUUID()}`);
    const docsHomePath = join(tmpdir(), `kirbot-runtime-docs-${randomUUID()}`);
    const config = buildConfig(generalHomePath, codingHomePath, docsHomePath);

    await createKirbotRuntime({
      config,
      telegramApi: {} as TelegramApi
    });

    expect(mocks.prepareKirbotCodexHome.mock.calls[0]?.[0]).toEqual({
      targetHomePath: generalHomePath,
      managed: {
        managedConfigToml: [
          'model = "gpt-5"',
          'model_reasoning_effort = "medium"',
          'service_tier = "flex"',
          'sandbox_mode = "workspace-write"',
          'approval_policy = "on-request"',
          ""
        ].join("\n"),
        managedSkillIds: [],
        managedProfilesConfigPath: "/workspace/config/codex-profiles.json"
      }
    });
    expect(mocks.prepareKirbotCodexHome.mock.calls[1]?.[0]).toEqual({
      targetHomePath: codingHomePath,
      managed: {
        managedConfigToml: [
          'model = "gpt-5-codex"',
          'model_reasoning_effort = "high"',
          'service_tier = "fast"',
          'sandbox_mode = "danger-full-access"',
          'approval_policy = "never"',
          "",
          "[mcp_servers.github]",
          'command = ["github-mcp", "serve"]',
          'type = "stdio"',
          ""
        ].join("\n"),
        managedSkillIds: ["brainstorming"],
        managedProfilesConfigPath: "/workspace/config/codex-profiles.json"
      }
    });
    expect(mocks.prepareKirbotCodexHome.mock.calls[2]?.[0]).toEqual({
      targetHomePath: docsHomePath,
      managed: {
        managedConfigToml: [
          'model = "gpt-5"',
          'model_reasoning_effort = "medium"',
          'service_tier = "flex"',
          'sandbox_mode = "read-only"',
          'approval_policy = "on-request"',
          ""
        ].join("\n"),
        managedSkillIds: [],
        managedProfilesConfigPath: "/workspace/config/codex-profiles.json"
      }
    });
    expect(mocks.spawnCodexAppServer.mock.calls.map(([options]) => options?.homePath)).toEqual([
      generalHomePath,
      codingHomePath,
      docsHomePath
    ]);
    expect(mocks.codexGatewayInstances).toHaveLength(3);
  });

  it("does not start a shared-home gateway", async () => {
    const generalHomePath = join(tmpdir(), `kirbot-runtime-general-${randomUUID()}`);
    const codingHomePath = join(tmpdir(), `kirbot-runtime-coding-${randomUUID()}`);
    const config = buildConfig(generalHomePath, codingHomePath, undefined, false);

    await createKirbotRuntime({
      config,
      telegramApi: {} as TelegramApi
    });

    expect(mocks.spawnCodexAppServer.mock.calls).toHaveLength(2);
    expect(mocks.spawnCodexAppServer.mock.calls.map(([options]) => options?.homePath)).toEqual([
      generalHomePath,
      codingHomePath
    ]);
  });

  it("cleans up the first gateway if a later profile initialization fails", async () => {
    const generalHomePath = join(tmpdir(), `kirbot-runtime-general-${randomUUID()}`);
    const codingHomePath = join(tmpdir(), `kirbot-runtime-coding-${randomUUID()}`);
    const config = buildConfig(generalHomePath, codingHomePath);
    mocks.codexGatewayInitializeErrors.push(undefined, new Error("second gateway failed"));

    await expect(
      createKirbotRuntime({
        config,
        telegramApi: {} as TelegramApi
      })
    ).rejects.toThrow("second gateway failed");

    expect(mocks.spawnedAppServers).toHaveLength(2);
    expect(mocks.spawnedAppServers[0]!.stop).toHaveBeenCalledTimes(1);
    expect(mocks.spawnedAppServers[1]!.stop).toHaveBeenCalledTimes(1);
    expect(mocks.rpcClients[0]!.close).toHaveBeenCalledTimes(1);
    expect(mocks.rpcClients[1]!.close).toHaveBeenCalledTimes(1);
  });

  it("does not start any gateway if managed home reconciliation fails before spawn", async () => {
    const generalHomePath = join(tmpdir(), `kirbot-runtime-general-${randomUUID()}`);
    const codingHomePath = join(tmpdir(), `kirbot-runtime-coding-${randomUUID()}`);
    const config = buildConfig(generalHomePath, codingHomePath, undefined, false);
    mocks.prepareKirbotCodexHome.mockImplementationOnce(() => {
      throw new Error("home reconcile failed");
    });

    await expect(
      createKirbotRuntime({
        config,
        telegramApi: {} as TelegramApi
      })
    ).rejects.toThrow("home reconcile failed");

    expect(mocks.spawnedAppServers).toHaveLength(0);
    expect(mocks.spawnCodexAppServer).not.toHaveBeenCalled();
  });

  it("does not start any gateway when loadConfig validation fails before runtime initialization", async () => {
    mocks.loadConfig.mockImplementation(() => {
      throw new Error("invalid profile config");
    });

    await expect(
      createKirbotRuntime({
        telegramApi: {} as TelegramApi
      })
    ).rejects.toThrow("invalid profile config");

    expect(mocks.spawnCodexAppServer).not.toHaveBeenCalled();
    expect(mocks.prepareKirbotCodexHome).not.toHaveBeenCalled();
  });

  it("continues startup when loadConfig emits unused-asset warnings", async () => {
    const generalHomePath = join(tmpdir(), `kirbot-runtime-general-${randomUUID()}`);
    const codingHomePath = join(tmpdir(), `kirbot-runtime-coding-${randomUUID()}`);
    const config = buildConfig(generalHomePath, codingHomePath);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.loadConfig.mockImplementation(() => {
      console.warn("Unused declared skill id foo");
      console.warn("Unused MCP registry entry bar");
      return config;
    });

    await createKirbotRuntime({
      telegramApi: {} as TelegramApi
    });

    expect(warnSpy).toHaveBeenCalledWith("Unused declared skill id foo");
    expect(warnSpy).toHaveBeenCalledWith("Unused MCP registry entry bar");
    expect(mocks.spawnCodexAppServer).toHaveBeenCalledTimes(3);
  });

  it("allows a profile whose managed config.toml is otherwise empty", async () => {
    const generalHomePath = join(tmpdir(), `kirbot-runtime-general-${randomUUID()}`);
    const codingHomePath = join(tmpdir(), `kirbot-runtime-coding-${randomUUID()}`);
    const config = buildConfig(generalHomePath, codingHomePath);
    config.codex.profiles.general = {
      homePath: generalHomePath,
      model: undefined,
      reasoningEffort: "medium",
      serviceTier: "flex",
      sandboxMode: undefined,
      approvalPolicy: undefined,
      skills: [],
      mcps: []
    };

    await createKirbotRuntime({
      config,
      telegramApi: {} as TelegramApi
    });

    expect(mocks.prepareKirbotCodexHome.mock.calls[0]?.[0]).toEqual({
      targetHomePath: generalHomePath,
      managed: {
        managedConfigToml: [
          'model_reasoning_effort = "medium"',
          'service_tier = "flex"',
          ""
        ].join("\n"),
        managedSkillIds: [],
        managedProfilesConfigPath: "/workspace/config/codex-profiles.json"
      }
    });
  });

  it("quotes MCP table keys that are not bare TOML identifiers", async () => {
    const generalHomePath = join(tmpdir(), `kirbot-runtime-general-${randomUUID()}`);
    const codingHomePath = join(tmpdir(), `kirbot-runtime-coding-${randomUUID()}`);
    const config = buildConfig(generalHomePath, codingHomePath);
    config.codex.profiles.coding!.mcps = ["github.com"];
    config.codex.mcps = {
      "github.com": {
        type: "stdio",
        command: ["github-mcp", "serve"]
      }
    };

    await createKirbotRuntime({
      config,
      telegramApi: {} as TelegramApi
    });

    expect(mocks.prepareKirbotCodexHome.mock.calls[1]?.[0]).toEqual({
      targetHomePath: codingHomePath,
      managed: {
        managedConfigToml: [
          'model = "gpt-5-codex"',
          'model_reasoning_effort = "high"',
          'service_tier = "fast"',
          'sandbox_mode = "danger-full-access"',
          'approval_policy = "never"',
          "",
          '[mcp_servers."github.com"]',
          'command = ["github-mcp", "serve"]',
          'type = "stdio"',
          ""
        ].join("\n"),
        managedSkillIds: ["brainstorming"],
        managedProfilesConfigPath: "/workspace/config/codex-profiles.json"
      }
    });
  });

  it("never bootstraps managed global config after handing runtime-owned config.toml to home reconciliation", async () => {
    const generalHomePath = join(tmpdir(), `kirbot-runtime-general-${randomUUID()}`);
    const codingHomePath = join(tmpdir(), `kirbot-runtime-coding-${randomUUID()}`);
    const config = buildConfig(generalHomePath, codingHomePath);

    await createKirbotRuntime({
      config,
      telegramApi: {} as TelegramApi
    });

    expect(mocks.codexGatewayInstances).toHaveLength(3);
    expect(mocks.codexGatewayInstances.every((instance) => instance.bootstrapManagedGlobalConfig.mock.calls.length === 0)).toBe(true);
  });
});

function buildConfig(
  generalHomePath: string,
  codingHomePath: string,
  docsHomePath = join(tmpdir(), `kirbot-runtime-docs-${randomUUID()}`),
  includeDocs = true
): AppConfig {
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
      profilesConfigPath: "/workspace/config/codex-profiles.json",
      profiles: {
        general: {
          homePath: generalHomePath,
          model: "gpt-5",
          reasoningEffort: "medium",
          serviceTier: "flex",
          sandboxMode: "workspace-write",
          approvalPolicy: "on-request",
          skills: [],
          mcps: []
        },
        coding: {
          homePath: codingHomePath,
          model: "gpt-5-codex",
          reasoningEffort: "high",
          serviceTier: "fast",
          sandboxMode: "danger-full-access",
          approvalPolicy: "never",
          skills: ["brainstorming"],
          mcps: ["github"]
        },
        ...(includeDocs
          ? {
              docs: {
                homePath: docsHomePath,
                model: "gpt-5",
                reasoningEffort: "medium",
                serviceTier: "flex",
                sandboxMode: "read-only",
                approvalPolicy: "on-request",
                skills: [],
                mcps: []
              }
            }
          : {})
      },
      routing: {
        general: "general",
        thread: "coding",
        plan: includeDocs ? "docs" : "coding"
      },
      mcps: {
        github: {
          type: "stdio",
          command: ["github-mcp", "serve"]
        }
      },
      model: undefined,
      modelProvider: undefined,
      sandbox: undefined,
      approvalPolicy: undefined,
      serviceName: "telegram-codex-bridge",
      developerInstructions: "prompt",
      config: undefined
    }
  };
}
