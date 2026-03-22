import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";
import { sql } from "kysely";
import { Generated, Kysely, Selectable, SqliteDialect } from "kysely";

import type {
  BridgeSession,
  ChatThreadDefaults,
  CustomCommand,
  PendingCustomCommandAdd,
  PendingCustomCommandStatus,
  PendingServerRequest,
  PersistedThreadSettings,
  SessionSurface,
  SessionMode,
  SessionStatus,
  TopicSession
} from "./domain";

type TimestampString = string;
const SCHEMA_VERSION = 8;

type SessionsTable = {
  id: Generated<number>;
  telegram_chat_id: string;
  surface_kind: "general" | "topic";
  telegram_topic_id: number | null;
  codex_thread_id: string | null;
  status: SessionStatus;
  preferred_mode: SessionMode;
  model: string | null;
  reasoning_effort: string | null;
  service_tier: string | null;
  approval_policy: string | null;
  sandbox_policy_json: string | null;
};

type ChatThreadDefaultsTable = {
  telegram_chat_id: string;
  root_model: string | null;
  root_reasoning_effort: string | null;
  root_service_tier: string | null;
  root_approval_policy: string | null;
  root_sandbox_policy_json: string | null;
  spawn_model: string | null;
  spawn_reasoning_effort: string | null;
  spawn_service_tier: string | null;
  spawn_approval_policy: string | null;
  spawn_sandbox_policy_json: string | null;
};

type ServerRequestsTable = {
  id: Generated<number>;
  request_id_json: string;
  method: string;
  telegram_chat_id: string;
  telegram_topic_id: number | null;
  telegram_message_id: number | null;
  payload_json: string;
  state_json: string | null;
  status: "pending" | "resolved" | "expired";
  created_at: TimestampString;
};

type CustomCommandsTable = {
  id: Generated<number>;
  command: string;
  prompt: string;
  created_at: TimestampString;
  updated_at: TimestampString;
};

type PendingCustomCommandAddsTable = {
  id: Generated<number>;
  command: string;
  prompt: string;
  telegram_chat_id: string;
  telegram_message_id: number | null;
  status: PendingCustomCommandStatus;
  created_at: TimestampString;
  updated_at: TimestampString;
};

type ProcessedUpdatesTable = {
  telegram_update_id: Generated<number>;
};

export type DatabaseSchema = {
  sessions: SessionsTable;
  chat_thread_defaults: ChatThreadDefaultsTable;
  server_requests: ServerRequestsTable;
  custom_commands: CustomCommandsTable;
  pending_custom_command_adds: PendingCustomCommandAddsTable;
  processed_updates: ProcessedUpdatesTable;
};

function now(): string {
  return new Date().toISOString();
}

function isSqliteUniqueConstraintError(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error && error.code === "SQLITE_CONSTRAINT_UNIQUE";
}

function mapSession(row: Selectable<SessionsTable>): BridgeSession {
  if (row.surface_kind === "topic" && row.telegram_topic_id === null) {
    throw new Error("Topic session row is missing telegram_topic_id");
  }

  const surface: SessionSurface =
    row.surface_kind === "general" ? { kind: "general" } : { kind: "topic", topicId: row.telegram_topic_id! };

  return {
    id: row.id,
    telegramChatId: row.telegram_chat_id,
    surface,
    codexThreadId: row.codex_thread_id,
    status: row.status,
    preferredMode: row.preferred_mode,
    settings: mapPersistedThreadSettings({
      model: row.model,
      reasoningEffort: row.reasoning_effort,
      serviceTier: row.service_tier,
      approvalPolicyJson: row.approval_policy,
      sandboxPolicyJson: row.sandbox_policy_json
    })
  };
}

function mapChatThreadDefaults(row: Selectable<ChatThreadDefaultsTable>): ChatThreadDefaults {
  return {
    telegramChatId: row.telegram_chat_id,
    root: mapPersistedThreadSettings({
      model: row.root_model,
      reasoningEffort: row.root_reasoning_effort,
      serviceTier: row.root_service_tier,
      approvalPolicyJson: row.root_approval_policy,
      sandboxPolicyJson: row.root_sandbox_policy_json
    }),
    spawn: mapPersistedThreadSettings({
      model: row.spawn_model,
      reasoningEffort: row.spawn_reasoning_effort,
      serviceTier: row.spawn_service_tier,
      approvalPolicyJson: row.spawn_approval_policy,
      sandboxPolicyJson: row.spawn_sandbox_policy_json
    })
  };
}

