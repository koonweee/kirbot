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
      telegramTopicId: 22,
      rootMessageId: 33,
      createdByUserId: 44,
      title: "Test topic"
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
      codexThreadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      payloadJson: JSON.stringify({ hello: "world" })
    });

    expect(pending.status).toBe("pending");
    expect(pending.stateJson).toBeNull();

    await database.updateServerRequestMessageId(pending.id, 99);
    const updated = await database.getServerRequestById(pending.id);
    expect(updated?.telegramMessageId).toBe(99);

    const withState = await database.updateRequestState(JSON.stringify(77), JSON.stringify({ currentQuestionId: "q1" }));
    expect(withState.stateJson).toBe(JSON.stringify({ currentQuestionId: "q1" }));

    const resolved = await database.resolveRequest(JSON.stringify(77), JSON.stringify({ decision: "accept" }));
    expect(resolved.status).toBe("resolved");
    expect(resolved.responseJson).toBe(JSON.stringify({ decision: "accept" }));
  });

  it("expires pending server requests on restart", async () => {
    await database.createPendingRequest({
      requestIdJson: JSON.stringify(78),
      method: "item/tool/requestUserInput",
      telegramChatId: "-1001",
      telegramTopicId: 23,
      telegramMessageId: 100,
      codexThreadId: "thread-2",
      turnId: "turn-2",
      itemId: "item-2",
      payloadJson: JSON.stringify({ question: "answer?" })
    });

    const expiredCount = await database.expirePendingRequests(JSON.stringify({ reason: "startup" }));
    expect(expiredCount).toBe(1);

    const expired = await database.getPendingRequest(JSON.stringify(78));
    expect(expired.status).toBe("expired");
    expect(expired.responseJson).toBe(JSON.stringify({ reason: "startup" }));
  });

  it("stores resolved assistant text for completed turns", async () => {
    await database.recordTurnStart({
      telegramUpdateId: 1,
      telegramChatId: "-1001",
      telegramTopicId: 22,
      codexThreadId: "thread-1",
      codexTurnId: "turn-1",
      draftId: 10
    });
    await database.completeTurn("turn-1", 100, "completed", "");

    await database.recordTurnStart({
      telegramUpdateId: 2,
      telegramChatId: "-1001",
      telegramTopicId: 22,
      codexThreadId: "thread-1",
      codexTurnId: "turn-2",
      draftId: 11
    });
    await database.completeTurn("turn-2", 101, "completed", "Implemented");

    const first = await database.getTurnById("turn-1");
    const second = await database.getTurnById("turn-2");
    expect(first.resolvedAssistantText).toBe("");
    expect(second.resolvedAssistantText).toBe("Implemented");
  });
});
