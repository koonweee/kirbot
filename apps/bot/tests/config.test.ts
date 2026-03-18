import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

afterEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv };
});

describe("loadConfig", () => {
  it("always loads developer instructions from KIRBOT.md and leaves base instructions unset", async () => {
    process.env = {
      ...originalEnv,
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_USER_ID: "123"
    };

    const { loadConfig } = await import("../src/config");
    const config = loadConfig();

    expect(config.telegram.userId).toBe(123);
    expect(config.codex.baseInstructions).toBeUndefined();
    expect(config.codex.developerInstructions).toBe(readFileSync("apps/bot/KIRBOT.md", "utf8"));
  });

  it("ignores a legacy base-instructions env var if present", async () => {
    process.env = {
      ...originalEnv,
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_USER_ID: "123",
      CODEX_BASE_INSTRUCTIONS_FILE: "/tmp/legacy-ignored.md"
    };

    const { loadConfig } = await import("../src/config");
    const config = loadConfig();

    expect(config.telegram.userId).toBe(123);
    expect(config.codex.baseInstructions).toBeUndefined();
    expect(config.codex.developerInstructions).toBe(readFileSync("apps/bot/KIRBOT.md", "utf8"));
  });
});
