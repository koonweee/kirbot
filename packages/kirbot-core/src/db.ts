import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";
import { sql } from "kysely";
import { Generated, Kysely, Selectable, SqliteDialect } from "kysely";

import type {
  CustomCommand,
  PendingCustomCommandAdd,
  PendingCustomCommandStatus,
  PendingServerRequest,
  SessionMode,
  SessionStatus,
  TopicSession
} from "./domain";

type TimestampString = string;
const SCHEMA_VERSION = 4;

type TopicSessionsTable = {
  id: Generated<number>;
  telegram_chat_id: string;
  telegram_topic_id: number;
  codex_thread_id: string | null;
  status: SessionStatus;
  preferred_mode: SessionMode;
};

type ServerRequestsTable = {
  id: Generated<number>;
  request_id_json: string;
  method: string;
  telegram_chat_id: string;
  telegram_topic_id: number;
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
  topic_sessions: TopicSessionsTable;
  server_requests: ServerRequestsTable;
  custom_commands: CustomCommandsTable;
  pending_custom_command_adds: PendingCustomCommandAddsTable;
  processed_updates: ProcessedUpdatesTable;
};

function now(): string {
  return new Date().toISOString();
}

function mapTopicSession(row: Selectable<TopicSessionsTable>): TopicSession {
  return {
    id: row.id,
    telegramChatId: row.telegram_chat_id,
    telegramTopicId: row.telegram_topic_id,
    codexThreadId: row.codex_thread_id,
    status: row.status,
    preferredMode: row.preferred_mode
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
    if (currentVersion !== SCHEMA_VERSION) {
      this.#dropAllTables();
    }

    await this.kysely.schema
      .createTable("topic_sessions")
      .ifNotExists()
      .addColumn("id", "integer", (column) => column.primaryKey().autoIncrement())
      .addColumn("telegram_chat_id", "text", (column) => column.notNull())
      .addColumn("telegram_topic_id", "integer", (column) => column.notNull())
      .addColumn("codex_thread_id", "text")
      .addColumn("status", "text", (column) => column.notNull())
      .addColumn("preferred_mode", "text", (column) => column.notNull().defaultTo("default"))
      .execute();

    await this.kysely.schema
      .createIndex("topic_sessions_chat_topic_unique")
      .ifNotExists()
      .on("topic_sessions")
      .columns(["telegram_chat_id", "telegram_topic_id"])
      .unique()
      .execute();

    await this.kysely.schema
      .createIndex("topic_sessions_thread_unique")
      .ifNotExists()
      .on("topic_sessions")
      .column("codex_thread_id")
      .unique()
      .execute();

    await this.kysely.schema
      .createTable("server_requests")
      .ifNotExists()
      .addColumn("id", "integer", (column) => column.primaryKey().autoIncrement())
      .addColumn("request_id_json", "text", (column) => column.notNull())
      .addColumn("method", "text", (column) => column.notNull())
      .addColumn("telegram_chat_id", "text", (column) => column.notNull())
      .addColumn("telegram_topic_id", "integer", (column) => column.notNull())
      .addColumn("telegram_message_id", "integer")
      .addColumn("payload_json", "text", (column) => column.notNull())
      .addColumn("state_json", "text")
      .addColumn("status", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .execute();

    await this.kysely.schema
      .createIndex("server_requests_request_id_unique")
      .ifNotExists()
      .on("server_requests")
      .column("request_id_json")
      .unique()
      .execute();

    await this.kysely.schema
      .createTable("processed_updates")
      .ifNotExists()
      .addColumn("telegram_update_id", "integer", (column) => column.primaryKey())
      .execute();

    await this.kysely.schema
      .createTable("custom_commands")
      .ifNotExists()
      .addColumn("id", "integer", (column) => column.primaryKey().autoIncrement())
      .addColumn("command", "text", (column) => column.notNull())
      .addColumn("prompt", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .execute();

    await this.kysely.schema
      .createIndex("custom_commands_command_unique")
      .ifNotExists()
      .on("custom_commands")
      .column("command")
      .unique()
      .execute();

    await this.kysely.schema
      .createTable("pending_custom_command_adds")
      .ifNotExists()
      .addColumn("id", "integer", (column) => column.primaryKey().autoIncrement())
      .addColumn("command", "text", (column) => column.notNull())
      .addColumn("prompt", "text", (column) => column.notNull())
      .addColumn("telegram_chat_id", "text", (column) => column.notNull())
      .addColumn("telegram_message_id", "integer")
      .addColumn("status", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .execute();

    await this.kysely.schema
      .createIndex("pending_custom_command_adds_status_command_index")
      .ifNotExists()
      .on("pending_custom_command_adds")
      .columns(["status", "command"])
      .execute();

    this.#writeSchemaVersion(SCHEMA_VERSION);
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
  }): Promise<TopicSession> {
    await this.kysely
      .insertInto("topic_sessions")
      .values({
        telegram_chat_id: input.telegramChatId,
        telegram_topic_id: input.telegramTopicId,
        codex_thread_id: null,
        status: "provisioning",
        preferred_mode: "default"
      })
      .execute();

    const row = await this.kysely
      .selectFrom("topic_sessions")
      .selectAll()
      .where("telegram_chat_id", "=", input.telegramChatId)
      .where("telegram_topic_id", "=", input.telegramTopicId)
      .executeTakeFirstOrThrow();

    return mapTopicSession(row);
  }

  async activateSession(
    id: number,
    codexThreadId: string
  ): Promise<TopicSession> {
    await this.kysely
      .updateTable("topic_sessions")
      .set({
        codex_thread_id: codexThreadId,
        status: "active"
      })
      .where("id", "=", id)
      .execute();

    return this.getSessionById(id);
  }

  async markSessionErrored(id: number): Promise<void> {
    await this.kysely
      .updateTable("topic_sessions")
      .set({
        status: "errored"
      })
      .where("id", "=", id)
      .execute();
  }

  async getSessionById(id: number): Promise<TopicSession> {
    const row = await this.kysely
      .selectFrom("topic_sessions")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();

    return mapTopicSession(row);
  }

  async getSessionByTopic(chatId: number, topicId: number): Promise<TopicSession | undefined> {
    const row = await this.kysely
      .selectFrom("topic_sessions")
      .selectAll()
      .where("telegram_chat_id", "=", String(chatId))
      .where("telegram_topic_id", "=", topicId)
      .where("status", "in", ["provisioning", "active"])
      .executeTakeFirst();

    return row ? mapTopicSession(row) : undefined;
  }

  async archiveSessionByTopic(chatId: number, topicId: number): Promise<TopicSession | undefined> {
    const existing = await this.getSessionByTopic(chatId, topicId);
    if (!existing) {
      return undefined;
    }

    await this.kysely
      .updateTable("topic_sessions")
      .set({
        status: "archived"
      })
      .where("id", "=", existing.id)
      .execute();

    return this.getSessionById(existing.id);
  }

  async listActiveSessions(): Promise<TopicSession[]> {
    const rows = await this.kysely
      .selectFrom("topic_sessions")
      .selectAll()
      .where("status", "=", "active")
      .execute();

    return rows.map(mapTopicSession);
  }

  async updateSessionPreferredMode(chatId: number, topicId: number, preferredMode: SessionMode): Promise<TopicSession | undefined> {
    const existing = await this.getSessionByTopic(chatId, topicId);
    if (!existing) {
      return undefined;
    }

    await this.kysely
      .updateTable("topic_sessions")
      .set({
        preferred_mode: preferredMode
      })
      .where("id", "=", existing.id)
      .execute();

    return this.getSessionById(existing.id);
  }

  async createPendingRequest(input: {
    requestIdJson: string;
    method: string;
    telegramChatId: string;
    telegramTopicId: number;
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

  async getPendingRequestByTopic(chatId: number, topicId: number, method?: string): Promise<PendingServerRequest | undefined> {
    let query = this.kysely
      .selectFrom("server_requests")
      .selectAll()
      .where("telegram_chat_id", "=", String(chatId))
      .where("telegram_topic_id", "=", topicId)
      .where("status", "=", "pending");

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

  async getSessionByCodexThreadId(codexThreadId: string): Promise<TopicSession | undefined> {
    const row = await this.kysely
      .selectFrom("topic_sessions")
      .selectAll()
      .where("codex_thread_id", "=", codexThreadId)
      .where("status", "=", "active")
      .executeTakeFirst();

    return row ? mapTopicSession(row) : undefined;
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

  #readSchemaVersion(): number {
    return Number(this.#sqlite.pragma("user_version", { simple: true }) ?? 0);
  }

  #writeSchemaVersion(version: number): void {
    this.#sqlite.pragma(`user_version = ${version}`);
  }

  #dropAllTables(): void {
    this.#sqlite.exec(`
      DROP TABLE IF EXISTS processed_updates;
      DROP TABLE IF EXISTS pending_custom_command_adds;
      DROP TABLE IF EXISTS custom_commands;
      DROP TABLE IF EXISTS server_requests;
      DROP TABLE IF EXISTS turn_messages;
      DROP TABLE IF EXISTS topic_sessions;
    `);
  }
}
