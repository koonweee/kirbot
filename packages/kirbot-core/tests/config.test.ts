import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

vi.mock("dotenv", () => ({
  config: vi.fn()
}));

const originalEnv = { ...process.env };
const originalCwd = process.cwd();

const baseTelegramEnv = {
  TELEGRAM_BOT_TOKEN: "token",
  TELEGRAM_WORKSPACE_CHAT_ID: "-100123",
  TELEGRAM_MINI_APP_PUBLIC_URL: "https://example.com/mini-app"
};

type CodexProfilesFile = {
  routes: Record<string, string>;
  skills?: Record<string, Record<string, never>>;
  mcps?: Record<string, Record<string, unknown>>;
  profiles: Record<
    string,
    {
      model?: string;
      sandboxMode?: string | { [key: string]: unknown };
      approvalPolicy?: unknown;
      skills?: string[];
      mcps?: string[];
    }
  >;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  process.env = { ...originalEnv };
  process.chdir(originalCwd);
});

describe("core config module", () => {
  it("does not require Telegram env vars just to import the package surface", async () => {
    process.env = {};

    const core = await import("../src/index");

    expect(core.loadConfig).toBeTypeOf("function");
  });

  it("loads the checked-in profile config from disk and derives homes from DATABASE_PATH", async () => {
    await withFixture(
      createConfig(),
      { DATABASE_PATH: "/var/lib/kirbot/telegram-codex-bridge.sqlite" },
      async () => {
        const { loadConfig } = await import("../src/config");
        const config = loadConfig();

        expect(config.codex.routing).toEqual({
          general: "general",
          thread: "coding",
          plan: "coding"
        });
        expect(config.codex.profiles.general!.homePath).toBe("/var/lib/kirbot/homes/general");
        expect(config.codex.profiles.coding!.homePath).toBe("/var/lib/kirbot/homes/coding");
      }
    );
  });

  it("expands DATABASE_PATH before deriving managed homes", async () => {
    await withFixture(
      createConfig(),
      { DATABASE_PATH: "~/kirbot/telegram-codex-bridge.sqlite" },
      async () => {
        const { loadConfig } = await import("../src/config");
        const config = loadConfig();

        expect(config.database.path).toBe(resolve(homedir(), "kirbot/telegram-codex-bridge.sqlite"));
        expect(config.codex.profiles.general!.homePath).toBe(resolve(homedir(), "kirbot/homes/general"));
        expect(config.codex.profiles.coding!.homePath).toBe(resolve(homedir(), "kirbot/homes/coding"));
      }
    );
  });

  it("requires TELEGRAM_WORKSPACE_CHAT_ID when loading config", async () => {
    await withFixture(
      createConfig(),
      {
        TELEGRAM_WORKSPACE_CHAT_ID: ""
      },
      async () => {
        const { loadConfig } = await import("../src/config");

        expect(() => loadConfig()).toThrow("TELEGRAM_WORKSPACE_CHAT_ID is required");
      }
    );
  });

  it("requires TELEGRAM_WORKSPACE_CHAT_ID to be present in the environment", async () => {
    await withFixture(
      createConfig(),
      {},
      async () => {
        delete process.env.TELEGRAM_WORKSPACE_CHAT_ID;

        const { loadConfig } = await import("../src/config");

        expect(() => loadConfig()).toThrow("TELEGRAM_WORKSPACE_CHAT_ID is required");
      }
    );
  });

  it("rejects positive TELEGRAM_WORKSPACE_CHAT_ID values", async () => {
    await withFixture(
      createConfig(),
      {
        TELEGRAM_WORKSPACE_CHAT_ID: "42"
      },
      async () => {
        const { loadConfig } = await import("../src/config");

        expect(() => loadConfig()).toThrow("TELEGRAM_WORKSPACE_CHAT_ID must be negative");
      }
    );
  });

  it("requires a valid TELEGRAM_MINI_APP_PUBLIC_URL", async () => {
    await withFixture(
      createConfig(),
      {
        TELEGRAM_MINI_APP_PUBLIC_URL: "not-a-url"
      },
      async () => {
        const { loadConfig } = await import("../src/config");

        expect(() => loadConfig()).toThrow("Invalid URL");
      }
    );
  });

  it("requires TELEGRAM_MINI_APP_PUBLIC_URL to use https", async () => {
    await withFixture(
      createConfig(),
      {
        TELEGRAM_MINI_APP_PUBLIC_URL: "http://example.com/mini-app"
      },
      async () => {
        const { loadConfig } = await import("../src/config");

        expect(() => loadConfig()).toThrow("TELEGRAM_MINI_APP_PUBLIC_URL must use https");
      }
    );
  });

  it("ignores env-authored Codex defaults in favor of the checked-in profile config", async () => {
    await withFixture(
      createConfig(),
      {
        CODEX_MODEL: "gpt-4.1",
        CODEX_MODEL_PROVIDER: "openai",
        CODEX_SANDBOX_MODE: "danger-full-access",
        CODEX_APPROVAL_POLICY: "never",
        CODEX_CONFIG_JSON: JSON.stringify({ foo: "bar" })
      },
      async () => {
        const { loadConfig } = await import("../src/config");
        const config = loadConfig();

        expect(config.codex.model).toBeUndefined();
        expect(config.codex.modelProvider).toBeUndefined();
        expect(config.codex.sandbox).toBeUndefined();
        expect(config.codex.approvalPolicy).toBeUndefined();
        expect(config.codex.config).toBeUndefined();
      }
    );
  });

  it("rejects configs missing routes.thread and routes.plan", async () => {
    await withFixtureText(
      JSON.stringify({
        routes: {
          general: "general"
        },
        skills: {},
        mcps: {},
        profiles: {
          general: createProfile(),
          coding: createProfile({
            sandboxMode: "danger-full-access",
            approvalPolicy: "never"
          })
        }
      }),
      {},
      async () => {
        const error = await captureLoadConfigError();
        expect(issuePaths(error)).toContain("routes.thread");
        expect(issuePaths(error)).toContain("routes.plan");
      }
    );
  });

  it("rejects routing targets that reference an undeclared profile", async () => {
    await withFixture(
      createConfig({
        routes: {
          general: "general",
          thread: "missing",
          plan: "coding"
        }
      }),
      {},
      async () => {
        const error = await captureLoadConfigError();
        expect(issuePaths(error)).toContain("routes.thread");
      }
    );
  });

  it("rejects configs where routing.general is shared with another route", async () => {
    await withFixture(
      createConfig({
        profiles: {
          general: createProfile(),
          shared: createProfile()
        },
        routes: {
          general: "shared",
          thread: "shared",
          plan: "shared"
        }
      }),
      {},
      async () => {
        const error = await captureLoadConfigError();
        expect(issuePaths(error)).toContain("routes.general");
      }
    );
  });

  it("rejects invalid JSON shape", async () => {
    await withFixtureText(
      JSON.stringify({
        routes: {
          general: "general",
          thread: "coding",
          plan: "coding"
        },
        profiles: []
      }),
      {},
      async () => {
        const error = await captureLoadConfigError();
        expect(issuePaths(error)).toContain("profiles");
      }
    );
  });

  it("rejects invalid sandbox values", async () => {
    await withFixture(
      createConfig({
        profiles: {
          general: createProfile({ sandboxMode: "bogus" })
        }
      }),
      {},
      async () => {
        const error = await captureLoadConfigError();
        expect(issuePaths(error)).toContain("profiles.general.sandboxMode");
      }
    );
  });

  it("rejects invalid approval values", async () => {
    await withFixture(
      createConfig({
        profiles: {
          general: createProfile({ approvalPolicy: 42 })
        }
      }),
      {},
      async () => {
        const error = await captureLoadConfigError();
        expect(issuePaths(error)).toContain("profiles.general.approvalPolicy");
      }
    );
  });

  it("rejects invalid model values", async () => {
    await withFixture(
      createConfig({
        profiles: {
          general: createProfile({ model: "   " })
        }
      }),
      {},
      async () => {
        const error = await captureLoadConfigError();
        expect(issuePaths(error)).toContain("profiles.general.model");
      }
    );
  });

  it("rejects profiles that reference undeclared skill ids", async () => {
    await withFixture(
      createConfig({
        profiles: {
          general: createProfile({ skills: ["brainstorming"] })
        }
      }),
      {},
      async () => {
        const error = await captureLoadConfigError();
        expect(issuePaths(error)).toContain("profiles.general.skills.0");
      }
    );
  });

  it("rejects profiles that reference missing skill directories", async () => {
    await withFixture(
      createConfig({
        skills: {
          brainstorming: {}
        },
        profiles: {
          general: createProfile({ skills: ["brainstorming"] })
        }
      }),
      {},
      async () => {
        const error = await captureLoadConfigError();
        expect(issuePaths(error)).toContain("profiles.general.skills.0");
      }
    );
  });

  it("rejects profiles that reference skill directories missing SKILL.md", async () => {
    await withFixture(
      createConfig({
        skills: {
          brainstorming: {}
        },
        profiles: {
          general: createProfile({ skills: ["brainstorming"] })
        }
      }),
      {},
      async (root) => {
        mkdirSync(join(root, "skills", "brainstorming"), { recursive: true });

        const error = await captureLoadConfigError();
        expect(issuePaths(error)).toContain("profiles.general.skills.0");
      }
    );
  });

  it("rejects profiles that reference undeclared MCP keys", async () => {
    await withFixture(
      createConfig({
        profiles: {
          general: createProfile({ mcps: ["github"] })
        }
      }),
      {},
      async () => {
        const error = await captureLoadConfigError();
        expect(issuePaths(error)).toContain("profiles.general.mcps.0");
      }
    );
  });

  it("warns about unused declared skills, unused MCPs, and stray skills folders", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await withFixture(
      createConfig({
        skills: {
          "unused-skill": {},
          "also-unused": {}
        },
        mcps: {
          "unused-mcp": {}
        }
      }),
      {},
      async (root) => {
        mkdirSync(join(root, "skills", "stray-folder"), { recursive: true });
        writeFileSync(join(root, "skills", "stray-folder", "SKILL.md"), "# stray-folder\n");

        await captureLoadConfig();

        const warnings = warnSpy.mock.calls.flat().join("\n");
        expect(warnings).toContain("unused-skill");
        expect(warnings).toContain("also-unused");
        expect(warnings).toContain("unused-mcp");
        expect(warnings).toContain("stray-folder");
      }
    );
  });

  it("rejects profile ids that are path-like", async () => {
    await withFixture(
      createConfig({
        profiles: {
          general: createProfile(),
          "./foo": createProfile(),
          "/bar": createProfile(),
          "foo/bar": createProfile()
        }
      }),
      {},
      async () => {
        const error = await captureLoadConfigError();
        expect(issuePaths(error)).toContain("profiles../foo");
        expect(issuePaths(error)).toContain("profiles./bar");
        expect(issuePaths(error)).toContain("profiles.foo/bar");
      }
    );
  });

  it("rejects empty profile ids", async () => {
    await withFixture(
      createConfig({
        profiles: {
          general: createProfile(),
          "": createProfile()
        }
      }),
      {},
      async () => {
        const error = await captureLoadConfigError();
        expect(issuePaths(error)).toContain("profiles.");
      }
    );
  });
});

