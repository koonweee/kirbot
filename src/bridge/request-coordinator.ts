import type { AppConfig } from "../config";
import type { ApprovalServerRequest, UserInputServerRequest } from "../codex";
import { BridgeDatabase } from "../db";
import type { PendingServerRequest, TopicSession, UserTurnMessage } from "../domain";
import type { RequestId } from "../generated/codex/RequestId";
import type { ServerRequest } from "../generated/codex/ServerRequest";
import type { CommandExecutionApprovalDecision } from "../generated/codex/v2/CommandExecutionApprovalDecision";
import type { FileChangeApprovalDecision } from "../generated/codex/v2/FileChangeApprovalDecision";
import type { ToolRequestUserInputResponse } from "../generated/codex/v2/ToolRequestUserInputResponse";
import type { TelegramApi } from "../telegram-messenger";
import { TelegramMessenger } from "../telegram-messenger";
import {
  buildApprovalKeyboard,
  formatCommandApprovalPrompt,
  formatFileChangeApprovalPrompt,
  normalizeCommandApprovalDecision,
  normalizeFileApprovalDecision,
  parseRequestId,
  parseUserInputResponse
} from "./requests";
import { buildStatusDraft } from "./presentation";

type BridgeCodexRequestsApi = {
  respondToCommandApproval(id: RequestId, response: { decision: CommandExecutionApprovalDecision }): Promise<void>;
  respondToFileChangeApproval(id: RequestId, response: { decision: FileChangeApprovalDecision }): Promise<void>;
  respondToUserInputRequest(id: RequestId, response: ToolRequestUserInputResponse): Promise<void>;
  respondUnsupportedRequest(id: RequestId, message: string): Promise<void>;
};

type CallbackQueryEvent = {
  callbackQueryId: string;
  data: string;
  chatId: number;
  topicId: number | null;
};

export class BridgeRequestCoordinator {
  readonly #messenger: TelegramMessenger;

  constructor(
    private readonly config: AppConfig,
    private readonly database: BridgeDatabase,
    private readonly telegram: TelegramApi,
    private readonly codex: BridgeCodexRequestsApi,
    private readonly updateTurnStatus: (
      turnId: string,
      statusDraft: ReturnType<typeof buildStatusDraft>,
      force?: boolean,
      preserveDetails?: boolean
    ) => Promise<void>
  ) {
    this.#messenger = new TelegramMessenger(telegram);
  }

