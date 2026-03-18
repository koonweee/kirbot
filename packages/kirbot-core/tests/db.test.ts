import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BridgeDatabase } from "../src/db";

describe("BridgeDatabase", () => {
  let database: BridgeDatabase;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "telegram-codex-bridge-db-"));
    database = new BridgeDatabase(join(tempDir, "bridge.sqlite"));
    await database.migrate();
  });

  afterEach(async () => {
    await database.close();
    rmSync(tempDir, { force: true, recursive: true });
  });

  it("creates, activates, and archives topic sessions", async () => {
    const pending = await database.createProvisioningSession({
      telegramChatId: "-1001",
      telegramTopicId: 22
    });

    expect(pending.status).toBe("provisioning");
    expect(pending.preferredMode).toBe("default");

    const active = await database.activateSession(pending.id, "thread-1");
    expect(active.status).toBe("active");
    expect(active.codexThreadId).toBe("thread-1");
    expect(active.preferredMode).toBe("default");

    const updatedMode = await database.updateSessionPreferredMode(-1001, 22, "plan");
    expect(updatedMode?.preferredMode).toBe("plan");

    const lookup = await database.getSessionByCodexThreadId("thread-1");
    expect(lookup?.telegramTopicId).toBe(22);
    expect(lookup?.preferredMode).toBe("plan");

    const archived = await database.archiveSessionByTopic(-1001, 22);
    expect(archived?.status).toBe("archived");
  });

  it("stores and resolves pending server requests", async () => {
    const pending = await database.createPendingRequest({
      requestIdJson: JSON.stringify(77),
      method: "item/commandExecution/requestApproval",
      telegramChatId: "-1001",
      telegramTopicId: 22,
      telegramMessageId: null,
      payloadJson: JSON.stringify({ hello: "world" })
    });

    expect(pending.status).toBe("pending");
    expect(pending.stateJson).toBeNull();

    await database.updateServerRequestMessageId(pending.id, 99);
    const updated = await database.getServerRequestById(pending.id);
    expect(updated?.telegramMessageId).toBe(99);

    const withState = await database.updateRequestState(JSON.stringify(77), JSON.stringify({ currentQuestionId: "q1" }));
    expect(withState.stateJson).toBe(JSON.stringify({ currentQuestionId: "q1" }));

    const resolved = await database.resolveRequest(JSON.stringify(77));
    expect(resolved.status).toBe("resolved");
    expect(resolved.stateJson).toBe(JSON.stringify({ currentQuestionId: "q1" }));
  });

  it("marks pending server requests resolved when the app server resolves them elsewhere", async () => {
    await database.createPendingRequest({
      requestIdJson: JSON.stringify(79),
      method: "item/tool/requestUserInput",
      telegramChatId: "-1001",
      telegramTopicId: 22,
      telegramMessageId: 100,
      payloadJson: JSON.stringify({ hello: "world" })
    });

    const resolved = await database.resolveRequestExternally(JSON.stringify(79));
    expect(resolved.status).toBe("resolved");
    expect(resolved.telegramMessageId).toBe(100);
  });

  it("expires pending server requests on restart", async () => {
    await database.createPendingRequest({
      requestIdJson: JSON.stringify(78),
      method: "item/tool/requestUserInput",
      telegramChatId: "-1001",
      telegramTopicId: 23,
      telegramMessageId: 100,
      payloadJson: JSON.stringify({ question: "answer?" })
    });

    const expiredCount = await database.expirePendingRequests();
    expect(expiredCount).toBe(1);

    const expired = await database.getPendingRequest(JSON.stringify(78));
    expect(expired.status).toBe("expired");
  });

  it("dedupes processed Telegram updates", async () => {
    expect(await database.markUpdateProcessed(123)).toBe(true);
    expect(await database.markUpdateProcessed(123)).toBe(false);
  });
});
