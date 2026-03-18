import { config as loadDotenv } from "dotenv";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";

import type { AskForApproval } from "@kirbot/codex-client/generated/codex/v2/AskForApproval";
import type { SandboxMode } from "@kirbot/codex-client/generated/codex/v2/SandboxMode";
import type { JsonValue } from "@kirbot/codex-client/generated/codex/serde_json/JsonValue";
import type { CodexConfig } from "@kirbot/codex-client/config";

loadKirbotDotenv();

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
  TELEGRAM_MINI_APP_PUBLIC_URL: z
    .string()
    .url()
    .refine((value) => new URL(value).protocol === "https:", {
      message: "TELEGRAM_MINI_APP_PUBLIC_URL must use https"
    }),
  DATABASE_PATH: z.string().default("data/telegram-codex-bridge.sqlite"),
  CODEX_DEFAULT_CWD: z.string().default("~/kirbot"),
  CODEX_MODEL: optionalEnvString(z.string()),
  CODEX_MODEL_PROVIDER: optionalEnvString(z.string()),
  CODEX_SANDBOX_MODE: optionalEnvString(
    z.enum(["read-only", "workspace-write", "danger-full-access"])
  ),
  CODEX_APPROVAL_POLICY: optionalEnvString(
    z.enum(["untrusted", "on-request", "on-failure", "never"])
  ),
  CODEX_SERVICE_NAME: z.string().default("telegram-codex-bridge"),
  CODEX_CONFIG_JSON: optionalEnvString(z.string())
});

export type AppConfig = {
  telegram: {
    botToken: string;
    userId: number;
    mediaTempDir: string;
    miniApp: {
      publicUrl: string;
    };
  };
  database: {
    path: string;
  };
  codex: CodexConfig;
};

export function loadConfig(): AppConfig {
  const parsed = envSchema.parse(process.env);

  return {
    telegram: {
      botToken: parsed.TELEGRAM_BOT_TOKEN,
      userId: parsed.TELEGRAM_USER_ID,
      mediaTempDir: parsed.TELEGRAM_MEDIA_TMP_DIR
        ? expandHomePath(parsed.TELEGRAM_MEDIA_TMP_DIR)
        : defaultTelegramMediaTempDir(),
      miniApp: {
        publicUrl: parsed.TELEGRAM_MINI_APP_PUBLIC_URL
      }
    },
    database: {
      path: parsed.DATABASE_PATH
    },
    codex: {
      defaultCwd: expandHomePath(parsed.CODEX_DEFAULT_CWD),
      model: parsed.CODEX_MODEL,
      modelProvider: parsed.CODEX_MODEL_PROVIDER,
      sandbox: parsed.CODEX_SANDBOX_MODE as SandboxMode | undefined,
      approvalPolicy: parsed.CODEX_APPROVAL_POLICY as AskForApproval | undefined,
      serviceName: parsed.CODEX_SERVICE_NAME,
      baseInstructions: undefined,
      developerInstructions: readRequiredTextFile(resolveKirbotPromptPath()),
      config: parseJsonConfig(parsed.CODEX_CONFIG_JSON)
    }
  };
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
