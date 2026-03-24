import { afterEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";

vi.mock("dotenv", () => ({
  config: vi.fn()
}));

const originalEnv = { ...process.env };

const CODEX_PROFILES_JSON = JSON.stringify({
  profiles: {
    general: { homePath: "/srv/kirbot/codex-home-general" },
    coding: { homePath: "/srv/kirbot/codex-home-coding" }
  },
  routing: {
    general: "general",
    thread: "coding",
    plan: "coding"
  }
});

const baseEnv = {
  CODEX_PROFILES_JSON
};

afterEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv };
});

describe("core config module", () => {
  it("does not require Telegram env vars just to import the package surface", async () => {
    process.env = {};

    const core = await import("../src/index");

    expect(core.loadConfig).toBeTypeOf("function");
  });

  it("requires a Mini App public URL when loading config", async () => {
    process.env = {
      ...baseEnv,
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_WORKSPACE_CHAT_ID: "-100123",
      TELEGRAM_MINI_APP_PUBLIC_URL: ""
    };

    const { loadConfig } = await import("../src/config");

    expect(() => loadConfig()).toThrow("Invalid URL");
  });

  it("requires TELEGRAM_WORKSPACE_CHAT_ID when loading config", async () => {
    process.env = {
      ...baseEnv,
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_MINI_APP_PUBLIC_URL: "https://example.com/mini-app"
    };

    const { loadConfig } = await import("../src/config");

    expect(() => loadConfig()).toThrow("TELEGRAM_WORKSPACE_CHAT_ID is required");
  });

  it("does not accept TELEGRAM_USER_ID as a workspace chat id", async () => {
    process.env = {
      ...baseEnv,
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_USER_ID: "42",
      TELEGRAM_MINI_APP_PUBLIC_URL: "https://example.com/mini-app"
    };

    const { loadConfig } = await import("../src/config");

    expect(() => loadConfig()).toThrow("TELEGRAM_WORKSPACE_CHAT_ID is required");
  });

  it("rejects positive TELEGRAM_WORKSPACE_CHAT_ID values", async () => {
    process.env = {
      ...baseEnv,
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_WORKSPACE_CHAT_ID: "42",
      TELEGRAM_MINI_APP_PUBLIC_URL: "https://example.com/mini-app"
    };

    const { loadConfig } = await import("../src/config");

    expect(() => loadConfig()).toThrow("TELEGRAM_WORKSPACE_CHAT_ID must be negative");
  });

  it("requires the Mini App public URL to use https", async () => {
    process.env = {
      ...baseEnv,
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_WORKSPACE_CHAT_ID: "-100123",
      TELEGRAM_MINI_APP_PUBLIC_URL: "http://example.com/mini-app"
    };

    const { loadConfig } = await import("../src/config");

    expect(() => loadConfig()).toThrow("TELEGRAM_MINI_APP_PUBLIC_URL must use https");
  });

  it("loads a Codex profile config from JSON", async () => {
    process.env = {
      ...baseEnv,
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_WORKSPACE_CHAT_ID: "-100123",
      TELEGRAM_MINI_APP_PUBLIC_URL: "https://example.com/mini-app",
    };

    const { loadConfig } = await import("../src/config");

    expect(loadConfig().codex.profiles).toEqual({
      general: { homePath: "/srv/kirbot/codex-home-general" },
      coding: { homePath: "/srv/kirbot/codex-home-coding" }
    });
    expect(loadConfig().codex.routing).toEqual({
      general: "general",
      thread: "coding",
      plan: "coding"
    });
  });

  it("expands homePath values in profile config", async () => {
    process.env = {
      ...baseEnv,
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_WORKSPACE_CHAT_ID: "-100123",
      TELEGRAM_MINI_APP_PUBLIC_URL: "https://example.com/mini-app",
      CODEX_PROFILES_JSON: JSON.stringify({
        profiles: {
          general: { homePath: "~/kirbot/codex-home-general" },
          coding: { homePath: "~/kirbot/codex-home-coding" }
        },
        routing: {
          general: "general",
          thread: "coding",
          plan: "coding"
        }
      })
    };

    const { loadConfig } = await import("../src/config");

    expect(loadConfig().codex.profiles).toEqual({
      general: { homePath: `${homedir()}/kirbot/codex-home-general` },
      coding: { homePath: `${homedir()}/kirbot/codex-home-coding` }
    });
  });

  it("rejects bare home roots for profile homePath values", async () => {
    process.env = {
      ...baseEnv,
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_WORKSPACE_CHAT_ID: "-100123",
      TELEGRAM_MINI_APP_PUBLIC_URL: "https://example.com/mini-app",
      CODEX_PROFILES_JSON: JSON.stringify({
        profiles: {
          general: { homePath: "~" },
          coding: { homePath: "/srv/kirbot/codex-home-coding" }
        },
        routing: {
          general: "general",
          thread: "coding",
          plan: "coding"
        }
      })
    };

    const { loadConfig } = await import("../src/config");

    expect(() => loadConfig()).toThrow("must not be the user home root");
  });

  it("rejects routing targets that reference an undeclared profile", async () => {
    process.env = {
      ...baseEnv,
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_WORKSPACE_CHAT_ID: "-100123",
      TELEGRAM_MINI_APP_PUBLIC_URL: "https://example.com/mini-app",
      CODEX_PROFILES_JSON: JSON.stringify({
        profiles: {
          general: { homePath: "/srv/kirbot/codex-home-general" }
        },
        routing: {
          general: "general",
          thread: "coding",
          plan: "general"
        }
      })
    };

    const { loadConfig } = await import("../src/config");

    expect(() => loadConfig()).toThrow("undeclared profile");
  });

  it("rejects a profile without a homePath", async () => {
    process.env = {
      ...baseEnv,
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_WORKSPACE_CHAT_ID: "-100123",
      TELEGRAM_MINI_APP_PUBLIC_URL: "https://example.com/mini-app",
      CODEX_PROFILES_JSON: JSON.stringify({
        profiles: {
          general: { homePath: "/srv/kirbot/codex-home-general" },
          coding: {}
        },
        routing: {
          general: "general",
          thread: "coding",
          plan: "coding"
        }
      })
    };

    const { loadConfig } = await import("../src/config");

    expect(() => loadConfig()).toThrow("homePath");
  });

  it("rejects missing required routing entries", async () => {
    process.env = {
      ...baseEnv,
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_WORKSPACE_CHAT_ID: "-100123",
      TELEGRAM_MINI_APP_PUBLIC_URL: "https://example.com/mini-app",
      CODEX_PROFILES_JSON: JSON.stringify({
        profiles: {
          general: { homePath: "/srv/kirbot/codex-home-general" },
          coding: { homePath: "/srv/kirbot/codex-home-coding" }
        },
        routing: {
          general: "general"
        }
      })
    };

    const { loadConfig } = await import("../src/config");

    expect(() => loadConfig()).toThrow();
  });
});