function mapServerRequest(row: Selectable<ServerRequestsTable>): PendingServerRequest {
  return {
    id: row.id,
    requestIdJson: row.request_id_json,
    method: row.method,
    telegramChatId: row.telegram_chat_id,
    telegramTopicId: row.telegram_topic_id,
    telegramMessageId: row.telegram_message_id,
    payloadJson: row.payload_json,
    stateJson: row.state_json,
    status: row.status,
    createdAt: row.created_at
  };
}

function mapCustomCommand(row: Selectable<CustomCommandsTable>): CustomCommand {
  return {
    id: row.id,
    command: row.command,
    prompt: row.prompt,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapPendingCustomCommandAdd(row: Selectable<PendingCustomCommandAddsTable>): PendingCustomCommandAdd {
  return {
    id: row.id,
    command: row.command,
    prompt: row.prompt,
    telegramChatId: row.telegram_chat_id,
    telegramMessageId: row.telegram_message_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapPersistedThreadSettings(input: {
  model: string | null;
  reasoningEffort: string | null;
  serviceTier: string | null;
  approvalPolicyJson: string | null;
  sandboxPolicyJson: string | null;
}): PersistedThreadSettings {
  return {
    model: normalizePersistedModel(input.model),
    reasoningEffort: input.reasoningEffort as PersistedThreadSettings["reasoningEffort"],
    serviceTier: input.serviceTier as PersistedThreadSettings["serviceTier"],
    approvalPolicy: input.approvalPolicyJson
      ? (JSON.parse(input.approvalPolicyJson) as PersistedThreadSettings["approvalPolicy"])
      : null,
    sandboxPolicy: input.sandboxPolicyJson ? (JSON.parse(input.sandboxPolicyJson) as PersistedThreadSettings["sandboxPolicy"]) : null
  };
}

function normalizePersistedModel(model: string | null): string | null {
  if (!model || model === "unknown-model") {
    return null;
  }

  return model;
}

function validateSessionSurface(surface: SessionSurface): void {
  if (surface.kind === "topic" && !Number.isInteger(surface.topicId)) {
    throw new Error("Topic sessions require a numeric topic id");
  }
}

function sessionSurfaceToRow(surface: SessionSurface): Pick<SessionsTable, "surface_kind" | "telegram_topic_id"> {
  validateSessionSurface(surface);
  return surface.kind === "general"
    ? {
        surface_kind: "general",
        telegram_topic_id: null
      }
    : {
        surface_kind: "topic",
        telegram_topic_id: surface.topicId
      };
}

export class BridgeDatabase {
  readonly kysely: Kysely<DatabaseSchema>;
  readonly #sqlite: InstanceType<typeof Database>;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#sqlite = new Database(path);
    this.#sqlite.pragma("journal_mode = WAL");
    this.kysely = new Kysely<DatabaseSchema>({
      dialect: new SqliteDialect({ database: this.#sqlite })
    });
  }

  async migrate(): Promise<void> {
    const currentVersion = this.#readSchemaVersion();
    if (currentVersion === SCHEMA_VERSION) {
      this.#createSchemaV8();
      return;
    }

    if (currentVersion === 0) {
      this.#createSchemaV8();
      this.#writeSchemaVersion(SCHEMA_VERSION);
      return;
    }

    if (currentVersion === 7) {
      this.#migrateFromV7ToV8();
      this.#writeSchemaVersion(SCHEMA_VERSION);
      return;
    }

    if (currentVersion === 6) {
      this.#migrateFromV6ToV7();
      this.#migrateFromV7ToV8();
      this.#writeSchemaVersion(SCHEMA_VERSION);
      return;
    }

    if (currentVersion === 5) {
      this.#migrateFromV5ToV6();
      this.#migrateFromV6ToV7();
      this.#migrateFromV7ToV8();
      this.#writeSchemaVersion(SCHEMA_VERSION);
      return;
    }

    if (currentVersion === 4) {
      this.#migrateFromV4ToV5();
      this.#migrateFromV5ToV6();
      this.#migrateFromV6ToV7();
      this.#migrateFromV7ToV8();
      this.#writeSchemaVersion(SCHEMA_VERSION);
      return;
    }

    throw new Error(`Unsupported database schema version: ${currentVersion}`);
  }

  async close(): Promise<void> {
    await this.kysely.destroy();
  }

  async markUpdateProcessed(updateId: number): Promise<boolean> {
    const inserted = await this.kysely
      .insertInto("processed_updates")
      .values({
        telegram_update_id: updateId
      })
      .onConflict((oc) => oc.column("telegram_update_id").doNothing())
      .executeTakeFirst();

    return Number(inserted.numInsertedOrUpdatedRows ?? 0) > 0;
  }

  async createProvisioningSession(input: {
    telegramChatId: string;
    telegramTopicId: number;
  }): Promise<TopicSession>;
  async createProvisioningSession(input: {
    telegramChatId: string;
    surface: SessionSurface;
  }): Promise<BridgeSession>;
  async createProvisioningSession(input: {
    telegramChatId: string;
    telegramTopicId?: number;
    surface?: SessionSurface;
  }): Promise<TopicSession | BridgeSession> {
    const surface: SessionSurface = input.surface ?? { kind: "topic", topicId: input.telegramTopicId! };
    const sessionRow = sessionSurfaceToRow(surface);
    try {
      await this.kysely
        .insertInto("sessions")
        .values({
          telegram_chat_id: input.telegramChatId,
          ...sessionRow,
          codex_thread_id: null,
          status: "provisioning",
          preferred_mode: "default",
          model: null,
          reasoning_effort: null,
          service_tier: null,
          approval_policy: null,
          sandbox_policy_json: null
        })
        .execute();
    } catch (error) {
      if (!isSqliteUniqueConstraintError(error)) {
        throw error;
      }

      const existing = await this.getSessionBySurfaceAnyStatus(input.telegramChatId, surface);
      if (!existing) {
        throw error;
      }

      if (existing.status !== "provisioning" && existing.status !== "active") {
        await this.kysely
          .updateTable("sessions")
          .set({
            codex_thread_id: null,
            status: "provisioning",
            model: null,
            reasoning_effort: null,
            service_tier: null,
            approval_policy: null,
            sandbox_policy_json: null
          })
          .where("id", "=", existing.id)
          .execute();

        const reclaimed = await this.getSessionById(existing.id);
        if (surface.kind === "topic" && !input.surface) {
          return this.requireTopicSession(reclaimed);
        }

        return reclaimed;
      }

      if (surface.kind === "topic" && !input.surface) {
        return this.requireTopicSession(existing);
      }

      return existing;
    }

    const created = await this.getSessionBySurface(input.telegramChatId, surface);
    if (!created) {
      throw new Error(`Failed to create provisioning session for ${input.telegramChatId}`);
    }

    if (surface.kind === "topic" && !input.surface) {
      return this.requireTopicSession(created);
    }

    return created;
  }

  async activateSession(
    id: number,
    codexThreadId: string
  ): Promise<BridgeSession> {
    await this.kysely
      .updateTable("sessions")
      .set({
        codex_thread_id: codexThreadId,
        status: "active"
      })
      .where("id", "=", id)
      .execute();

    return this.getSessionById(id);
  }

  async updateSessionSettingsBySurface(
    chatId: number | string,
    surface: SessionSurface,
    settings: PersistedThreadSettings
  ): Promise<BridgeSession | undefined> {
    const existing = await this.getSessionBySurface(chatId, surface);
    if (!existing) {
      return undefined;
    }

    await this.kysely
      .updateTable("sessions")
      .set({
        model: settings.model,
        reasoning_effort: settings.reasoningEffort,
        service_tier: settings.serviceTier,
        approval_policy: settings.approvalPolicy ? JSON.stringify(settings.approvalPolicy) : null,
        sandbox_policy_json: settings.sandboxPolicy ? JSON.stringify(settings.sandboxPolicy) : null
      })
      .where("id", "=", existing.id)
      .execute();

    return this.getSessionById(existing.id);
  }

  async updateTopicSessionSettings(
    chatId: number,
    topicId: number,
    settings: PersistedThreadSettings
  ): Promise<TopicSession | undefined> {
    const session = await this.updateSessionSettingsBySurface(chatId, { kind: "topic", topicId }, settings);
    return session ? this.requireTopicSession(session) : undefined;
  }

  async updateRootSessionSettings(
    chatId: number | string,
    settings: PersistedThreadSettings
  ): Promise<BridgeSession | undefined> {
    return this.updateSessionSettingsBySurface(chatId, { kind: "general" }, settings);
  }

  async markSessionErrored(id: number): Promise<void> {
    await this.kysely
      .updateTable("sessions")
      .set({
        status: "errored"
      })
      .where("id", "=", id)
      .execute();
  }

  async getSessionById(id: number): Promise<BridgeSession> {
    const row = await this.kysely
      .selectFrom("sessions")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();

    return mapSession(row);
  }

  async getSessionBySurface(chatId: number | string, surface: SessionSurface): Promise<BridgeSession | undefined> {
    return this.#getSessionBySurface(chatId, surface, ["provisioning", "active"]);
  }

  async getRootSessionByChat(chatId: number | string): Promise<BridgeSession | undefined> {
    return this.getSessionBySurface(chatId, { kind: "general" });
  }

  async getSessionByTopic(chatId: number, topicId: number): Promise<TopicSession | undefined> {
    const session = await this.getSessionBySurface(chatId, { kind: "topic", topicId });
    return session ? this.requireTopicSession(session) : undefined;
  }

  async getSessionBySurfaceAnyStatus(chatId: number | string, surface: SessionSurface): Promise<BridgeSession | undefined> {
    return this.#getSessionBySurface(chatId, surface);
  }

  async #getSessionBySurface(
    chatId: number | string,
    surface: SessionSurface,
    statuses?: SessionStatus[]
  ): Promise<BridgeSession | undefined> {
    let query = this.kysely
      .selectFrom("sessions")
      .selectAll()
      .where("telegram_chat_id", "=", String(chatId))
      .where("surface_kind", "=", surface.kind);

    if (statuses) {
      query = query.where("status", "in", statuses);
    }

    if (surface.kind === "general") {
      query = query.where("telegram_topic_id", "is", null);
    } else {
      query = query.where("telegram_topic_id", "=", surface.topicId);
    }

    const row = await query.executeTakeFirst();
    return row ? mapSession(row) : undefined;
  }

  async archiveSessionBySurface(chatId: number | string, surface: SessionSurface): Promise<BridgeSession | undefined> {
    const existing = await this.getSessionBySurface(chatId, surface);
    if (!existing) {
      return undefined;
    }

    await this.kysely
      .updateTable("sessions")
      .set({
        status: "archived"
      })
      .where("id", "=", existing.id)
      .execute();

    return this.getSessionById(existing.id);
  }

  async archiveSessionByTopic(chatId: number, topicId: number): Promise<TopicSession | undefined> {
    const session = await this.archiveSessionBySurface(chatId, { kind: "topic", topicId });
    return session ? this.requireTopicSession(session) : undefined;
  }

  async listActiveSessions(): Promise<BridgeSession[]> {
    const rows = await this.kysely
      .selectFrom("sessions")
      .selectAll()
      .where("status", "=", "active")
      .execute();

    return rows.map(mapSession);
  }

  async updateSessionPreferredModeForSurface(
    chatId: number | string,
    surface: SessionSurface,
    preferredMode: SessionMode
  ): Promise<BridgeSession | undefined> {
    const existing = await this.getSessionBySurface(chatId, surface);
    if (!existing) {
      return undefined;
    }

    await this.kysely
      .updateTable("sessions")
      .set({
        preferred_mode: preferredMode
      })
      .where("id", "=", existing.id)
      .execute();

    return this.getSessionById(existing.id);
  }

  async updateSessionPreferredMode(chatId: number, topicId: number, preferredMode: SessionMode): Promise<TopicSession | undefined> {
    const session = await this.updateSessionPreferredModeForSurface(chatId, { kind: "topic", topicId }, preferredMode);
    return session ? this.requireTopicSession(session) : undefined;
  }

  async createPendingRequest(input: {
    requestIdJson: string;
    method: string;
    telegramChatId: string;
    telegramTopicId: number | null;
    telegramMessageId: number | null;
    payloadJson: string;
  }): Promise<PendingServerRequest> {
    const timestamp = now();

    await this.kysely
      .insertInto("server_requests")
      .values({
        request_id_json: input.requestIdJson,
        method: input.method,
        telegram_chat_id: input.telegramChatId,
        telegram_topic_id: input.telegramTopicId,
        telegram_message_id: input.telegramMessageId,
        payload_json: input.payloadJson,
        state_json: null,
        status: "pending",
        created_at: timestamp
      })
      .onConflict((oc) =>
        oc.column("request_id_json").doUpdateSet({
          method: input.method,
          telegram_chat_id: input.telegramChatId,
          telegram_topic_id: input.telegramTopicId,
          telegram_message_id: input.telegramMessageId,
          payload_json: input.payloadJson,
          state_json: null,
          status: "pending",
          created_at: timestamp
        })
      )
      .execute();

    return this.getPendingRequest(input.requestIdJson);
  }

  async getPendingRequest(requestIdJson: string): Promise<PendingServerRequest> {
    const row = await this.kysely
      .selectFrom("server_requests")
      .selectAll()
      .where("request_id_json", "=", requestIdJson)
      .executeTakeFirstOrThrow();

    return mapServerRequest(row);
  }

  async getPendingRequestByTopic(chatId: number, topicId: number | null, method?: string): Promise<PendingServerRequest | undefined> {
    let query = this.kysely
      .selectFrom("server_requests")
      .selectAll()
      .where("telegram_chat_id", "=", String(chatId))
      .where("status", "=", "pending");

    query =
      topicId === null
        ? query.where("telegram_topic_id", "is", null)
        : query.where("telegram_topic_id", "=", topicId);

    if (method) {
      query = query.where("method", "=", method);
    }

    const row = await query.orderBy("created_at", "desc").executeTakeFirst();
    return row ? mapServerRequest(row) : undefined;
  }

  async updateRequestState(requestIdJson: string, stateJson: string | null): Promise<PendingServerRequest> {
    await this.kysely
      .updateTable("server_requests")
      .set({
        state_json: stateJson
      })
      .where("request_id_json", "=", requestIdJson)
      .execute();

    return this.getPendingRequest(requestIdJson);
  }

  async resolveRequest(requestIdJson: string): Promise<PendingServerRequest> {
    await this.kysely
      .updateTable("server_requests")
      .set({
        status: "resolved"
      })
      .where("request_id_json", "=", requestIdJson)
      .execute();

    return this.getPendingRequest(requestIdJson);
  }

  async resolveRequestExternally(requestIdJson: string): Promise<PendingServerRequest> {
    await this.kysely
      .updateTable("server_requests")
      .set({
        status: "resolved"
      })
      .where("request_id_json", "=", requestIdJson)
      .execute();

    return this.getPendingRequest(requestIdJson);
  }

  async expireRequest(requestIdJson: string): Promise<PendingServerRequest> {
    await this.kysely
      .updateTable("server_requests")
      .set({
        status: "expired"
      })
      .where("request_id_json", "=", requestIdJson)
      .execute();

    return this.getPendingRequest(requestIdJson);
  }

  async expirePendingRequests(): Promise<number> {
    const result = await this.kysely
      .updateTable("server_requests")
      .set({
        status: "expired"
      })
      .where("status", "=", "pending")
      .executeTakeFirst();

    return Number(result.numUpdatedRows ?? 0);
  }

  async getSessionByCodexThreadId(codexThreadId: string): Promise<BridgeSession | undefined> {
    const row = await this.kysely
      .selectFrom("sessions")
      .selectAll()
      .where("codex_thread_id", "=", codexThreadId)
      .where("status", "=", "active")
      .executeTakeFirst();

    return row ? mapSession(row) : undefined;
  }

  async getServerRequestById(id: number): Promise<PendingServerRequest | undefined> {
    const row = await this.kysely
      .selectFrom("server_requests")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();

    return row ? mapServerRequest(row) : undefined;
  }

  async updateServerRequestMessageId(id: number, telegramMessageId: number): Promise<void> {
    await this.kysely
      .updateTable("server_requests")
      .set({
        telegram_message_id: telegramMessageId
      })
      .where("id", "=", id)
      .execute();
  }

  async countPendingRequests(): Promise<number> {
    const row = await this.kysely
      .selectFrom("server_requests")
      .select(sql<number>`count(*)`.as("count"))
      .where("status", "=", "pending")
      .executeTakeFirstOrThrow();

    return Number(row.count);
  }

  async upsertChatThreadDefaults(
    telegramChatId: string,
    defaults: Omit<ChatThreadDefaults, "telegramChatId">
  ): Promise<ChatThreadDefaults> {
    await this.kysely
      .insertInto("chat_thread_defaults")
      .values({
        telegram_chat_id: telegramChatId,
        root_model: defaults.root.model,
        root_reasoning_effort: defaults.root.reasoningEffort,
        root_service_tier: defaults.root.serviceTier,
        root_approval_policy: defaults.root.approvalPolicy ? JSON.stringify(defaults.root.approvalPolicy) : null,
        root_sandbox_policy_json: defaults.root.sandboxPolicy ? JSON.stringify(defaults.root.sandboxPolicy) : null,
        spawn_model: defaults.spawn.model,
        spawn_reasoning_effort: defaults.spawn.reasoningEffort,
        spawn_service_tier: defaults.spawn.serviceTier,
        spawn_approval_policy: defaults.spawn.approvalPolicy ? JSON.stringify(defaults.spawn.approvalPolicy) : null,
        spawn_sandbox_policy_json: defaults.spawn.sandboxPolicy ? JSON.stringify(defaults.spawn.sandboxPolicy) : null
      })
      .onConflict((oc) =>
        oc.column("telegram_chat_id").doUpdateSet({
          root_model: defaults.root.model,
          root_reasoning_effort: defaults.root.reasoningEffort,
          root_service_tier: defaults.root.serviceTier,
          root_approval_policy: defaults.root.approvalPolicy ? JSON.stringify(defaults.root.approvalPolicy) : null,
          root_sandbox_policy_json: defaults.root.sandboxPolicy ? JSON.stringify(defaults.root.sandboxPolicy) : null,
          spawn_model: defaults.spawn.model,
          spawn_reasoning_effort: defaults.spawn.reasoningEffort,
          spawn_service_tier: defaults.spawn.serviceTier,
          spawn_approval_policy: defaults.spawn.approvalPolicy ? JSON.stringify(defaults.spawn.approvalPolicy) : null,
          spawn_sandbox_policy_json: defaults.spawn.sandboxPolicy ? JSON.stringify(defaults.spawn.sandboxPolicy) : null
        })
      )
      .execute();

    return this.getChatThreadDefaults(telegramChatId).then((value) => {
      if (!value) {
        throw new Error(`Failed to load chat thread defaults for ${telegramChatId}`);
      }
      return value;
    });
  }

  async getChatThreadDefaults(telegramChatId: string): Promise<ChatThreadDefaults | undefined> {
    const row = await this.kysely
      .selectFrom("chat_thread_defaults")
      .selectAll()
      .where("telegram_chat_id", "=", telegramChatId)
      .executeTakeFirst();

    return row ? mapChatThreadDefaults(row) : undefined;
  }

  async createCustomCommand(input: {
    command: string;
    prompt: string;
  }): Promise<CustomCommand> {
    const timestamp = now();

    await this.kysely
      .insertInto("custom_commands")
      .values({
        command: input.command,
        prompt: input.prompt,
        created_at: timestamp,
        updated_at: timestamp
      })
      .execute();

    return this.getCustomCommandByNameOrThrow(input.command);
  }

  async getCustomCommandByName(command: string): Promise<CustomCommand | undefined> {
    const row = await this.kysely
      .selectFrom("custom_commands")
      .selectAll()
      .where("command", "=", command)
      .executeTakeFirst();

    return row ? mapCustomCommand(row) : undefined;
  }

  async listCustomCommands(): Promise<CustomCommand[]> {
    const rows = await this.kysely
      .selectFrom("custom_commands")
      .selectAll()
      .orderBy("command", "asc")
      .execute();

    return rows.map(mapCustomCommand);
  }

  async updateCustomCommandPrompt(command: string, prompt: string): Promise<CustomCommand | undefined> {
    const existing = await this.getCustomCommandByName(command);
    if (!existing) {
      return undefined;
    }

    await this.kysely
      .updateTable("custom_commands")
      .set({
        prompt,
        updated_at: now()
      })
      .where("id", "=", existing.id)
      .execute();

    return this.getCustomCommandByName(command);
  }

  async deleteCustomCommand(command: string): Promise<boolean> {
    const result = await this.kysely
      .deleteFrom("custom_commands")
      .where("command", "=", command)
      .executeTakeFirst();

    return Number(result.numDeletedRows ?? 0) > 0;
  }

  async createPendingCustomCommandAdd(input: {
    command: string;
    prompt: string;
    telegramChatId: string;
  }): Promise<PendingCustomCommandAdd> {
    const timestamp = now();

    await this.kysely
      .insertInto("pending_custom_command_adds")
      .values({
        command: input.command,
        prompt: input.prompt,
        telegram_chat_id: input.telegramChatId,
        telegram_message_id: null,
        status: "pending",
        created_at: timestamp,
        updated_at: timestamp
      })
      .execute();

    const row = await this.kysely
      .selectFrom("pending_custom_command_adds")
      .selectAll()
      .where("command", "=", input.command)
      .where("status", "=", "pending")
      .orderBy("id", "desc")
      .executeTakeFirstOrThrow();

    return mapPendingCustomCommandAdd(row);
  }

  async getPendingCustomCommandAddById(id: number): Promise<PendingCustomCommandAdd | undefined> {
    const row = await this.kysely
      .selectFrom("pending_custom_command_adds")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();

    return row ? mapPendingCustomCommandAdd(row) : undefined;
  }

  async getPendingCustomCommandAddByCommand(command: string): Promise<PendingCustomCommandAdd | undefined> {
    const row = await this.kysely
      .selectFrom("pending_custom_command_adds")
      .selectAll()
      .where("command", "=", command)
      .where("status", "=", "pending")
      .orderBy("id", "desc")
      .executeTakeFirst();

    return row ? mapPendingCustomCommandAdd(row) : undefined;
  }

  async updatePendingCustomCommandAddMessageId(id: number, telegramMessageId: number): Promise<void> {
    await this.kysely
      .updateTable("pending_custom_command_adds")
      .set({
        telegram_message_id: telegramMessageId,
        updated_at: now()
      })
      .where("id", "=", id)
      .execute();
  }

  async updatePendingCustomCommandAddStatus(
    id: number,
    status: PendingCustomCommandStatus
  ): Promise<PendingCustomCommandAdd | undefined> {
    await this.kysely
      .updateTable("pending_custom_command_adds")
      .set({
        status,
        updated_at: now()
      })
      .where("id", "=", id)
      .execute();

    return this.getPendingCustomCommandAddById(id);
  }

  async countPendingCustomCommandAdds(): Promise<number> {
    const row = await this.kysely
      .selectFrom("pending_custom_command_adds")
      .select(sql<number>`count(*)`.as("count"))
      .where("status", "=", "pending")
      .executeTakeFirstOrThrow();

    return Number(row.count);
  }

  async getCustomCommandByNameOrThrow(command: string): Promise<CustomCommand> {
    const row = await this.kysely
      .selectFrom("custom_commands")
      .selectAll()
      .where("command", "=", command)
      .executeTakeFirstOrThrow();

    return mapCustomCommand(row);
  }

  private requireTopicSession(session: BridgeSession): TopicSession {
    if (session.surface.kind !== "topic") {
      throw new Error(`Expected topic session, received ${session.surface.kind}`);
    }

    return {
      id: session.id,
      telegramChatId: session.telegramChatId,
      telegramTopicId: session.surface.topicId,
      codexThreadId: session.codexThreadId,
      status: session.status,
      preferredMode: session.preferredMode,
      settings: session.settings
    };
  }

  #createSchemaV8(): void {
    this.#sqlite.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
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

      CREATE UNIQUE INDEX IF NOT EXISTS sessions_general_unique
        ON sessions (telegram_chat_id, surface_kind)
        WHERE surface_kind = 'general';

      CREATE UNIQUE INDEX IF NOT EXISTS sessions_topic_unique
        ON sessions (telegram_chat_id, telegram_topic_id)
        WHERE surface_kind = 'topic';

      CREATE UNIQUE INDEX IF NOT EXISTS sessions_thread_unique
        ON sessions (codex_thread_id)
        WHERE codex_thread_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS chat_thread_defaults (
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

      CREATE TABLE IF NOT EXISTS server_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id_json TEXT NOT NULL,
        method TEXT NOT NULL,
        telegram_chat_id TEXT NOT NULL,
        telegram_topic_id INTEGER,
        telegram_message_id INTEGER,
        payload_json TEXT NOT NULL,
        state_json TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS server_requests_request_id_unique
        ON server_requests (request_id_json);

      CREATE TABLE IF NOT EXISTS processed_updates (
        telegram_update_id INTEGER PRIMARY KEY
      );

      CREATE TABLE IF NOT EXISTS custom_commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        command TEXT NOT NULL,
        prompt TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS custom_commands_command_unique
        ON custom_commands (command);

      CREATE TABLE IF NOT EXISTS pending_custom_command_adds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        command TEXT NOT NULL,
        prompt TEXT NOT NULL,
        telegram_chat_id TEXT NOT NULL,
        telegram_message_id INTEGER,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS pending_custom_command_adds_status_command_index
        ON pending_custom_command_adds (status, command);
    `);
  }

  #migrateFromV4ToV5(): void {
    this.#sqlite.exec(`
      BEGIN;

      CREATE TABLE IF NOT EXISTS sessions (
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
      )
      SELECT
        ts.id,
        ts.telegram_chat_id,
        'topic',
        ts.telegram_topic_id,
        ts.codex_thread_id,
        ts.status,
        ts.preferred_mode,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL
      FROM topic_sessions ts
      WHERE NOT EXISTS (
        SELECT 1 FROM sessions existing WHERE existing.id = ts.id
      );

      CREATE UNIQUE INDEX IF NOT EXISTS sessions_root_unique
        ON sessions (telegram_chat_id, surface_kind)
        WHERE surface_kind = 'root';

      CREATE UNIQUE INDEX IF NOT EXISTS sessions_topic_unique
        ON sessions (telegram_chat_id, telegram_topic_id)
        WHERE surface_kind = 'topic';

      CREATE UNIQUE INDEX IF NOT EXISTS sessions_thread_unique
        ON sessions (codex_thread_id)
        WHERE codex_thread_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS chat_thread_defaults (
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

      DROP TABLE IF EXISTS server_requests_v5;

      CREATE TABLE server_requests_v5 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id_json TEXT NOT NULL,
        method TEXT NOT NULL,
        telegram_chat_id TEXT NOT NULL,
        telegram_topic_id INTEGER,
        telegram_message_id INTEGER,
        payload_json TEXT NOT NULL,
        state_json TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      INSERT INTO server_requests_v5 (
        id,
        request_id_json,
        method,
        telegram_chat_id,
        telegram_topic_id,
        telegram_message_id,
        payload_json,
        state_json,
        status,
        created_at
      )
      SELECT
        id,
        request_id_json,
        method,
        telegram_chat_id,
        telegram_topic_id,
        telegram_message_id,
        payload_json,
        state_json,
        status,
        created_at
      FROM server_requests;

      DROP TABLE server_requests;
      ALTER TABLE server_requests_v5 RENAME TO server_requests;

      CREATE UNIQUE INDEX IF NOT EXISTS server_requests_request_id_unique
        ON server_requests (request_id_json);

      CREATE TABLE IF NOT EXISTS processed_updates (
        telegram_update_id INTEGER PRIMARY KEY
      );

      CREATE TABLE IF NOT EXISTS custom_commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        command TEXT NOT NULL,
        prompt TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS custom_commands_command_unique
        ON custom_commands (command);

      CREATE TABLE IF NOT EXISTS pending_custom_command_adds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        command TEXT NOT NULL,
        prompt TEXT NOT NULL,
        telegram_chat_id TEXT NOT NULL,
        telegram_message_id INTEGER,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS pending_custom_command_adds_status_command_index
        ON pending_custom_command_adds (status, command);

      COMMIT;
    `);
  }

  #migrateFromV5ToV6(): void {
    this.#sqlite.exec(`
      BEGIN;

      ALTER TABLE sessions ADD COLUMN model TEXT;
      ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT;
      ALTER TABLE sessions ADD COLUMN service_tier TEXT;
      ALTER TABLE sessions ADD COLUMN approval_policy TEXT;
      ALTER TABLE sessions ADD COLUMN sandbox_policy_json TEXT;

      COMMIT;
    `);
  }

  #migrateFromV6ToV7(): void {
    this.#sqlite.exec(`
      BEGIN;

      CREATE TABLE sessions_v7 (
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

      INSERT INTO sessions_v7 (
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
      )
      SELECT
        id,
        telegram_chat_id,
        CASE
          WHEN surface_kind = 'root' THEN 'general'
          ELSE surface_kind
        END,
        telegram_topic_id,
        codex_thread_id,
        status,
        preferred_mode,
        model,
        reasoning_effort,
        service_tier,
        approval_policy,
        sandbox_policy_json
      FROM sessions;

      DROP TABLE sessions;
      ALTER TABLE sessions_v7 RENAME TO sessions;

      CREATE UNIQUE INDEX sessions_general_unique
        ON sessions (telegram_chat_id, surface_kind)
        WHERE surface_kind = 'general';

      CREATE UNIQUE INDEX sessions_topic_unique
        ON sessions (telegram_chat_id, telegram_topic_id)
        WHERE surface_kind = 'topic';

      CREATE UNIQUE INDEX sessions_thread_unique
        ON sessions (codex_thread_id)
        WHERE codex_thread_id IS NOT NULL;

      COMMIT;
    `);
  }

  #migrateFromV7ToV8(): void {
    this.#sqlite.exec(`
      BEGIN;

      CREATE TABLE sessions_v8 (
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

      INSERT INTO sessions_v8 (
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
      )
      SELECT
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
      FROM sessions;

      DROP TABLE sessions;
      ALTER TABLE sessions_v8 RENAME TO sessions;

      CREATE UNIQUE INDEX sessions_general_unique
        ON sessions (telegram_chat_id, surface_kind)
        WHERE surface_kind = 'general';

      CREATE UNIQUE INDEX sessions_topic_unique
        ON sessions (telegram_chat_id, telegram_topic_id)
        WHERE surface_kind = 'topic';

      CREATE UNIQUE INDEX sessions_thread_unique
        ON sessions (codex_thread_id)
        WHERE codex_thread_id IS NOT NULL;

      COMMIT;
    `);
  }

  #readSchemaVersion(): number {
    return Number(this.#sqlite.pragma("user_version", { simple: true }) ?? 0);
  }

  #writeSchemaVersion(version: number): void {
    this.#sqlite.pragma(`user_version = ${version}`);
  }
}