function createProfile(overrides: Partial<CodexProfilesFile["profiles"][string]> = {}) {
  return {
    model: "gpt-5",
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request",
    skills: [],
    mcps: [],
    ...overrides
  };
}

function createConfig(overrides: Partial<CodexProfilesFile> = {}): CodexProfilesFile {
  return {
    routes: {
      general: "general",
      thread: "coding",
      plan: "coding",
      ...(overrides.routes ?? {})
    },
    skills: {
      ...(overrides.skills ?? {})
    },
    mcps: {
      ...(overrides.mcps ?? {})
    },
    profiles: {
      general: createProfile(overrides.profiles?.general),
      coding: createProfile({
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
        ...(overrides.profiles?.coding ?? {})
      }),
      ...(overrides.profiles ?? {})
    }
  };
}

async function withFixture<T>(
  config: CodexProfilesFile,
  env: Record<string, string> = {},
  callback: (root: string) => Promise<T>
): Promise<T> {
  return withFixtureText(JSON.stringify(config, null, 2), env, callback);
}

async function withFixtureText<T>(
  configText: string,
  env: Record<string, string> = {},
  callback: (root: string) => Promise<T>
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "kirbot-config-"));
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "codex-profiles.json"), `${configText}\n`);

  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };

  process.chdir(root);
  process.env = {
    ...originalEnv,
    ...baseTelegramEnv,
    ...env
  };

  vi.resetModules();
  try {
    return await callback(root);
  } finally {
    process.chdir(previousCwd);
    process.env = previousEnv;
    vi.resetModules();
  }
}

async function captureLoadConfig() {
  const { loadConfig } = await import("../src/config");
  return loadConfig();
}

async function captureLoadConfigError(): Promise<unknown> {
  try {
    await captureLoadConfig();
    throw new Error("Expected loadConfig() to fail");
  } catch (error) {
    return error;
  }
}

function issuePaths(error: unknown): string[] {
  return (
    (error as { issues?: Array<{ path?: Array<string | number> }> }).issues?.map(
      (issue) => issue.path?.join(".") ?? ""
    ) ?? []
  );
}
