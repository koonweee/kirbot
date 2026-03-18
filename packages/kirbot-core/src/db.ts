import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";
import { sql } from "kysely";
import { Generated, Kysely, Selectable, SqliteDialect } from "kysely";

import type {
  PendingServerRequest,
  SessionMode,
  SessionStatus,
  TopicSession
} from "./domain";

type TimestampString = string;
const SCHEMA_VERSION = 1;

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

type ProcessedUpdatesTable = {
  telegram_update_id: Generated<number>;
};

export type DatabaseSchema = {
  topic_sessions: TopicSessionsTable;
  server_requests: ServerRequestsTable;
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

  async activateSession(id: number, codexThreadId: string): Promise<TopicSession> {
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

  #readSchemaVersion(): number {
    return Number(this.#sqlite.pragma("user_version", { simple: true }) ?? 0);
  }

  #writeSchemaVersion(version: number): void {
    this.#sqlite.pragma(`user_version = ${version}`);
  }

  #dropAllTables(): void {
    this.#sqlite.exec(`
      DROP TABLE IF EXISTS processed_updates;
      DROP TABLE IF EXISTS server_requests;
      DROP TABLE IF EXISTS turn_messages;
      DROP TABLE IF EXISTS topic_sessions;
    `);
  }
}
