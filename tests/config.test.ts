import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

afterEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv };
});

describe("loadConfig", () => {
  it("loads base and developer instructions from UTF-8 text files", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kirbot-config-"));
    try {
      const basePath = join(tempDir, "base.md");
      const developerPath = join(tempDir, "developer.md");
      writeFileSync(basePath, "# Base\n\nUse Markdown.");
      writeFileSync(developerPath, "Be strict.\n");

      process.env = {
        ...originalEnv,
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_CHAT_ID: "-1001234567890",
        TELEGRAM_ALLOWED_USER_IDS: "123",
        CODEX_BASE_INSTRUCTIONS_FILE: basePath,
        CODEX_DEVELOPER_INSTRUCTIONS_FILE: developerPath
      };

      const { loadConfig } = await import("../src/config");
      const config = loadConfig();

      expect(config.codex.baseInstructions).toBe("# Base\n\nUse Markdown.");
      expect(config.codex.developerInstructions).toBe("Be strict.\n");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("treats blank instruction files as undefined", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kirbot-config-"));
    try {
      const basePath = join(tempDir, "base.md");
      const developerPath = join(tempDir, "developer.md");
      writeFileSync(basePath, "\n \n");
      writeFileSync(developerPath, "");

      process.env = {
        ...originalEnv,
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_CHAT_ID: "-1001234567890",
        TELEGRAM_ALLOWED_USER_IDS: "123",
        CODEX_BASE_INSTRUCTIONS_FILE: basePath,
        CODEX_DEVELOPER_INSTRUCTIONS_FILE: developerPath
      };

      const { loadConfig } = await import("../src/config");
      const config = loadConfig();

      expect(config.codex.baseInstructions).toBeUndefined();
      expect(config.codex.developerInstructions).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
