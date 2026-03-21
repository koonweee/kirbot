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
    expect(lookup?.surface).toEqual({ kind: "topic", topicId: 22 });
    expect(lookup?.preferredMode).toBe("plan");

    const archived = await database.archiveSessionByTopic(-1001, 22);
    expect(archived?.status).toBe("archived");
  });

  it("creates and looks up a root session separately from a topic session", async () => {
    const pendingRoot = await database.createProvisioningSession({
      telegramChatId: "-1001",
      surface: { kind: "root" }
    });
    expect("surface" in pendingRoot && pendingRoot.surface.kind).toBe("root");

    const activeRoot = await database.activateSession(pendingRoot.id, "root-thread");
    expect("surface" in activeRoot && activeRoot.surface.kind).toBe("root");

    const pendingTopic = await database.createProvisioningSession({
      telegramChatId: "-1001",
      surface: { kind: "topic", topicId: 22 }
    });
    const activeTopic = await database.activateSession(pendingTopic.id, "topic-thread");
    expect("surface" in activeTopic && activeTopic.surface.kind).toBe("topic");

    const rootLookup = await database.getRootSessionByChat(-1001);
    expect(rootLookup?.codexThreadId).toBe("root-thread");

    const topicLookup = await database.getSessionByTopic(-1001, 22);
    expect(topicLookup?.codexThreadId).toBe("topic-thread");
  });

  it("returns the existing root provisioning session when creation races", async () => {
    const first = await database.createProvisioningSession({
      telegramChatId: "-1001",
      surface: { kind: "root" }
    });

    const second = await database.createProvisioningSession({
      telegramChatId: "-1001",
      surface: { kind: "root" }
    });

    expect(second).toEqual(first);
  });

  it("reclaims an errored root session when provisioning is retried", async () => {
    const first = await database.createProvisioningSession({
      telegramChatId: "-1001",
      surface: { kind: "root" }
    });

    await database.markSessionErrored(first.id);

    const retried = await database.createProvisioningSession({
      telegramChatId: "-1001",
      surface: { kind: "root" }
    });

    expect(retried.id).toBe(first.id);
    expect(retried.status).toBe("provisioning");
    expect(retried.codexThreadId).toBeNull();
  });

  it("stores separate root and spawn defaults", async () => {
    await database.upsertChatThreadDefaults("-1001", {
      root: {
        model: "gpt-5.4-mini",
        reasoningEffort: "medium",
        serviceTier: "fast",
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "dangerFullAccess"
        }
      },
      spawn: {
        model: "gpt-5-codex",
        reasoningEffort: "high",
        serviceTier: null,
        approvalPolicy: "on-request",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [],
          readOnlyAccess: {
            type: "fullAccess"
          },
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false
        }
      }
    });

    const defaults = await database.getChatThreadDefaults("-1001");
    expect(defaults?.root.model).toBe("gpt-5.4-mini");
    expect(defaults?.root.approvalPolicy).toBe("never");
    expect(defaults?.spawn.model).toBe("gpt-5-codex");
    expect(defaults?.spawn.reasoningEffort).toBe("high");
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

  it("stores, updates, and deletes custom commands", async () => {
    const created = await database.createCustomCommand({
      command: "deploy-check",
      prompt: "Review the deploy checklist."
    });

    expect(created.command).toBe("deploy-check");
    expect(created.prompt).toBe("Review the deploy checklist.");

    const updated = await database.updateCustomCommandPrompt("deploy-check", "Review the release checklist.");
    expect(updated?.prompt).toBe("Review the release checklist.");

    expect(await database.deleteCustomCommand("deploy-check")).toBe(true);
    expect(await database.getCustomCommandByName("deploy-check")).toBeUndefined();
  });

  it("stores and resolves pending custom command adds", async () => {
    const pending = await database.createPendingCustomCommandAdd({
      command: "standup",
      prompt: "Draft the daily update.",
      telegramChatId: "-1001"
    });

    expect(pending.status).toBe("pending");
    expect(pending.telegramMessageId).toBeNull();
    expect(await database.countPendingCustomCommandAdds()).toBe(1);

    await database.updatePendingCustomCommandAddMessageId(pending.id, 123);
    const withMessage = await database.getPendingCustomCommandAddById(pending.id);
    expect(withMessage?.telegramMessageId).toBe(123);

    const confirmed = await database.updatePendingCustomCommandAddStatus(pending.id, "confirmed");
    expect(confirmed?.status).toBe("confirmed");
    expect(await database.countPendingCustomCommandAdds()).toBe(0);
  });
});
