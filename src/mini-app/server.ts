import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";

import type { AppConfig } from "../config";
import { BridgeDatabase } from "../db";
import type { LoggerLike } from "../logging";
import { deriveMiniAppBasePath, normalizeTelegramMiniAppPublicUrl } from "./url";

export type PlanArtifactSnapshot = {
  turnId: string;
  itemId: string;
  text: string;
};

type MiniAppCodexApi = {
  readPlanArtifact(threadId: string, turnId: string, itemId: string): Promise<PlanArtifactSnapshot | null>;
};

export type MiniAppServer = {
  stop(): Promise<void>;
};

export async function startMiniAppServer(input: {
  config: AppConfig["telegram"];
  database: BridgeDatabase;
  codex: MiniAppCodexApi;
  logger?: LoggerLike;
}): Promise<MiniAppServer | null> {
  const logger = input.logger ?? console;
  const publicUrl = normalizeTelegramMiniAppPublicUrl(input.config.miniApp.publicUrl);
  if (input.config.miniApp.publicUrl && !publicUrl) {
    logger.warn("Mini App server disabled because TELEGRAM_MINI_APP_PUBLIC_URL must use https.");
    return null;
  }

  if (!publicUrl) {
    return null;
  }

  const basePath = deriveMiniAppBasePath(publicUrl);
  const server = createServer((request, response) => {
    void handleRequest(request, response, {
      basePath,
      config: input.config,
      database: input.database,
      codex: input.codex,
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
    config: AppConfig["telegram"];
    database: BridgeDatabase;
    codex: MiniAppCodexApi;
    logger: LoggerLike;
  }
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;
  const planPath = `${deps.basePath}/plan`;
  const previewPlanPath = `${deps.basePath}/preview/plan`;
  const appJsPath = `${deps.basePath}/app.js`;
  const previewAppJsPath = `${deps.basePath}/preview/app.js`;
  const stylesPath = `${deps.basePath}/styles.css`;
  const previewStylesPath = `${deps.basePath}/preview/styles.css`;
  const apiPath = `${deps.basePath}/api/plan-artifact`;

  if (request.method === "GET" && (pathname === planPath || pathname === previewPlanPath)) {
    sendText(response, 200, readStaticAsset("plan.html"), "text/html; charset=utf-8");
    return;
  }

  if (request.method === "GET" && (pathname === appJsPath || pathname === previewAppJsPath)) {
    sendText(response, 200, readStaticAsset("app.js"), "application/javascript; charset=utf-8");
    return;
  }

  if (request.method === "GET" && (pathname === stylesPath || pathname === previewStylesPath)) {
    sendText(response, 200, readStaticAsset("styles.css"), "text/css; charset=utf-8");
    return;
  }

  if (request.method === "GET" && pathname === apiPath) {
    const turnId = url.searchParams.get("turnId")?.trim() ?? "";
    const itemId = url.searchParams.get("itemId")?.trim() ?? "";
    if (!turnId || !itemId) {
      sendJson(response, 400, { error: "missing_turn_or_item" });
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

    const turn = await deps.database.getTurnByIdOptional(turnId);
    if (!turn) {
      sendJson(response, 404, { error: "unknown_turn" });
      return;
    }

    try {
      const artifact = await deps.codex.readPlanArtifact(turn.codexThreadId, turnId, itemId);
      if (!artifact) {
        sendJson(response, 404, { error: "unknown_plan_artifact" });
        return;
      }

      sendJson(response, 200, {
        turnId,
        itemId,
        topicId: turn.telegramTopicId,
        title: "Plan",
        text: artifact.text,
        generatedAt: new Date().toISOString()
      });
      return;
    } catch (error) {
      deps.logger.error("Failed to load Mini App plan artifact", error);
      sendJson(response, 502, { error: "artifact_lookup_failed" });
      return;
    }
  }

  sendJson(response, 404, { error: "not_found" });
}

function readStaticAsset(filename: string): string {
  return readFileSync(join(__dirname, "static", filename), "utf8");
}

function sendText(response: ServerResponse, status: number, body: string, contentType: string): void {
  response.statusCode = status;
  response.setHeader("content-type", contentType);
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  sendText(response, status, JSON.stringify(body), "application/json; charset=utf-8");
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
