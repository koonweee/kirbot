import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";
import { Generated, Kysely, Selectable, SqliteDialect } from "kysely";

import type {
  PendingServerRequest,
  SessionMode,
  SessionStatus,
  TopicSession,
  TurnMessageRecord
} from "./domain";

type TimestampString = string;

type TopicSessionsTable = {
  id: Generated<number>;
  telegram_chat_id: string;
  telegram_topic_id: number;
  root_message_id: number | null;
  codex_thread_id: string | null;
  created_by_user_id: number;
  title: string;
  status: SessionStatus;
  preferred_mode: SessionMode;
  created_at: TimestampString;
  updated_at: TimestampString;
  archived_at: TimestampString | null;
};

type TurnMessagesTable = {
  id: Generated<number>;
  telegram_update_id: number;
  telegram_chat_id: string;
  telegram_topic_id: number;
  codex_thread_id: string;
  codex_turn_id: string;
  draft_id: number;
  final_message_id: number | null;
  stream_text: string;
  status: "streaming" | "completed" | "failed" | "interrupted";
  resolved_assistant_text: string;
  resolved_plan_text: string;
  created_at: TimestampString;
  updated_at: TimestampString;
};

type ServerRequestsTable = {
  id: Generated<number>;
  request_id_json: string;
  method: string;
  telegram_chat_id: string;
  telegram_topic_id: number;
  telegram_message_id: number | null;
  codex_thread_id: string;
  turn_id: string | null;
  item_id: string | null;
  payload_json: string;
  state_json: string | null;
  response_json: string | null;
  status: "pending" | "resolved" | "expired";
  created_at: TimestampString;
  updated_at: TimestampString;
};

type ProcessedUpdatesTable = {
  telegram_update_id: Generated<number>;
  processed_at: TimestampString;
};

export type DatabaseSchema = {
  topic_sessions: TopicSessionsTable;
  turn_messages: TurnMessagesTable;
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
    rootMessageId: row.root_message_id,
    codexThreadId: row.codex_thread_id,
    createdByUserId: row.created_by_user_id,
    title: row.title,
    status: row.status,
    preferredMode: row.preferred_mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at
  };
}

