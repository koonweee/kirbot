import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("dotenv", () => ({
  config: vi.fn()
}));

const originalEnv = { ...process.env };

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
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_WORKSPACE_CHAT_ID: "-100123",
      TELEGRAM_MINI_APP_PUBLIC_URL: ""
    };

    const { loadConfig } = await import("../src/config");

    expect(() => loadConfig()).toThrow("Invalid URL");
  });

  it("requires TELEGRAM_WORKSPACE_CHAT_ID when loading config", async () => {
    process.env = {
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_MINI_APP_PUBLIC_URL: "https://example.com/mini-app"
    };

    const { loadConfig } = await import("../src/config");

    expect(() => loadConfig()).toThrow("TELEGRAM_WORKSPACE_CHAT_ID is required");
  });

  it("does not accept TELEGRAM_USER_ID as a workspace chat id", async () => {
    process.env = {
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_USER_ID: "42",
      TELEGRAM_MINI_APP_PUBLIC_URL: "https://example.com/mini-app"
    };

    const { loadConfig } = await import("../src/config");

    expect(() => loadConfig()).toThrow("TELEGRAM_WORKSPACE_CHAT_ID is required");
  });

  it("rejects positive TELEGRAM_WORKSPACE_CHAT_ID values", async () => {
    process.env = {
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_WORKSPACE_CHAT_ID: "42",
      TELEGRAM_MINI_APP_PUBLIC_URL: "https://example.com/mini-app"
    };

    const { loadConfig } = await import("../src/config");

    expect(() => loadConfig()).toThrow("TELEGRAM_WORKSPACE_CHAT_ID must be negative");
  });

  it("requires the Mini App public URL to use https", async () => {
    process.env = {
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_WORKSPACE_CHAT_ID: "-100123",
      TELEGRAM_MINI_APP_PUBLIC_URL: "http://example.com/mini-app"
    };

    const { loadConfig } = await import("../src/config");

    expect(() => loadConfig()).toThrow("TELEGRAM_MINI_APP_PUBLIC_URL must use https");
  });

  it("derives an isolated Codex home from the database path by default", async () => {
    process.env = {
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_WORKSPACE_CHAT_ID: "-100123",
      TELEGRAM_MINI_APP_PUBLIC_URL: "https://example.com/mini-app",
      DATABASE_PATH: "/srv/kirbot/data/bridge.sqlite"
    };

    const { loadConfig } = await import("../src/config");

    expect(loadConfig().codex.homePath).toBe("/srv/kirbot/data/codex-home");
  });

  it("respects an explicit Codex home override", async () => {
    process.env = {
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_WORKSPACE_CHAT_ID: "-100123",
      TELEGRAM_MINI_APP_PUBLIC_URL: "https://example.com/mini-app",
      DATABASE_PATH: "/srv/kirbot/data/bridge.sqlite",
      CODEX_HOME_PATH: "/srv/kirbot/custom-codex-home"
    };

    const { loadConfig } = await import("../src/config");

    expect(loadConfig().codex.homePath).toBe("/srv/kirbot/custom-codex-home");
  });
});
