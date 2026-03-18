import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { AppConfig } from "../config";
import { BridgeDatabase } from "../db";
import type { LoggerLike } from "../logging";
import { deriveMiniAppBasePath, deriveUrlOrigin, normalizeTelegramMiniAppPublicUrl } from "./url";

export type MiniAppArtifactPayload = {
  artifactId: string;
  kind: "plan";
  title: string;
  markdownText: string;
  mdast: unknown;
  topicId: number;
  generatedAt: string;
};

export type MiniAppServer = {
  stop(): Promise<void>;
};

export async function startMiniAppServer(input: {
  config: AppConfig["telegram"];
  database: BridgeDatabase;
  logger?: LoggerLike;
}): Promise<MiniAppServer | null> {
  const logger = input.logger ?? console;
  const apiPublicUrl = normalizeTelegramMiniAppPublicUrl(input.config.miniApp.apiPublicUrl);
  if (input.config.miniApp.apiPublicUrl && !apiPublicUrl) {
    logger.warn("Mini App server disabled because TELEGRAM_MINI_APP_API_PUBLIC_URL must use https.");
    return null;
  }

  if (!apiPublicUrl) {
    return null;
  }

  const basePath = deriveMiniAppBasePath(apiPublicUrl);
  const allowedOrigin = input.config.miniApp.publicUrl
    ? deriveUrlOrigin(input.config.miniApp.publicUrl)
    : null;
  const server = createServer((request, response) => {
    void handleRequest(request, response, {
      basePath,
      allowedOrigin,
      config: input.config,
      database: input.database,
      logger
    }).catch((error) => {
      logger.error("Mini App request failed", error);
      sendJson(response, 500, { error: "internal_error" });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.config.miniApp.port, input.config.miniApp.bindHost, () => {
      server.off("error", reject);
      resolve();
    });
  });
  logger.info(
    `Mini App server listening on ${input.config.miniApp.bindHost}:${input.config.miniApp.port} under ${basePath || "/"}`
  );

  return {
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      })
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  deps: {
    basePath: string;
    allowedOrigin: string | null;
    config: AppConfig["telegram"];
    database: BridgeDatabase;
    logger: LoggerLike;
  }
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;
  const apiPath = `${deps.basePath}/api/plan-artifact`;

  if (pathname !== apiPath) {
    sendJson(response, 404, { error: "not_found" });
    return;
  }

  if (request.method === "OPTIONS") {
    if (!applyCors(response, request.headers.origin, deps.allowedOrigin)) {
      sendJson(response, 403, { error: "forbidden_origin" });
      return;
    }

    response.statusCode = 204;
    response.end();
    return;
  }

  if (request.method !== "GET") {
    sendJson(response, 405, { error: "method_not_allowed" });
    return;
  }

  if (!applyCors(response, request.headers.origin, deps.allowedOrigin)) {
    sendJson(response, 403, { error: "forbidden_origin" });
    return;
  }

  const artifactId = url.searchParams.get("artifactId")?.trim() ?? "";
  if (!artifactId) {
    sendJson(response, 400, { error: "missing_artifact_id" });
    return;
  }

  const initData = request.headers["x-telegram-init-data"];
  if (typeof initData !== "string" || initData.trim().length === 0) {
    sendJson(response, 401, { error: "missing_init_data" });
    return;
  }

  const validatedUserId = validateTelegramInitData(initData, deps.config.botToken);
  if (validatedUserId === null) {
    sendJson(response, 401, { error: "invalid_init_data" });
    return;
  }

  if (validatedUserId !== deps.config.userId) {
    sendJson(response, 403, { error: "unauthorized_user" });
    return;
  }

  const artifact = await deps.database.getArtifactByArtifactIdOptional(artifactId);
  if (!artifact || artifact.kind !== "plan") {
    sendJson(response, 404, { error: "unknown_plan_artifact" });
    return;
  }

  try {
    sendJson(response, 200, {
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      title: artifact.title,
      markdownText: artifact.markdownText,
      mdast: JSON.parse(artifact.mdastJson),
      topicId: artifact.telegramTopicId,
      generatedAt: artifact.updatedAt
    } satisfies MiniAppArtifactPayload);
  } catch (error) {
    deps.logger.error("Failed to load Mini App plan artifact", error);
    sendJson(response, 502, { error: "artifact_lookup_failed" });
  }
}

function sendText(response: ServerResponse, status: number, body: string, contentType: string): void {
  response.statusCode = status;
  response.setHeader("content-type", contentType);
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  sendText(response, status, JSON.stringify(body), "application/json; charset=utf-8");
}

function applyCors(response: ServerResponse, requestOrigin: string | undefined, allowedOrigin: string | null): boolean {
  if (!requestOrigin) {
    return true;
  }

  if (!allowedOrigin || requestOrigin !== allowedOrigin) {
    return false;
  }

  response.setHeader("access-control-allow-origin", requestOrigin);
  response.setHeader("access-control-allow-methods", "GET, OPTIONS");
  response.setHeader("access-control-allow-headers", "X-Telegram-Init-Data");
  response.setHeader("vary", "Origin");
  return true;
}

function validateTelegramInitData(initData: string, botToken: string): number | null {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const userRaw = params.get("user");
  if (!hash || !userRaw) {
    return null;
  }

  params.delete("hash");
  const dataCheckString = Array.from(params.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const calculatedHash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  const received = Buffer.from(hash, "hex");
  const calculated = Buffer.from(calculatedHash, "hex");
  if (received.length !== calculated.length || !timingSafeEqual(received, calculated)) {
    return null;
  }

  const parsedUser = JSON.parse(userRaw) as { id?: unknown };
  return typeof parsedUser.id === "number" ? parsedUser.id : null;
}