  async handleCallbackQuery(event: CallbackQueryEvent): Promise<boolean> {
    if (!event.data.startsWith("req:")) {
      return false;
    }

    const [, requestIdText, action] = event.data.split(":");
    const requestId = Number.parseInt(requestIdText ?? "", 10);
    if (Number.isNaN(requestId)) {
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: "Invalid callback payload."
      });
      return true;
    }

    const request = await this.database.getServerRequestById(requestId);
    if (!request || request.status !== "pending") {
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: "This request is no longer pending."
      });
      return true;
    }

    await this.resolveApprovalAction(request, action ?? "cancel");
    await this.telegram.answerCallbackQuery(event.callbackQueryId, {
      text: "Request updated."
    });
    return true;
  }

  async handleServerRequest(request: ServerRequest): Promise<void> {
    const session = await this.findSessionForRequest(request);
    if (!session || !session.codexThreadId) {
      await this.codex.respondUnsupportedRequest(request.id, "No Telegram topic mapping exists for this request.");
      return;
    }

    if (
      request.method === "item/commandExecution/requestApproval" ||
      request.method === "item/fileChange/requestApproval"
    ) {
      await this.handleApprovalRequest(session, request);
      return;
    }

    if (request.method === "item/tool/requestUserInput") {
      await this.handleUserInputRequest(session, request);
      return;
    }

    await this.codex.respondUnsupportedRequest(request.id, `Unsupported server request method: ${request.method}`);
  }

  async tryResolveUserInput(message: UserTurnMessage): Promise<boolean> {
    if (message.topicId === null) {
      return false;
    }

    const pending = await this.database.getPendingRequestByTopic(message.chatId, message.topicId, "item/tool/requestUserInput");
    if (!pending) {
      return false;
    }

    const payload = JSON.parse(pending.payloadJson) as UserInputServerRequest["params"];
    const response = parseUserInputResponse(message.text, payload.questions);

    await this.codex.respondToUserInputRequest(parseRequestId(pending.requestIdJson), response);
    await this.database.resolveRequest(pending.requestIdJson, JSON.stringify(response));
    await this.#messenger.sendMessage({
      chatId: message.chatId,
      topicId: message.topicId,
      text: "Sent your answer to Codex."
    });
    return true;
  }

  private async handleApprovalRequest(session: TopicSession, request: ApprovalServerRequest): Promise<void> {
    const codexThreadId = session.codexThreadId;
    if (!codexThreadId) {
      throw new Error("Expected session.codexThreadId for approval request handling");
    }

    await this.updateTurnStatus(
      request.params.turnId,
      buildStatusDraft("waiting", request.method === "item/commandExecution/requestApproval" ? "approval" : "file approval"),
      true
    );

    const promptText =
      request.method === "item/commandExecution/requestApproval"
        ? formatCommandApprovalPrompt(request.params)
        : formatFileChangeApprovalPrompt(request.params);

    const pending = await this.database.createPendingRequest({
      requestIdJson: JSON.stringify(request.id),
      method: request.method,
      telegramChatId: session.telegramChatId,
      telegramTopicId: session.telegramTopicId,
      telegramMessageId: null,
      codexThreadId,
      turnId: request.params.turnId,
      itemId: request.params.itemId,
      payloadJson: JSON.stringify(request.params)
    });

    const message = await this.#messenger.sendMessage({
      chatId: Number.parseInt(session.telegramChatId, 10),
      topicId: session.telegramTopicId,
      text: promptText,
      replyMarkup: buildApprovalKeyboard(
        pending.id,
        request.method === "item/commandExecution/requestApproval" ? request.params.availableDecisions ?? null : null
      )
    });

    await this.database.updateServerRequestMessageId(pending.id, message.messageId);
  }

  private async handleUserInputRequest(session: TopicSession, request: UserInputServerRequest): Promise<void> {
    const codexThreadId = session.codexThreadId;
    if (!codexThreadId) {
      throw new Error("Expected session.codexThreadId for user-input request handling");
    }

    await this.updateTurnStatus(request.params.turnId, buildStatusDraft("waiting", "input"), true);

    const promptText = [
      "Codex is asking for user input.",
      ...request.params.questions.map((question) =>
        question.options?.length
          ? `- ${question.id}: ${question.question} Options: ${question.options.map((option) => option.label).join(", ")}`
          : `- ${question.id}: ${question.question}`
      ),
      "",
      "Reply in this topic. For one question, send plain text. For multiple questions, send JSON like {\"question_id\": \"answer\"}."
    ].join("\n");

    const message = await this.#messenger.sendMessage({
      chatId: Number.parseInt(session.telegramChatId, 10),
      topicId: session.telegramTopicId,
      text: promptText
    });

    await this.database.createPendingRequest({
      requestIdJson: JSON.stringify(request.id),
      method: request.method,
      telegramChatId: session.telegramChatId,
      telegramTopicId: session.telegramTopicId,
      telegramMessageId: message.messageId,
      codexThreadId,
      turnId: request.params.turnId,
      itemId: request.params.itemId,
      payloadJson: JSON.stringify(request.params)
    });
  }

  private async resolveApprovalAction(request: PendingServerRequest, action: string): Promise<void> {
    const requestId = parseRequestId(request.requestIdJson);
    const chatId = Number.parseInt(request.telegramChatId, 10);

    if (request.method === "item/commandExecution/requestApproval") {
      const response = {
        decision: normalizeCommandApprovalDecision(action)
      };
      await this.codex.respondToCommandApproval(requestId, response);
      await this.database.resolveRequest(request.requestIdJson, JSON.stringify(response));
    } else if (request.method === "item/fileChange/requestApproval") {
      const response = {
        decision: normalizeFileApprovalDecision(action)
      };
      await this.codex.respondToFileChangeApproval(requestId, response);
      await this.database.resolveRequest(request.requestIdJson, JSON.stringify(response));
    } else {
      await this.codex.respondUnsupportedRequest(requestId, `Unsupported approval action for ${request.method}`);
      return;
    }

    if (request.telegramMessageId) {
      await this.telegram.editMessageText(
        chatId,
        request.telegramMessageId,
        `Resolved ${request.method} with "${action}".`,
        {
          message_thread_id: request.telegramTopicId
        }
      );
    }
  }

  private async findSessionForRequest(request: ServerRequest): Promise<TopicSession | undefined> {
    const threadId = "threadId" in request.params && typeof request.params.threadId === "string" ? request.params.threadId : null;
    if (!threadId) {
      return undefined;
    }

    return this.database.getSessionByCodexThreadId(threadId);
  }
}
