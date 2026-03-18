import { afterEach, describe, expect, it, vi } from "vitest";

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
      TELEGRAM_USER_ID: "42",
      TELEGRAM_MINI_APP_PUBLIC_URL: ""
    };

    const { loadConfig } = await import("../src/config");

    expect(() => loadConfig()).toThrow("Invalid URL");
  });

  it("requires the Mini App public URL to use https", async () => {
    process.env = {
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_USER_ID: "42",
      TELEGRAM_MINI_APP_PUBLIC_URL: "http://example.com/mini-app"
    };

    const { loadConfig } = await import("../src/config");

    expect(() => loadConfig()).toThrow("TELEGRAM_MINI_APP_PUBLIC_URL must use https");
  });
});
