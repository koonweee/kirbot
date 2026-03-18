import { afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { BridgeDatabase } from "../src/db";
import { MARKDOWN_AST_VERSION, parseMarkdownToMdast, serializeMarkdownAst } from "@kirbot/telegram-format";
import { startMiniAppServer, type MiniAppServer } from "../src/mini-app/server";

type StartedHarness = {
  database: BridgeDatabase;
  server: MiniAppServer;
  tempDir: string;
  port: number;
};

const started: StartedHarness[] = [];

afterEach(async () => {
  while (started.length > 0) {
    const current = started.pop();
    if (!current) {
      continue;
    }

    await current.server.stop();
    await current.database.close();
    rmSync(current.tempDir, { force: true, recursive: true });
  }
});

describe("Mini App server", () => {
  it("serves exact plan artifacts for authorized Telegram users", async () => {
    const harness = await startServer();
    const artifact = await insertPlanArtifact(harness.database, {
      codexTurnId: "turn-1",
      itemId: "plan-1",
      markdownText: "1. Draft the rollout"
    });

    const response = await fetch(
      `http://127.0.0.1:${harness.port}/mini-app/api/plan-artifact?artifactId=${artifact.artifactId}`,
      {
        headers: {
          "X-Telegram-Init-Data": buildTelegramInitData("token", 42)
        }
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      artifactId: artifact.artifactId,
      kind: "plan",
      topicId: 777,
      title: "Plan",
      markdownText: "1. Draft the rollout",
      mdast: parseMarkdownToMdast("1. Draft the rollout")
    });
  });

  it("rejects requests with invalid Telegram init data", async () => {
    const harness = await startServer();

    const response = await fetch(
      `http://127.0.0.1:${harness.port}/mini-app/api/plan-artifact?artifactId=artifact-1`,
      {
        headers: {
          "X-Telegram-Init-Data": "hash=bad"
        }
      }
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "invalid_init_data" });
  });

  it("returns not found when the requested plan artifact is missing", async () => {
    const harness = await startServer();

    const response = await fetch(
      `http://127.0.0.1:${harness.port}/mini-app/api/plan-artifact?artifactId=missing`,
      {
        headers: {
          "X-Telegram-Init-Data": buildTelegramInitData("token", 42)
        }
      }
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "unknown_plan_artifact" });
  });

  it("returns 404 for the removed preview route", async () => {
    const harness = await startServer();

    const response = await fetch(`http://127.0.0.1:${harness.port}/mini-app/preview/plan`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
  });

  it("answers CORS preflight requests for the configured app origin", async () => {
    const harness = await startServer();

    const response = await fetch(
      `http://127.0.0.1:${harness.port}/mini-app/api/plan-artifact?artifactId=artifact-1`,
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://example.com"
        }
      }
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://example.com");
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    expect(response.headers.get("access-control-allow-headers")).toBe("X-Telegram-Init-Data");
  });

  it("rejects CORS preflight requests from other origins", async () => {
    const harness = await startServer();

    const response = await fetch(
      `http://127.0.0.1:${harness.port}/mini-app/api/plan-artifact?artifactId=artifact-1`,
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://other.example.com"
        }
      }
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden_origin" });
  });

  it("rejects artifact fetches from other browser origins", async () => {
    const harness = await startServer();
    const artifact = await insertPlanArtifact(harness.database, {
      codexTurnId: "turn-1",
      itemId: "plan-1",
      markdownText: "1. Draft the rollout"
    });

    const response = await fetch(
      `http://127.0.0.1:${harness.port}/mini-app/api/plan-artifact?artifactId=${artifact.artifactId}`,
      {
        headers: {
          Origin: "https://other.example.com",
          "X-Telegram-Init-Data": buildTelegramInitData("token", 42)
        }
      }
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden_origin" });
  });

  it("does not start when the Mini App API public URL is not https", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kirbot-mini-app-test-"));
    const database = new BridgeDatabase(join(tempDir, "bridge.sqlite"));
    await database.migrate();

    try {
      const server = await startMiniAppServer({
        config: {
          botToken: "token",
          userId: 42,
          mediaTempDir: join(tempDir, "media"),
          miniApp: {
            publicUrl: "https://example.com/mini-app",
            apiPublicUrl: "http://api.example.com/mini-app",
            bindHost: "127.0.0.1",
            port: await findAvailablePort()
          }
        },
        database
      });

      expect(server).toBeNull();
    } finally {
      await database.close();
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});

async function startServer(): Promise<StartedHarness> {
  const tempDir = mkdtempSync(join(tmpdir(), "kirbot-mini-app-test-"));
  const database = new BridgeDatabase(join(tempDir, "bridge.sqlite"));
  await database.migrate();
  const port = await findAvailablePort();
  const server = await startMiniAppServer({
    config: {
      botToken: "token",
      userId: 42,
      mediaTempDir: join(tempDir, "media"),
      miniApp: {
        publicUrl: "https://example.com/mini-app",
        apiPublicUrl: "https://api.example.com/mini-app",
        bindHost: "127.0.0.1",
        port
      }
    },
    database
  });

  if (!server) {
    throw new Error("Expected Mini App server to start");
  }

  const startedHarness = {
    database,
    server,
    tempDir,
    port
  };
  started.push(startedHarness);
  return startedHarness;
}

async function insertPlanArtifact(
  database: BridgeDatabase,
  input: { codexTurnId: string; itemId: string; markdownText: string }
) {
  return database.upsertArtifact({
    kind: "plan",
    title: "Plan",
    telegramChatId: String(-1001),
    telegramTopicId: 777,
    codexThreadId: "thread-1",
    codexTurnId: input.codexTurnId,
    itemId: input.itemId,
    markdownText: input.markdownText,
    mdastJson: serializeMarkdownAst(parseMarkdownToMdast(input.markdownText)),
    astVersion: MARKDOWN_AST_VERSION
  });
}

function buildTelegramInitData(botToken: string, userId: number): string {
  const params = new URLSearchParams();
  params.set("auth_date", "1700000000");
  params.set("query_id", "AAEAAAE");
  params.set("user", JSON.stringify({ id: userId, first_name: "Kirby" }));
  const dataCheckString = Array.from(params.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  params.set("hash", hash);
  return params.toString();
}

async function findAvailablePort(): Promise<number> {
  const server = createServer();
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not determine free localhost port"));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}
