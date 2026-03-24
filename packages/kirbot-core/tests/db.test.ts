import SqliteDatabase from "better-sqlite3";
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

  it("stores profile-aware defaults by chat and profile id", async () => {
    await database.upsertChatProfileDefaults("-1001", "general", {
      model: "gpt-5.4",
      reasoningEffort: "medium",
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
    });

    await database.upsertChatProfileDefaults("-1001", "coding", {
      model: "gpt-5.4-mini",
      reasoningEffort: "high",
      serviceTier: "fast",
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "dangerFullAccess"
      }
    });

    const generalDefaults = await database.getChatProfileDefaults("-1001", "general");
    expect(generalDefaults?.profileId).toBe("general");
    expect(generalDefaults?.model).toBe("gpt-5.4");

    const codingDefaults = await database.getChatProfileDefaults("-1001", "coding");
    expect(codingDefaults?.profileId).toBe("coding");
    expect(codingDefaults?.model).toBe("gpt-5.4-mini");
  });

  it("stores general session settings via profile-aware helpers", async () => {
    const pendingGeneral = await database.createProvisioningSession({
      telegramChatId: "-1001",
      surface: { kind: "general" },
      profileId: "general"
    });
    await database.activateSession(pendingGeneral.id, "general-thread");

    const updatedRoot = await database.updateRootSessionSettings("-1001", {
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
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
    });

    expect(updatedRoot?.surface).toEqual({ kind: "general" });
    expect(updatedRoot?.profileId).toBe("general");
    expect(updatedRoot?.settings.model).toBe("gpt-5.4-mini");
    expect(updatedRoot?.settings.reasoningEffort).toBe("medium");
    expect(updatedRoot?.settings.approvalPolicy).toBe("on-request");

    const rootLookup = await database.getRootSessionByChat("-1001");
    expect(rootLookup?.surface).toEqual({ kind: "general" });
    expect(rootLookup?.profileId).toBe("general");
  });

  it("repoints an active general session to a fresh Codex thread without changing settings", async () => {
    const pendingGeneral = await database.createProvisioningSession({
      telegramChatId: "-1001",
      surface: { kind: "general" },
      profileId: "general"
    });
    await database.activateSession(pendingGeneral.id, "thread-1");

    await database.updateRootSessionSettings("-1001", {
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
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
    });

    const repointed = await database.activateSession(pendingGeneral.id, "thread-2");
    expect(repointed.surface).toEqual({ kind: "general" });
    expect(repointed.codexThreadId).toBe("thread-2");
    expect(repointed.settings.model).toBe("gpt-5.4-mini");
    expect(repointed.settings.reasoningEffort).toBe("medium");
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
          sandbox_policy_json: null
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
          sandbox_policy_json: null
        })
        .execute()
    ).rejects.toThrow();
  });

  it("migrates v6 root sessions to general and preserves unique session surfaces", async () => {
    const legacyPath = join(tempDir, "legacy-v6.sqlite");
    const sqlite = new SqliteDatabase(legacyPath);

    sqlite.exec(`
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_chat_id TEXT NOT NULL,
        surface_kind TEXT NOT NULL,
        telegram_topic_id INTEGER,
        codex_thread_id TEXT,
        status TEXT NOT NULL,
        preferred_mode TEXT NOT NULL DEFAULT 'default',
        model TEXT,
        reasoning_effort TEXT,
        service_tier TEXT,
        approval_policy TEXT,
        sandbox_policy_json TEXT
      );

      CREATE UNIQUE INDEX sessions_root_unique
        ON sessions (telegram_chat_id, surface_kind)
        WHERE surface_kind = 'root';

      CREATE UNIQUE INDEX sessions_topic_unique
        ON sessions (telegram_chat_id, telegram_topic_id)
        WHERE surface_kind = 'topic';

      CREATE UNIQUE INDEX sessions_thread_unique
        ON sessions (codex_thread_id)
        WHERE codex_thread_id IS NOT NULL;
    `);

    sqlite.pragma("user_version = 6");
    sqlite.prepare(`
      INSERT INTO sessions (
        id,
        telegram_chat_id,
        surface_kind,
        telegram_topic_id,
        codex_thread_id,
        status,
        preferred_mode,
        model,
        reasoning_effort,
        service_tier,
        approval_policy,
        sandbox_policy_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, "-1001", "root", null, "root-thread", "active", "default", null, null, null, null, null);
    sqlite.prepare(`
      INSERT INTO sessions (
        id,
        telegram_chat_id,
        surface_kind,
        telegram_topic_id,
        codex_thread_id,
        status,
        preferred_mode,
        model,
        reasoning_effort,
        service_tier,
        approval_policy,
        sandbox_policy_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(2, "-1001", "topic", 22, "topic-thread", "active", "plan", null, null, null, null, null);
    sqlite.close();

    const migratedDatabase = new BridgeDatabase(legacyPath);
    await migratedDatabase.migrate();

    const general = await migratedDatabase.getRootSessionByChat("-1001");
    expect(general?.surface).toEqual({ kind: "general" });
    expect(general?.codexThreadId).toBe("root-thread");

    const topic = await migratedDatabase.getSessionByTopic(-1001, 22);
    expect(topic?.telegramTopicId).toBe(22);
    expect(topic?.codexThreadId).toBe("topic-thread");

    const repeatedGeneral = await migratedDatabase.createProvisioningSession({
      telegramChatId: "-1001",
      surface: { kind: "general" },
      profileId: "general"
    });
    expect(repeatedGeneral.id).toBe(general?.id);

    const repeatedTopic = await migratedDatabase.createProvisioningSession({
      telegramChatId: "-1001",
      surface: { kind: "topic", topicId: 22 },
      profileId: "coding"
    });
    expect(repeatedTopic.id).toBe(topic?.id);

    const newTopic = await migratedDatabase.createProvisioningSession({
      telegramChatId: "-1001",
      surface: { kind: "topic", topicId: 23 },
      profileId: "coding"
    });
    expect(newTopic.surface).toEqual({ kind: "topic", topicId: 23 });

    await migratedDatabase.close();
  });

  it("migrates v7 general sessions to v8 without losing data and enforces constraints", async () => {
    const legacyPath = join(tempDir, "legacy-v7.sqlite");
    const sqlite = new SqliteDatabase(legacyPath);

    sqlite.exec(`
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_chat_id TEXT NOT NULL,
        surface_kind TEXT NOT NULL,
        telegram_topic_id INTEGER,
        codex_thread_id TEXT,
        status TEXT NOT NULL,
        preferred_mode TEXT NOT NULL DEFAULT 'default',
        model TEXT,
        reasoning_effort TEXT,
        service_tier TEXT,
        approval_policy TEXT,
        sandbox_policy_json TEXT
      );

      CREATE UNIQUE INDEX sessions_general_unique
        ON sessions (telegram_chat_id, surface_kind)
        WHERE surface_kind = 'general';

      CREATE UNIQUE INDEX sessions_topic_unique
        ON sessions (telegram_chat_id, telegram_topic_id)
        WHERE surface_kind = 'topic';

      CREATE UNIQUE INDEX sessions_thread_unique
        ON sessions (codex_thread_id)
        WHERE codex_thread_id IS NOT NULL;
    `);

    sqlite.pragma("user_version = 7");
    sqlite.prepare(`
      INSERT INTO sessions (
        id,
        telegram_chat_id,
        surface_kind,
        telegram_topic_id,
        codex_thread_id,
        status,
        preferred_mode,
        model,
        reasoning_effort,
        service_tier,
        approval_policy,
        sandbox_policy_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, "-1001", "general", null, "general-thread", "active", "default", null, null, null, null, null);
    sqlite.prepare(`
      INSERT INTO sessions (
        id,
        telegram_chat_id,
        surface_kind,
        telegram_topic_id,
        codex_thread_id,
        status,
        preferred_mode,
        model,
        reasoning_effort,
        service_tier,
        approval_policy,
        sandbox_policy_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(2, "-1001", "topic", 31, "topic-thread", "active", "plan", null, null, null, null, null);
    sqlite.close();

    const migratedDatabase = new BridgeDatabase(legacyPath);
    await migratedDatabase.migrate();

    const general = await migratedDatabase.getRootSessionByChat("-1001");
    expect(general?.surface).toEqual({ kind: "general" });
    expect(general?.codexThreadId).toBe("general-thread");

    const topic = await migratedDatabase.getSessionByTopic(-1001, 31);
    expect(topic?.telegramTopicId).toBe(31);
    expect(topic?.codexThreadId).toBe("topic-thread");

    await expect(
      migratedDatabase.kysely
        .insertInto("sessions")
        .values({
          telegram_chat_id: "-1001",
          surface_kind: "general",
          telegram_topic_id: null,
          profile_id: "general",
          codex_thread_id: "duplicate-general-thread",
          status: "active",
          preferred_mode: "default",
          model: null,
          reasoning_effort: null,
          service_tier: null,
          approval_policy: null,
          sandbox_policy_json: null
        })
        .execute()
    ).rejects.toThrow();

    await expect(
      migratedDatabase.kysely
        .insertInto("sessions")
        .values({
          telegram_chat_id: "-1001",
          surface_kind: "general",
          telegram_topic_id: 77,
          profile_id: "general",
          codex_thread_id: "malformed-general-thread",
          status: "active",
          preferred_mode: "default",
          model: null,
          reasoning_effort: null,
          service_tier: null,
          approval_policy: null,
          sandbox_policy_json: null
        })
        .execute()
    ).rejects.toThrow();

    const repeatedGeneral = await migratedDatabase.createProvisioningSession({
      telegramChatId: "-1001",
      surface: { kind: "general" },
      profileId: "general"
    });
    expect(repeatedGeneral.id).toBe(general?.id);

    const newTopic = await migratedDatabase.createProvisioningSession({
      telegramChatId: "-1001",
      surface: { kind: "topic", topicId: 32 },
      profileId: "coding"
    });
    expect(newTopic.surface).toEqual({ kind: "topic", topicId: 32 });

    await migratedDatabase.close();
  });

  it("migrates chat thread defaults to profile-aware defaults on v9", async () => {
    const legacyPath = join(tempDir, "legacy-v8.sqlite");
    const sqlite = new SqliteDatabase(legacyPath);

    sqlite.exec(`
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_chat_id TEXT NOT NULL,
        surface_kind TEXT NOT NULL,
        telegram_topic_id INTEGER,
        codex_thread_id TEXT,
        status TEXT NOT NULL,
        preferred_mode TEXT NOT NULL DEFAULT 'default',
        model TEXT,
        reasoning_effort TEXT,
        service_tier TEXT,
        approval_policy TEXT,
        sandbox_policy_json TEXT,
        CHECK (surface_kind IN ('general', 'topic')),
        CHECK (
          (surface_kind = 'general' AND telegram_topic_id IS NULL)
          OR (surface_kind = 'topic' AND telegram_topic_id IS NOT NULL)
        )
      );

      CREATE UNIQUE INDEX sessions_general_unique
        ON sessions (telegram_chat_id, surface_kind)
        WHERE surface_kind = 'general';

      CREATE UNIQUE INDEX sessions_topic_unique
        ON sessions (telegram_chat_id, telegram_topic_id)
        WHERE surface_kind = 'topic';

      CREATE UNIQUE INDEX sessions_thread_unique
        ON sessions (codex_thread_id)
        WHERE codex_thread_id IS NOT NULL;

      CREATE TABLE chat_thread_defaults (
        telegram_chat_id TEXT PRIMARY KEY,
        root_model TEXT,
        root_reasoning_effort TEXT,
        root_service_tier TEXT,
        root_approval_policy TEXT,
        root_sandbox_policy_json TEXT,
        spawn_model TEXT,
        spawn_reasoning_effort TEXT,
        spawn_service_tier TEXT,
        spawn_approval_policy TEXT,
        spawn_sandbox_policy_json TEXT
      );
    `);

    sqlite.pragma("user_version = 8");
    sqlite.prepare(`
      INSERT INTO chat_thread_defaults (
        telegram_chat_id,
        root_model,
        root_reasoning_effort,
        root_service_tier,
        root_approval_policy,
        root_sandbox_policy_json,
        spawn_model,
        spawn_reasoning_effort,
        spawn_service_tier,
        spawn_approval_policy,
        spawn_sandbox_policy_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "-1001",
      "gpt-5.4",
      "medium",
      null,
      JSON.stringify("on-request"),
      JSON.stringify({
        type: "workspaceWrite",
        writableRoots: [],
        readOnlyAccess: { type: "fullAccess" },
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false
      }),
      "gpt-5.4-mini",
      "high",
      "fast",
      JSON.stringify("never"),
      JSON.stringify({ type: "dangerFullAccess" })
    );
    sqlite.close();

    const migratedDatabase = new BridgeDatabase(legacyPath);
    await migratedDatabase.migrate();

    const defaults = await migratedDatabase.getChatProfileDefaults("-1001", "general");
    expect(defaults?.profileId).toBe("general");
    expect(defaults?.model).toBe("gpt-5.4");

    const codingDefaults = await migratedDatabase.getChatProfileDefaults("-1001", "coding");
    expect(codingDefaults?.profileId).toBe("coding");
    expect(codingDefaults?.model).toBe("gpt-5.4-mini");

    await migratedDatabase.close();
  });

  it("routes v8 session and default migrations through the configured profile ids", async () => {
    const legacyPath = join(tempDir, "legacy-v8-custom-routing.sqlite");
    const sqlite = new SqliteDatabase(legacyPath);

    sqlite.exec(`
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_chat_id TEXT NOT NULL,
        surface_kind TEXT NOT NULL,
        telegram_topic_id INTEGER,
        codex_thread_id TEXT,
        status TEXT NOT NULL,
        preferred_mode TEXT NOT NULL DEFAULT 'default',
        model TEXT,
        reasoning_effort TEXT,
        service_tier TEXT,
        approval_policy TEXT,
        sandbox_policy_json TEXT,
        CHECK (surface_kind IN ('general', 'topic')),
        CHECK (
          (surface_kind = 'general' AND telegram_topic_id IS NULL)
          OR (surface_kind = 'topic' AND telegram_topic_id IS NOT NULL)
        )
      );

      CREATE UNIQUE INDEX sessions_general_unique
        ON sessions (telegram_chat_id, surface_kind)
        WHERE surface_kind = 'general';

      CREATE UNIQUE INDEX sessions_topic_unique
        ON sessions (telegram_chat_id, telegram_topic_id)
        WHERE surface_kind = 'topic';

      CREATE UNIQUE INDEX sessions_thread_unique
        ON sessions (codex_thread_id)
        WHERE codex_thread_id IS NOT NULL;

      CREATE TABLE chat_thread_defaults (
        telegram_chat_id TEXT PRIMARY KEY,
        root_model TEXT,
        root_reasoning_effort TEXT,
        root_service_tier TEXT,
        root_approval_policy TEXT,
        root_sandbox_policy_json TEXT,
        spawn_model TEXT,
        spawn_reasoning_effort TEXT,
        spawn_service_tier TEXT,
        spawn_approval_policy TEXT,
        spawn_sandbox_policy_json TEXT
      );
    `);

    sqlite.pragma("user_version = 8");
    sqlite.prepare(`
      INSERT INTO sessions (
        id,
        telegram_chat_id,
        surface_kind,
        telegram_topic_id,
        codex_thread_id,
        status,
        preferred_mode,
        model,
        reasoning_effort,
        service_tier,
        approval_policy,
        sandbox_policy_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, "-1001", "general", null, "general-thread", "active", "default", null, null, null, null, null);
    sqlite.prepare(`
      INSERT INTO sessions (
        id,
        telegram_chat_id,
        surface_kind,
        telegram_topic_id,
        codex_thread_id,
        status,
        preferred_mode,
        model,
        reasoning_effort,
        service_tier,
        approval_policy,
        sandbox_policy_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(2, "-1001", "topic", 41, "topic-plan-thread", "active", "plan", null, null, null, null, null);
    sqlite.prepare(`
      INSERT INTO chat_thread_defaults (
        telegram_chat_id,
        root_model,
        root_reasoning_effort,
        root_service_tier,
        root_approval_policy,
        root_sandbox_policy_json,
        spawn_model,
        spawn_reasoning_effort,
        spawn_service_tier,
        spawn_approval_policy,
        spawn_sandbox_policy_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "-1001",
      "gpt-5.4",
      "medium",
      null,
      JSON.stringify("on-request"),
      JSON.stringify({
        type: "workspaceWrite",
        writableRoots: [],
        readOnlyAccess: { type: "fullAccess" },
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false
      }),
      "gpt-5.4-mini",
      "high",
      "fast",
      JSON.stringify("never"),
      JSON.stringify({ type: "dangerFullAccess" })
    );
    sqlite.close();

    const migratedDatabase = new BridgeDatabase(legacyPath, {
      general: "ops-general",
      thread: "worker",
      plan: "planner"
    });
    await migratedDatabase.migrate();

    expect(await migratedDatabase.getRootSessionByChat("-1001")).toMatchObject({
      profileId: "ops-general",
      codexThreadId: "general-thread"
    });
    expect(await migratedDatabase.getSessionByTopic(-1001, 41)).toMatchObject({
      profileId: "planner",
      codexThreadId: "topic-plan-thread",
      preferredMode: "plan"
    });

    expect(await migratedDatabase.getChatProfileDefaults("-1001", "ops-general")).toMatchObject({
      profileId: "ops-general",
      model: "gpt-5.4"
    });
    expect(await migratedDatabase.getChatProfileDefaults("-1001", "worker")).toMatchObject({
      profileId: "worker",
      model: "gpt-5.4-mini"
    });
    expect(await migratedDatabase.getChatProfileDefaults("-1001", "general")).toBeUndefined();
    expect(await migratedDatabase.getChatProfileDefaults("-1001", "coding")).toBeUndefined();

    await migratedDatabase.close();
  });

  it("migrates overlapping general/thread routing without duplicating chat defaults", async () => {
    const legacyPath = join(tempDir, "legacy-v8-overlapping-routing.sqlite");
    const sqlite = new SqliteDatabase(legacyPath);

    sqlite.exec(`
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_chat_id TEXT NOT NULL,
        surface_kind TEXT NOT NULL,
        telegram_topic_id INTEGER,
        codex_thread_id TEXT,
        status TEXT NOT NULL,
        preferred_mode TEXT NOT NULL DEFAULT 'default',
        model TEXT,
        reasoning_effort TEXT,
        service_tier TEXT,
        approval_policy TEXT,
        sandbox_policy_json TEXT,
        CHECK (surface_kind IN ('general', 'topic')),
        CHECK (
          (surface_kind = 'general' AND telegram_topic_id IS NULL)
          OR (surface_kind = 'topic' AND telegram_topic_id IS NOT NULL)
        )
      );

      CREATE UNIQUE INDEX sessions_general_unique
        ON sessions (telegram_chat_id, surface_kind)
        WHERE surface_kind = 'general';

      CREATE UNIQUE INDEX sessions_topic_unique
        ON sessions (telegram_chat_id, telegram_topic_id)
        WHERE surface_kind = 'topic';

      CREATE UNIQUE INDEX sessions_thread_unique
        ON sessions (codex_thread_id)
        WHERE codex_thread_id IS NOT NULL;

      CREATE TABLE chat_thread_defaults (
        telegram_chat_id TEXT PRIMARY KEY,
        root_model TEXT,
        root_reasoning_effort TEXT,
        root_service_tier TEXT,
        root_approval_policy TEXT,
        root_sandbox_policy_json TEXT,
        spawn_model TEXT,
        spawn_reasoning_effort TEXT,
        spawn_service_tier TEXT,
        spawn_approval_policy TEXT,
        spawn_sandbox_policy_json TEXT
      );
    `);

    sqlite.pragma("user_version = 8");
    sqlite.prepare(`
      INSERT INTO sessions (
        id,
        telegram_chat_id,
        surface_kind,
        telegram_topic_id,
        codex_thread_id,
        status,
        preferred_mode,
        model,
        reasoning_effort,
        service_tier,
        approval_policy,
        sandbox_policy_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, "-1001", "general", null, "general-thread", "active", "default", null, null, null, null, null);
    sqlite.prepare(`
      INSERT INTO sessions (
        id,
        telegram_chat_id,
        surface_kind,
        telegram_topic_id,
        codex_thread_id,
        status,
        preferred_mode,
        model,
        reasoning_effort,
        service_tier,
        approval_policy,
        sandbox_policy_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(2, "-1001", "topic", 41, "topic-plan-thread", "active", "plan", null, null, null, null, null);
    sqlite.prepare(`
      INSERT INTO chat_thread_defaults (
        telegram_chat_id,
        root_model,
        root_reasoning_effort,
        root_service_tier,
        root_approval_policy,
        root_sandbox_policy_json,
        spawn_model,
        spawn_reasoning_effort,
        spawn_service_tier,
        spawn_approval_policy,
        spawn_sandbox_policy_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "-1001",
      "gpt-5.4",
      "medium",
      null,
      JSON.stringify("on-request"),
      JSON.stringify({
        type: "workspaceWrite",
        writableRoots: [],
        readOnlyAccess: { type: "fullAccess" },
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false
      }),
      "gpt-5.4-mini",
      "high",
      "fast",
      JSON.stringify("never"),
      JSON.stringify({ type: "dangerFullAccess" })
    );
    sqlite.close();

    const migratedDatabase = new BridgeDatabase(legacyPath, {
      general: "shared",
      thread: "shared",
      plan: "planner"
    });
    await migratedDatabase.migrate();

    expect(await migratedDatabase.getRootSessionByChat("-1001")).toMatchObject({
      profileId: "shared",
      codexThreadId: "general-thread"
    });
    expect(await migratedDatabase.getSessionByTopic(-1001, 41)).toMatchObject({
      profileId: "planner",
      codexThreadId: "topic-plan-thread",
      preferredMode: "plan"
    });

    expect(await migratedDatabase.getChatProfileDefaults("-1001", "shared")).toMatchObject({
      profileId: "shared",
      model: "gpt-5.4"
    });
    expect(await migratedDatabase.getChatProfileDefaults("-1001", "planner")).toBeUndefined();

    await migratedDatabase.close();
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
