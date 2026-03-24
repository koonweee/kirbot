import { config as loadDotenv } from "dotenv";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

import type { CodexProfilesConfig } from "./codex-profiles";
import { expandHomePath, parseCodexProfilesConfig } from "./codex-profiles";
import type { DatabaseProfileRouting } from "./db";
import { resolveCodexProfilesConfigPath } from "./repo-paths";

loadKirbotDotenv();

const workspaceChatIdEnv = z.preprocess(
  (value) => value,
  z.any().transform((value, ctx) => {
    if (value === undefined || value === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "TELEGRAM_WORKSPACE_CHAT_ID is required"
      });
      return z.NEVER;
    }

    if (typeof value === "string" && value.trim() === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "TELEGRAM_WORKSPACE_CHAT_ID is required"
      });
      return z.NEVER;
    }

    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "TELEGRAM_WORKSPACE_CHAT_ID is required"
      });
      return z.NEVER;
    }

    if (parsed >= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "TELEGRAM_WORKSPACE_CHAT_ID must be negative"
      });
      return z.NEVER;
    }

    return parsed;
  })
);

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_WORKSPACE_CHAT_ID: workspaceChatIdEnv,
  TELEGRAM_MEDIA_TMP_DIR: z.string().optional(),
  TELEGRAM_MINI_APP_PUBLIC_URL: z
    .string()
    .url()
    .refine((value) => new URL(value).protocol === "https:", {
      message: "TELEGRAM_MINI_APP_PUBLIC_URL must use https"
    }),
  DATABASE_PATH: z.string().default("data/telegram-codex-bridge.sqlite"),
  CODEX_DEFAULT_CWD: z.string().default("~/kirbot"),
  CODEX_SERVICE_NAME: z.string().default("telegram-codex-bridge"),
});

export type AppConfig = {
  telegram: {
    botToken: string;
    workspaceChatId: number;
    mediaTempDir: string;
    miniApp: {
      publicUrl: string;
    };
  };
  database: {
    path: string;
  };
  codex: {
    defaultCwd: string;
    profilesConfigPath: string;
    profiles: CodexProfilesConfig["profiles"];
    routing: DatabaseProfileRouting;
    mcps: CodexProfilesConfig["mcps"];
    model: undefined;
    modelProvider: undefined;
    sandbox: undefined;
    approvalPolicy: undefined;
    serviceName: string;
    developerInstructions: string;
    config: undefined;
  };
};

export function loadConfig(): AppConfig {
  const parsed = envSchema.parse(process.env);
  const databasePath = expandHomePath(parsed.DATABASE_PATH);
  const codexProfilesConfigPath = resolveCodexProfilesConfigPath();
  const codexProfiles = parseCodexProfilesConfig(readFileSync(codexProfilesConfigPath, "utf8"), {
    configPath: codexProfilesConfigPath,
    databasePath
  });

  return {
    telegram: {
      botToken: parsed.TELEGRAM_BOT_TOKEN,
      workspaceChatId: parsed.TELEGRAM_WORKSPACE_CHAT_ID,
      mediaTempDir: parsed.TELEGRAM_MEDIA_TMP_DIR
        ? expandHomePath(parsed.TELEGRAM_MEDIA_TMP_DIR)
        : defaultTelegramMediaTempDir(),
      miniApp: {
        publicUrl: parsed.TELEGRAM_MINI_APP_PUBLIC_URL
      }
    },
    database: {
      path: databasePath
    },
    codex: {
      defaultCwd: expandHomePath(parsed.CODEX_DEFAULT_CWD),
      profilesConfigPath: codexProfilesConfigPath,
      profiles: codexProfiles.profiles,
      routing: codexProfiles.routes as DatabaseProfileRouting,
      mcps: codexProfiles.mcps,
      model: undefined,
      modelProvider: undefined,
      sandbox: undefined,
      approvalPolicy: undefined,
      serviceName: parsed.CODEX_SERVICE_NAME,
      developerInstructions: readRequiredTextFile(resolveKirbotPromptPath()),
      config: undefined
    }
  };
}

function readRequiredTextFile(path: string): string {
  return readFileSync(path, "utf8");
}

function loadKirbotDotenv(): void {
  const seen = new Set<string>();
  for (const path of resolveDotenvCandidates()) {
    if (!existsSync(path) || seen.has(path)) {
      continue;
    }

    seen.add(path);
    loadDotenv({ path });
  }
}

function resolveDotenvCandidates(): string[] {
  return [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "..", ".env"),
    resolve(process.cwd(), "..", "..", ".env"),
    resolve(__dirname, "..", "..", "..", ".env"),
    resolve(__dirname, "..", "..", "..", "..", ".env")
  ];
}

function resolveKirbotPromptPath(): string {
  const candidates = [
    resolve(process.cwd(), "apps/bot/KIRBOT.md"),
    resolve(process.cwd(), "KIRBOT.md"),
    resolve(__dirname, "..", "..", "..", "apps", "bot", "KIRBOT.md"),
    resolve(__dirname, "..", "..", "..", "..", "apps", "bot", "KIRBOT.md")
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      return path;
    }
  }

  throw new Error("Could not locate apps/bot/KIRBOT.md");
}

function defaultTelegramMediaTempDir(): string {
  const shmDir = "/dev/shm";
  if (existsSync(shmDir) && statSync(shmDir).isDirectory()) {
    return `${shmDir}/telegram-codex-bridge-images`;
  }

  return "/tmp/telegram-codex-bridge-images";
}
