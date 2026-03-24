import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BridgeDatabase } from "../src/db";
import type { SessionSurface } from "../src/domain";

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
      profileId: "coding"
    });

    expect(pending.status).toBe("provisioning");
    expect(pending.preferredMode).toBe("default");
    expect(pending.profileId).toBe("coding");

    const active = await database.activateSession(pending.id, "thread-1");
    expect(active.status).toBe("active");
    expect(active.codexThreadId).toBe("thread-1");
    expect(active.preferredMode).toBe("default");
    expect(active.profileId).toBe("coding");

    const updatedMode = await database.updateSessionPreferredMode(-1001, 22, "plan");
    expect(updatedMode?.preferredMode).toBe("plan");

    const lookup = await database.getSessionByCodexThreadId("thread-1");
    expect(lookup?.surface).toEqual({ kind: "topic", topicId: 22 });
    expect(lookup?.preferredMode).toBe("plan");

    const archived = await database.archiveSessionByTopic(-1001, 22);
    expect(archived?.status).toBe("archived");
  });

  it("rejects provisioning a topic session without a numeric topic id", async () => {
    await expect(
      database.createProvisioningSession({
        telegramChatId: "-1001",
        surface: { kind: "topic" } as SessionSurface,
        profileId: "coding"
      })
    ).rejects.toThrow("Topic sessions require a numeric topic id");
  });

  it("creates and looks up a general session separately from topic sessions", async () => {
    const pendingGeneral = await database.createProvisioningSession({
      telegramChatId: "-1001",
      surface: { kind: "general" },
      profileId: "general"
    });
    expect("surface" in pendingGeneral && pendingGeneral.surface.kind).toBe("general");
    expect(pendingGeneral.profileId).toBe("general");

    const activeGeneral = await database.activateSession(pendingGeneral.id, "general-thread");
    expect("surface" in activeGeneral && activeGeneral.surface.kind).toBe("general");
    expect(activeGeneral.profileId).toBe("general");

    const firstTopic = await database.createProvisioningSession({
      telegramChatId: "-1001",
      surface: { kind: "topic", topicId: 22 },
      profileId: "coding"
    });
    const secondTopic = await database.createProvisioningSession({
      telegramChatId: "-1001",
      surface: { kind: "topic", topicId: 23 },
      profileId: "coding"
    });
    const activeFirstTopic = await database.activateSession(firstTopic.id, "topic-thread-22");
    expect("surface" in activeFirstTopic && activeFirstTopic.surface.kind).toBe("topic");
    expect(activeFirstTopic.profileId).toBe("coding");
    expect(secondTopic.id).not.toBe(firstTopic.id);

    const rootLookup = await database.getRootSessionByChat(-1001);
    expect(rootLookup?.surface).toEqual({ kind: "general" });
    expect(rootLookup?.codexThreadId).toBe("general-thread");
    expect(rootLookup?.settings.model).toBeNull();

    const topicLookup = await database.getSessionByTopic(-1001, 22);
    expect(topicLookup?.codexThreadId).toBe("topic-thread-22");
    expect(topicLookup?.settings.model).toBeNull();

    const otherTopicLookup = await database.getSessionByTopic(-1001, 23);
    expect(otherTopicLookup?.telegramTopicId).toBe(23);
  });

  it("stores nullable general-session overrides without requiring a complete snapshot", async () => {
    const pendingGeneral = await database.createProvisioningSession({
      telegramChatId: "-1001",
      surface: { kind: "general" },
      profileId: "general"
    });
    await database.activateSession(pendingGeneral.id, "general-thread");

    const updatedRoot = await database.updateRootSessionSettings("-1001", {
      model: "gpt-5.4-mini",
      reasoningEffort: null,
      serviceTier: null,
      approvalPolicy: null,
      sandboxPolicy: null
    });

    expect(updatedRoot?.surface).toEqual({ kind: "general" });
    expect(updatedRoot?.profileId).toBe("general");
    expect(updatedRoot?.settings.model).toBe("gpt-5.4-mini");
    expect(updatedRoot?.settings.reasoningEffort).toBeNull();
    expect(updatedRoot?.settings.approvalPolicy).toBeNull();
    expect(updatedRoot?.settings.sandboxPolicy).toBeNull();

    const rootLookup = await database.getRootSessionByChat("-1001");
    expect(rootLookup?.surface).toEqual({ kind: "general" });
    expect(rootLookup?.profileId).toBe("general");
    expect(rootLookup?.settings).toEqual({
      model: "gpt-5.4-mini",
      reasoningEffort: null,
      serviceTier: null,
      approvalPolicy: null,
      sandboxPolicy: null,
      overrides: {
        model: true,
        reasoningEffort: false,
        serviceTier: false,
        approvalPolicy: false,
        sandboxPolicy: false
      }
    });
  });

  it("persists only the explicitly overridden fields for general and topic sessions", async () => {
    const pendingGeneral = await database.createProvisioningSession({
      telegramChatId: "-1001",
      surface: { kind: "general" },
      profileId: "general"
    });
    await database.activateSession(pendingGeneral.id, "general-thread");

    const pendingTopic = await database.createProvisioningSession({
      telegramChatId: "-1001",
      surface: { kind: "topic", topicId: 22 },
      profileId: "coding"
    });
    await database.activateSession(pendingTopic.id, "topic-thread");

    await database.updateRootSessionSettings("-1001", {
      model: "gpt-5.4-mini",
      reasoningEffort: null,
      serviceTier: null,
      approvalPolicy: null,
      sandboxPolicy: null
    });

    await database.updateTopicSessionSettings(-1001, 22, {
      model: null,
      reasoningEffort: "high",
      serviceTier: "fast",
      approvalPolicy: null,
      sandboxPolicy: null
    });

    const rootLookup = await database.getRootSessionByChat("-1001");
    expect(rootLookup?.settings).toEqual({
      model: "gpt-5.4-mini",
      reasoningEffort: null,
      serviceTier: null,
      approvalPolicy: null,
      sandboxPolicy: null,
      overrides: {
        model: true,
        reasoningEffort: false,
        serviceTier: false,
        approvalPolicy: false,
        sandboxPolicy: false
      }
    });

    const topicLookup = await database.getSessionByTopic(-1001, 22);
    expect(topicLookup?.settings).toEqual({
      model: null,
      reasoningEffort: "high",
      serviceTier: "fast",
      approvalPolicy: null,
      sandboxPolicy: null,
      overrides: {
        model: false,
        reasoningEffort: true,
        serviceTier: true,
        approvalPolicy: false,
        sandboxPolicy: false
      }
    });
  });

  it("repoints an active general session to a fresh Codex thread without changing nullable overrides", async () => {
    const pendingGeneral = await database.createProvisioningSession({
      telegramChatId: "-1001",
      surface: { kind: "general" },
      profileId: "general"
    });
    await database.activateSession(pendingGeneral.id, "thread-1");

    await database.updateRootSessionSettings("-1001", {
      model: "gpt-5.4-mini",
      reasoningEffort: null,
      serviceTier: null,
      approvalPolicy: null,
      sandboxPolicy: null
    });

    const repointed = await database.activateSession(pendingGeneral.id, "thread-2");
    expect(repointed.surface).toEqual({ kind: "general" });
    expect(repointed.codexThreadId).toBe("thread-2");
    expect(repointed.settings.model).toBe("gpt-5.4-mini");
    expect(repointed.settings.reasoningEffort).toBeNull();
    expect(repointed.settings.approvalPolicy).toBeNull();
  });

  it("does not create a chat-level defaults table", async () => {
    const tables = await database.kysely
      .selectFrom("sqlite_master" as any)
      .select("name" as any)
      .where("type" as any, "=", "table")
      .execute();

    expect(tables.map((table) => (table as { name: string }).name)).not.toContain("chat_profile_defaults");
  });

  it("creates new sessions with all overrides unset", async () => {
    const general = await database.createProvisioningSession({
      telegramChatId: "-1001",
      surface: { kind: "general" },
      profileId: "general"
    });
    const topic = await database.createProvisioningSession({
      telegramChatId: "-1001",
      surface: { kind: "topic", topicId: 55 },
      profileId: "coding"
    });

    expect(general.settings).toEqual({
      model: null,
      reasoningEffort: null,
      serviceTier: null,
      approvalPolicy: null,
      sandboxPolicy: null
    });
    expect(topic.settings).toEqual({
      model: null,
      reasoningEffort: null,
      serviceTier: null,
      approvalPolicy: null,
      sandboxPolicy: null
    });
  });

  it("no longer migrates or exposes chat-level defaults APIs", async () => {
    expect("getChatProfileDefaults" in database).toBe(false);
    expect("upsertChatProfileDefaults" in database).toBe(false);
  });

  it("returns the existing general provisioning session when creation races", async () => {
    const first = await database.createProvisioningSession({
      telegramChatId: "-1001",
      surface: { kind: "general" },
      profileId: "general"
    });

    const second = await database.createProvisioningSession({
      telegramChatId: "-1001",
      surface: { kind: "general" },
      profileId: "general"
    });

    expect(second).toEqual(first);
  });

  it("reclaims an errored general session when provisioning is retried", async () => {
    const first = await database.createProvisioningSession({
      telegramChatId: "-1001",
      surface: { kind: "general" },
      profileId: "general"
    });

    await database.markSessionErrored(first.id);

    const retried = await database.createProvisioningSession({
      telegramChatId: "-1001",
      surface: { kind: "general" },
      profileId: "general"
    });

    expect(retried.id).toBe(first.id);
    expect(retried.status).toBe("provisioning");
    expect(retried.codexThreadId).toBeNull();
  });

  it("resets reclaimed archived topic sessions back to default mode", async () => {
    const first = await database.createProvisioningSession({
      telegramChatId: "-1001",
      surface: { kind: "topic", topicId: 44 },
      profileId: "coding"
    });
    await database.activateSession(first.id, "thread-44");
    await database.updateSessionPreferredMode(-1001, 44, "plan");
    await database.archiveSessionByTopic(-1001, 44);

    const retried = await database.createProvisioningSession({
      telegramChatId: "-1001",
      surface: { kind: "topic", topicId: 44 },
      profileId: "coding"
    });

    expect(retried.id).toBe(first.id);
    expect(retried.status).toBe("provisioning");
    expect(retried.codexThreadId).toBeNull();
    expect(retried.preferredMode).toBe("default");
  });

  it("rejects malformed topic rows on write", async () => {
    await expect(
      database.kysely
        .insertInto("sessions")
        .values({
          telegram_chat_id: "-1001",
          surface_kind: "topic",
          telegram_topic_id: null,
          profile_id: "coding",
          codex_thread_id: null,
          status: "active",
          preferred_mode: "default",
          model: null,
          reasoning_effort: null,
          service_tier: null,
          approval_policy: null,
          sandbox_policy_json: null,
          model_is_overridden: 0,
          reasoning_effort_is_overridden: 0,
          service_tier_is_overridden: 0,
          approval_policy_is_overridden: 0,
          sandbox_policy_is_overridden: 0
        })
        .execute()
    ).rejects.toThrow();
  });

  it("rejects malformed general rows on write", async () => {
    await expect(
      database.kysely
        .insertInto("sessions")
        .values({
          telegram_chat_id: "-1001",
          surface_kind: "general",
          telegram_topic_id: 99,
          profile_id: "general",
          codex_thread_id: null,
          status: "active",
          preferred_mode: "default",
          model: null,
          reasoning_effort: null,
          service_tier: null,
          approval_policy: null,
          sandbox_policy_json: null,
          model_is_overridden: 0,
          reasoning_effort_is_overridden: 0,
          service_tier_is_overridden: 0,
          approval_policy_is_overridden: 0,
          sandbox_policy_is_overridden: 0
        })
        .execute()
    ).rejects.toThrow();
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
