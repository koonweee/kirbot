import { config as loadDotenv } from "dotenv";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { z } from "zod";

import type { AskForApproval } from "./generated/codex/v2/AskForApproval";
import type { SandboxMode } from "./generated/codex/v2/SandboxMode";
import type { JsonValue } from "./generated/codex/serde_json/JsonValue";

loadDotenv();

const optionalEnvString = <TSchema extends z.ZodTypeAny>(schema: TSchema) =>
  z.preprocess((value) => {
    if (typeof value === "string" && value.trim() === "") {
      return undefined;
    }

    return value;
  }, schema.optional());

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.string().min(1),
  TELEGRAM_ALLOWED_USER_IDS: z.string().min(1),
  TELEGRAM_MEDIA_TMP_DIR: z.string().optional(),
  DATABASE_PATH: z.string().default("data/telegram-codex-bridge.sqlite"),
  CODEX_DEFAULT_CWD: z.string().default("~/kirbot"),
  CODEX_APP_SERVER_URL: z.string().url().default("ws://127.0.0.1:8787"),
  CODEX_SPAWN_APP_SERVER: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  CODEX_MODEL: optionalEnvString(z.string()),
  CODEX_MODEL_PROVIDER: optionalEnvString(z.string()),
  CODEX_SANDBOX_MODE: optionalEnvString(
    z.enum(["read-only", "workspace-write", "danger-full-access"])
  ),
  CODEX_APPROVAL_POLICY: optionalEnvString(
    z.enum(["untrusted", "on-request", "on-failure", "never"])
  ),
  CODEX_SERVICE_NAME: z.string().default("telegram-codex-bridge"),
  CODEX_BASE_INSTRUCTIONS_FILE: optionalEnvString(z.string()),
  CODEX_DEVELOPER_INSTRUCTIONS_FILE: optionalEnvString(z.string()),
  CODEX_CONFIG_JSON: optionalEnvString(z.string())
});

const parsed = envSchema.parse(process.env);

function parseIntegerList(value: string): number[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => Number.parseInt(entry, 10));
}

function expandHomePath(value: string): string {
  if (value === "~") {
    return homedir();
  }

  if (value.startsWith("~/")) {
    return `${homedir()}${value.slice(1)}`;
  }

  return value;
}

function parseJsonConfig(
  value: string | undefined
): Record<string, JsonValue | undefined> | undefined {
  if (!value) {
    return undefined;
  }

  return z.record(z.string(), z.unknown()).parse(JSON.parse(value)) as Record<
    string,
    JsonValue | undefined
  >;
}

export type AppConfig = {
  telegram: {
    botToken: string;
    chatId: number;
    allowedUserIds: Set<number>;
    mediaTempDir: string;
  };
  database: {
    path: string;
  };
  codex: {
    appServerUrl: string;
    spawnAppServer: boolean;
    defaultCwd: string;
    model: string | undefined;
    modelProvider: string | undefined;
    sandbox: SandboxMode | undefined;
    approvalPolicy: AskForApproval | undefined;
    serviceName: string;
    baseInstructions: string | undefined;
    developerInstructions: string | undefined;
    config: Record<string, JsonValue | undefined> | undefined;
  };
};

export function loadConfig(): AppConfig {
  const allowedUserIds = new Set(parseIntegerList(parsed.TELEGRAM_ALLOWED_USER_IDS));

  return {
    telegram: {
      botToken: parsed.TELEGRAM_BOT_TOKEN,
      chatId: Number.parseInt(parsed.TELEGRAM_CHAT_ID, 10),
      allowedUserIds,
      mediaTempDir: parsed.TELEGRAM_MEDIA_TMP_DIR
        ? expandHomePath(parsed.TELEGRAM_MEDIA_TMP_DIR)
        : defaultTelegramMediaTempDir()
    },
    database: {
      path: parsed.DATABASE_PATH
    },
    codex: {
      appServerUrl: parsed.CODEX_APP_SERVER_URL,
      spawnAppServer: parsed.CODEX_SPAWN_APP_SERVER,
      defaultCwd: expandHomePath(parsed.CODEX_DEFAULT_CWD),
      model: parsed.CODEX_MODEL,
      modelProvider: parsed.CODEX_MODEL_PROVIDER,
      sandbox: parsed.CODEX_SANDBOX_MODE as SandboxMode | undefined,
      approvalPolicy: parsed.CODEX_APPROVAL_POLICY as AskForApproval | undefined,
      serviceName: parsed.CODEX_SERVICE_NAME,
      baseInstructions: readOptionalTextFile(parsed.CODEX_BASE_INSTRUCTIONS_FILE),
      developerInstructions: readOptionalTextFile(parsed.CODEX_DEVELOPER_INSTRUCTIONS_FILE),
      config: parseJsonConfig(parsed.CODEX_CONFIG_JSON)
    }
  };
}

function readOptionalTextFile(path: string | undefined): string | undefined {
  if (!path) {
    return undefined;
  }

  const content = readFileSync(expandHomePath(path), "utf8");
  return content.trim().length > 0 ? content : undefined;
}

function defaultTelegramMediaTempDir(): string {
  const shmDir = "/dev/shm";
  if (existsSync(shmDir) && statSync(shmDir).isDirectory()) {
    return `${shmDir}/telegram-codex-bridge-images`;
  }

  return "/tmp/telegram-codex-bridge-images";
}
