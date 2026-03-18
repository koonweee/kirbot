import { afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { BridgeDatabase } from "../src/db";
import { startMiniAppServer, type MiniAppServer, type PlanArtifactSnapshot } from "../src/mini-app/server";

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
    const artifactRequests: Array<{ threadId: string; turnId: string; itemId: string }> = [];
    const harness = await startServer({
      readPlanArtifact: async (threadId, turnId, itemId) => {
        artifactRequests.push({ threadId, turnId, itemId });
        return {
          turnId,
          itemId,
          text: "1. Draft the rollout"
        };
      }
    });

    await harness.database.recordTurnStart({
      telegramUpdateId: 1,
      telegramChatId: String(-1001),
      telegramTopicId: 777,
      codexThreadId: "thread-1",
      codexTurnId: "turn-1",
      draftId: 1
    });

    const response = await fetch(
      `http://127.0.0.1:${harness.port}/mini-app/api/plan-artifact?turnId=turn-1&itemId=plan-1`,
      {
        headers: {
          "X-Telegram-Init-Data": buildTelegramInitData("token", 42)
        }
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      turnId: "turn-1",
      itemId: "plan-1",
      topicId: 777,
      title: "Plan",
      text: "1. Draft the rollout"
    });
    expect(artifactRequests).toEqual([{ threadId: "thread-1", turnId: "turn-1", itemId: "plan-1" }]);
  });

  it("rejects requests with invalid Telegram init data", async () => {
    const harness = await startServer({
      readPlanArtifact: async () => ({
        turnId: "turn-1",
        itemId: "plan-1",
        text: "unreachable"
      })
    });

    const response = await fetch(
      `http://127.0.0.1:${harness.port}/mini-app/api/plan-artifact?turnId=turn-1&itemId=plan-1`,
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
    const harness = await startServer({
      readPlanArtifact: async () => null
    });

    await harness.database.recordTurnStart({
      telegramUpdateId: 1,
      telegramChatId: String(-1001),
      telegramTopicId: 777,
      codexThreadId: "thread-1",
      codexTurnId: "turn-1",
      draftId: 1
    });

    const response = await fetch(
      `http://127.0.0.1:${harness.port}/mini-app/api/plan-artifact?turnId=turn-1&itemId=missing`,
      {
        headers: {
          "X-Telegram-Init-Data": buildTelegramInitData("token", 42)
        }
      }
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "unknown_plan_artifact" });
  });

  it("serves a static preview page without Telegram auth", async () => {
    const harness = await startServer({
      readPlanArtifact: async () => null
    });

    const response = await fetch(`http://127.0.0.1:${harness.port}/mini-app/preview/plan`);

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Kirbot Plan");
  });

  it("does not start when the Mini App public URL is not https", async () => {
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
            publicUrl: "http://example.com/mini-app",
            bindHost: "127.0.0.1",
            port: await findAvailablePort()
          }
        },
        database,
        codex: {
          readPlanArtifact: async () => null
        }
      });

      expect(server).toBeNull();
    } finally {
      await database.close();
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});

async function startServer(input: {
  readPlanArtifact(threadId: string, turnId: string, itemId: string): Promise<PlanArtifactSnapshot | null>;
}): Promise<StartedHarness> {
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
        bindHost: "127.0.0.1",
        port
      }
    },
    database,
    codex: {
      readPlanArtifact: input.readPlanArtifact
    }
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
