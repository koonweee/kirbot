import { config as loadDotenv } from "dotenv";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
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
  TELEGRAM_USER_ID: z.coerce.number().int(),
  TELEGRAM_MEDIA_TMP_DIR: z.string().optional(),
  DATABASE_PATH: z.string().default("data/telegram-codex-bridge.sqlite"),
  CODEX_DEFAULT_CWD: z.string().default("~/kirbot"),
  CODEX_APP_SERVER_URL: z.string().url().default("ws://127.0.0.1:8787"),
  CODEX_MODEL: optionalEnvString(z.string()),
  CODEX_MODEL_PROVIDER: optionalEnvString(z.string()),
  CODEX_SANDBOX_MODE: optionalEnvString(
    z.enum(["read-only", "workspace-write", "danger-full-access"])
  ),
  CODEX_APPROVAL_POLICY: optionalEnvString(
    z.enum(["untrusted", "on-request", "on-failure", "never"])
  ),
  CODEX_SERVICE_NAME: z.string().default("telegram-codex-bridge"),
  // CODEX_BASE_INSTRUCTIONS_FILE: optionalEnvString(z.string()),
  CODEX_CONFIG_JSON: optionalEnvString(z.string())
});

const parsed = envSchema.parse(process.env);

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
    userId: number;
    mediaTempDir: string;
  };
  database: {
    path: string;
  };
  codex: {
    appServerUrl: string;
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
  return {
    telegram: {
      botToken: parsed.TELEGRAM_BOT_TOKEN,
      userId: parsed.TELEGRAM_USER_ID,
      mediaTempDir: parsed.TELEGRAM_MEDIA_TMP_DIR
        ? expandHomePath(parsed.TELEGRAM_MEDIA_TMP_DIR)
        : defaultTelegramMediaTempDir()
    },
    database: {
      path: parsed.DATABASE_PATH
    },
    codex: {
      appServerUrl: parsed.CODEX_APP_SERVER_URL,
      defaultCwd: expandHomePath(parsed.CODEX_DEFAULT_CWD),
      model: parsed.CODEX_MODEL,
      modelProvider: parsed.CODEX_MODEL_PROVIDER,
      sandbox: parsed.CODEX_SANDBOX_MODE as SandboxMode | undefined,
      approvalPolicy: parsed.CODEX_APPROVAL_POLICY as AskForApproval | undefined,
      serviceName: parsed.CODEX_SERVICE_NAME,
      // Avoid using baseInstructions for Kirbot because it appears to replace
      // Codex's default system prompt/identity framing instead of safely appending.
      // baseInstructions: readOptionalTextFile(parsed.CODEX_BASE_INSTRUCTIONS_FILE),
      baseInstructions: undefined,
      developerInstructions: readRequiredTextFile(resolveKirbotPromptPath()),
      config: parseJsonConfig(parsed.CODEX_CONFIG_JSON)
    }
  };
}

function readRequiredTextFile(path: string): string {
  return readFileSync(path, "utf8");
}

function resolveKirbotPromptPath(): string {
  const candidates = [
    resolve(__dirname, "..", "KIRBOT.md"),
    resolve(__dirname, "..", "..", "KIRBOT.md"),
    resolve(process.cwd(), "KIRBOT.md")
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      return path;
    }
  }

  throw new Error("Could not locate KIRBOT.md");
}

function defaultTelegramMediaTempDir(): string {
  const shmDir = "/dev/shm";
  if (existsSync(shmDir) && statSync(shmDir).isDirectory()) {
    return `${shmDir}/telegram-codex-bridge-images`;
  }

  return "/tmp/telegram-codex-bridge-images";
}
