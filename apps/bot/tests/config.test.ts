import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

afterEach(() => {
  vi.restoreAllMocks();
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
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { loadConfig } = await import("../src/config");
    const config = loadConfig();

    expect(config.telegram.workspaceChatId).toBe(-100123);
    expect(config.codex.developerInstructions).toBe(readFileSync("apps/bot/KIRBOT.md", "utf8"));
    expect(config.codex.profilesConfigPath).toBe(resolve("config/codex-profiles.json"));
    expect(config.codex.profiles.general!.homePath).toBe(resolve("data/homes/general"));
    expect(config.codex.profiles.general!.defaultCwd).toBe("/home/dev/general");
    expect(config.codex.profiles.general!.reasoningEffort).toBe("xhigh");
    expect(config.codex.profiles.general!.serviceTier).toBe("fast");
    expect(config.codex.profiles.general!.skills).toContain("kirbot-skill-install");
    expect(config.codex.profiles.general!.skills).not.toContain("superpowers");
    expect(config.codex.profiles.coding!.homePath).toBe(resolve("data/homes/coding"));
    expect(config.codex.profiles.coding!.defaultCwd).toBe("/home/dev/coding");
    expect(config.codex.profiles.coding!.reasoningEffort).toBe("high");
    expect(config.codex.profiles.coding!.serviceTier).toBe("fast");
    expect(config.codex.profiles.coding!.skills).toContain("kirbot-skill-install");
    expect(config.codex.profiles.coding!.skills).toContain("superpowers");
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
