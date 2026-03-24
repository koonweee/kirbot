import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

afterEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv };
});

describe("loadConfig", () => {
  it("loads developer instructions from KIRBOT.md and derives the checked-in profile homes", async () => {
    process.env = {
      ...originalEnv,
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_WORKSPACE_CHAT_ID: "-100123",
      TELEGRAM_MINI_APP_PUBLIC_URL: "https://example.com/mini-app"
    };

    const { loadConfig } = await import("../src/config");
    const config = loadConfig();

    expect(config.telegram.workspaceChatId).toBe(-100123);
    expect(config.codex.baseInstructions).toBeUndefined();
    expect(config.codex.developerInstructions).toBe(readFileSync("apps/bot/KIRBOT.md", "utf8"));
    expect(config.codex.profilesConfigPath).toBe(resolve("config/codex-profiles.json"));
    expect(config.codex.profiles.general!.homePath).toBe(resolve("data/homes/general"));
    expect(config.codex.profiles.coding!.homePath).toBe(resolve("data/homes/coding"));
  });

  it("ignores a legacy base-instructions env var if present", async () => {
    process.env = {
      ...originalEnv,
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_WORKSPACE_CHAT_ID: "-100123",
      TELEGRAM_MINI_APP_PUBLIC_URL: "https://example.com/mini-app",
      CODEX_BASE_INSTRUCTIONS_FILE: "/tmp/legacy-ignored.md"
    };

    const { loadConfig } = await import("../src/config");
    const config = loadConfig();

    expect(config.telegram.workspaceChatId).toBe(-100123);
    expect(config.codex.baseInstructions).toBeUndefined();
    expect(config.codex.developerInstructions).toBe(readFileSync("apps/bot/KIRBOT.md", "utf8"));
  });
});