function mapTurnMessage(row: Selectable<TurnMessagesTable>): TurnMessageRecord {
  return {
    id: row.id,
    telegramUpdateId: row.telegram_update_id,
    telegramChatId: row.telegram_chat_id,
    telegramTopicId: row.telegram_topic_id,
    codexThreadId: row.codex_thread_id,
    codexTurnId: row.codex_turn_id,
    draftId: row.draft_id,
    finalMessageId: row.final_message_id,
    streamText: row.stream_text,
    status: row.status,
    resolvedAssistantText: row.resolved_assistant_text,
    resolvedPlanText: row.resolved_plan_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at
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
    codexThreadId: row.codex_thread_id,
    turnId: row.turn_id,
    itemId: row.item_id,
    payloadJson: row.payload_json,
    stateJson: row.state_json,
    responseJson: row.response_json,
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
    await this.kysely.schema
      .createTable("topic_sessions")
      .ifNotExists()
      .addColumn("id", "integer", (column) => column.primaryKey().autoIncrement())
      .addColumn("telegram_chat_id", "text", (column) => column.notNull())
      .addColumn("telegram_topic_id", "integer", (column) => column.notNull())
      .addColumn("root_message_id", "integer")
      .addColumn("codex_thread_id", "text")
      .addColumn("created_by_user_id", "integer", (column) => column.notNull())
      .addColumn("title", "text", (column) => column.notNull())
      .addColumn("status", "text", (column) => column.notNull())
      .addColumn("preferred_mode", "text", (column) => column.notNull().defaultTo("default"))
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addColumn("archived_at", "text")
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
      .createTable("turn_messages")
      .ifNotExists()
      .addColumn("id", "integer", (column) => column.primaryKey().autoIncrement())
      .addColumn("telegram_update_id", "integer", (column) => column.notNull())
      .addColumn("telegram_chat_id", "text", (column) => column.notNull())
      .addColumn("telegram_topic_id", "integer", (column) => column.notNull())
      .addColumn("codex_thread_id", "text", (column) => column.notNull())
      .addColumn("codex_turn_id", "text", (column) => column.notNull())
      .addColumn("draft_id", "integer", (column) => column.notNull())
      .addColumn("final_message_id", "integer")
      .addColumn("stream_text", "text", (column) => column.notNull())
      .addColumn("status", "text", (column) => column.notNull())
      .addColumn("resolved_assistant_text", "text", (column) => column.notNull().defaultTo(""))
      .addColumn("resolved_plan_text", "text", (column) => column.notNull().defaultTo(""))
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .execute();

    await this.kysely.schema
      .createIndex("turn_messages_turn_unique")
      .ifNotExists()
      .on("turn_messages")
      .column("codex_turn_id")
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
      .addColumn("codex_thread_id", "text", (column) => column.notNull())
      .addColumn("turn_id", "text")
      .addColumn("item_id", "text")
      .addColumn("payload_json", "text", (column) => column.notNull())
      .addColumn("state_json", "text")
      .addColumn("response_json", "text")
      .addColumn("status", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
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
      .addColumn("processed_at", "text", (column) => column.notNull())
      .execute();

    this.ensureColumn("topic_sessions", "preferred_mode", "TEXT NOT NULL DEFAULT 'default'");
    this.ensureColumn("turn_messages", "resolved_assistant_text", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("turn_messages", "resolved_plan_text", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("server_requests", "state_json", "TEXT");
  }

  async close(): Promise<void> {
    await this.kysely.destroy();
  }

  async markUpdateProcessed(updateId: number): Promise<boolean> {
    const inserted = await this.kysely
      .insertInto("processed_updates")
      .values({
        telegram_update_id: updateId,
        processed_at: now()
      })
      .onConflict((oc) => oc.column("telegram_update_id").doNothing())
      .executeTakeFirst();

    return Number(inserted.numInsertedOrUpdatedRows ?? 0) > 0;
  }

  async createProvisioningSession(input: {
    telegramChatId: string;
    telegramTopicId: number;
    rootMessageId: number;
    createdByUserId: number;
    title: string;
  }): Promise<TopicSession> {
    const timestamp = now();
    await this.kysely
      .insertInto("topic_sessions")
      .values({
        telegram_chat_id: input.telegramChatId,
        telegram_topic_id: input.telegramTopicId,
        root_message_id: input.rootMessageId,
        codex_thread_id: null,
        created_by_user_id: input.createdByUserId,
        title: input.title,
        status: "provisioning",
        preferred_mode: "default",
        created_at: timestamp,
        updated_at: timestamp,
        archived_at: null
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
    const timestamp = now();

    await this.kysely
      .updateTable("topic_sessions")
      .set({
        codex_thread_id: codexThreadId,
        status: "active",
        updated_at: timestamp
      })
      .where("id", "=", id)
      .execute();

    return this.getSessionById(id);
  }

  async markSessionErrored(id: number): Promise<void> {
    await this.kysely
      .updateTable("topic_sessions")
      .set({
        status: "errored",
        updated_at: now()
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

    const timestamp = now();
    await this.kysely
      .updateTable("topic_sessions")
      .set({
        status: "archived",
        updated_at: timestamp,
        archived_at: timestamp
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
        preferred_mode: preferredMode,
        updated_at: now()
      })
      .where("id", "=", existing.id)
      .execute();

    return this.getSessionById(existing.id);
  }

  async recordTurnStart(input: {
    telegramUpdateId: number;
    telegramChatId: string;
    telegramTopicId: number;
    codexThreadId: string;
    codexTurnId: string;
    draftId: number;
  }): Promise<TurnMessageRecord> {
    const timestamp = now();
    await this.kysely
      .insertInto("turn_messages")
      .values({
        telegram_update_id: input.telegramUpdateId,
        telegram_chat_id: input.telegramChatId,
        telegram_topic_id: input.telegramTopicId,
        codex_thread_id: input.codexThreadId,
        codex_turn_id: input.codexTurnId,
        draft_id: input.draftId,
        final_message_id: null,
        stream_text: "",
        status: "streaming",
        resolved_assistant_text: "",
        resolved_plan_text: "",
        created_at: timestamp,
        updated_at: timestamp
      })
      .execute();

    return this.getTurnById(input.codexTurnId);
  }

  async appendTurnStream(turnId: string, streamText: string): Promise<TurnMessageRecord | undefined> {
    const existing = await this.getTurnByIdOptional(turnId);
    if (!existing) {
      return undefined;
    }

    await this.kysely
      .updateTable("turn_messages")
      .set({
        stream_text: streamText,
        updated_at: now()
      })
      .where("codex_turn_id", "=", turnId)
      .execute();

    return this.getTurnById(turnId);
  }

  async completeTurn(
    turnId: string,
    finalMessageId: number | null,
    status: "completed" | "failed" | "interrupted",
    resolvedText?: {
      assistantText: string;
      planText: string;
    }
  ): Promise<TurnMessageRecord | undefined> {
    const existing = await this.getTurnByIdOptional(turnId);
    if (!existing) {
      return undefined;
    }

    await this.kysely
      .updateTable("turn_messages")
      .set({
        final_message_id: finalMessageId,
        status,
        ...(resolvedText
          ? {
              resolved_assistant_text: resolvedText.assistantText,
              resolved_plan_text: resolvedText.planText
            }
          : {}),
        updated_at: now()
      })
      .where("codex_turn_id", "=", turnId)
      .execute();

    return this.getTurnById(turnId);
  }

  async getTurnById(turnId: string): Promise<TurnMessageRecord> {
    const row = await this.kysely
      .selectFrom("turn_messages")
      .selectAll()
      .where("codex_turn_id", "=", turnId)
      .executeTakeFirstOrThrow();

    return mapTurnMessage(row);
  }

  async getTurnByIdOptional(turnId: string): Promise<TurnMessageRecord | undefined> {
    const row = await this.kysely
      .selectFrom("turn_messages")
      .selectAll()
      .where("codex_turn_id", "=", turnId)
      .executeTakeFirst();

    return row ? mapTurnMessage(row) : undefined;
  }

  async getLatestCompletedTurnByTopic(chatId: number, topicId: number): Promise<TurnMessageRecord | undefined> {
    const row = await this.kysely
      .selectFrom("turn_messages")
      .selectAll()
      .where("telegram_chat_id", "=", String(chatId))
      .where("telegram_topic_id", "=", topicId)
      .where("status", "=", "completed")
      .orderBy("updated_at", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst();

    return row ? mapTurnMessage(row) : undefined;
  }

  async createPendingRequest(input: {
    requestIdJson: string;
    method: string;
    telegramChatId: string;
    telegramTopicId: number;
    telegramMessageId: number | null;
    codexThreadId: string;
    turnId: string | null;
    itemId: string | null;
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
        codex_thread_id: input.codexThreadId,
        turn_id: input.turnId,
        item_id: input.itemId,
        payload_json: input.payloadJson,
        state_json: null,
        response_json: null,
        status: "pending",
        created_at: timestamp,
        updated_at: timestamp
      })
      .onConflict((oc) =>
        oc.column("request_id_json").doUpdateSet({
          method: input.method,
          telegram_chat_id: input.telegramChatId,
          telegram_topic_id: input.telegramTopicId,
          telegram_message_id: input.telegramMessageId,
          codex_thread_id: input.codexThreadId,
          turn_id: input.turnId,
          item_id: input.itemId,
          payload_json: input.payloadJson,
          state_json: null,
          response_json: null,
          status: "pending",
          updated_at: timestamp
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
        state_json: stateJson,
        updated_at: now()
      })
      .where("request_id_json", "=", requestIdJson)
      .execute();

    return this.getPendingRequest(requestIdJson);
  }

  async resolveRequest(requestIdJson: string, responseJson: string): Promise<PendingServerRequest> {
    await this.kysely
      .updateTable("server_requests")
      .set({
        response_json: responseJson,
        status: "resolved",
        updated_at: now()
      })
      .where("request_id_json", "=", requestIdJson)
      .execute();

    return this.getPendingRequest(requestIdJson);
  }

  async expireRequest(requestIdJson: string, responseJson: string | null = null): Promise<PendingServerRequest> {
    await this.kysely
      .updateTable("server_requests")
      .set({
        response_json: responseJson,
        status: "expired",
        updated_at: now()
      })
      .where("request_id_json", "=", requestIdJson)
      .execute();

    return this.getPendingRequest(requestIdJson);
  }

  async expirePendingRequests(responseJson: string | null = null): Promise<number> {
    const result = await this.kysely
      .updateTable("server_requests")
      .set({
        response_json: responseJson,
        status: "expired",
        updated_at: now()
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
        telegram_message_id: telegramMessageId,
        updated_at: now()
      })
      .where("id", "=", id)
      .execute();
  }

  private ensureColumn(tableName: string, columnName: string, definition: string): void {
    const columns = this.#sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === columnName)) {
      return;
    }

    this.#sqlite.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}
