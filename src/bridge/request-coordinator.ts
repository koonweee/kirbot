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
  allowCurrentQuestionFreeText,
  answerCurrentUserInputQuestion,
  buildApprovalKeyboard,
  buildUserInputPrompt,
  buildUserInputResponse,
  createInitialUserInputState,
  currentQuestionAcceptsFreeText,
  formatCommandApprovalPrompt,
  formatFileChangeApprovalPrompt,
  getCurrentUserInputQuestion,
  normalizeCommandApprovalDecision,
  normalizeFileApprovalDecision,
  parseRequestId,
  parseUserInputState,
  stringifyUserInputState
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

    const [, requestIdText, ...actionParts] = event.data.split(":");
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

    if (request.method === "item/tool/requestUserInput") {
      const callbackText = await this.resolveUserInputAction(request, actionParts);
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: callbackText
      });
      return true;
    }

    await this.resolveApprovalAction(request, actionParts[0] ?? "cancel");
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
    const state = parseUserInputState(pending.stateJson);
    const question = getCurrentUserInputQuestion(payload.questions, state);
    if (!question) {
      return false;
    }

    if (!currentQuestionAcceptsFreeText(question, state)) {
      await this.#messenger.sendMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: "Use the buttons on the pending question, or choose Other… to reply in text."
      });
      return true;
    }

    const answer = message.text.trim();
    if (!answer) {
      await this.#messenger.sendMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: "Reply with text for the pending question."
      });
      return true;
    }

    const nextState = answerCurrentUserInputQuestion(payload.questions, state, [answer]);
    await this.progressUserInputRequest(pending, payload, nextState);
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

    const initialState = createInitialUserInputState();
    await this.database.updateRequestState(pending.requestIdJson, stringifyUserInputState(initialState));
    await this.showUserInputPrompt(
      {
        ...pending,
        stateJson: stringifyUserInputState(initialState)
      },
      request.params,
      initialState
    );
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

  private async resolveUserInputAction(request: PendingServerRequest, actionParts: string[]): Promise<string> {
    const payload = JSON.parse(request.payloadJson) as UserInputServerRequest["params"];
    const state = parseUserInputState(request.stateJson);
    const question = getCurrentUserInputQuestion(payload.questions, state);
    if (!question) {
      return "Request already completed.";
    }

    const [action, value] = actionParts;
    if (action === "other") {
      if (!question.isOther) {
        return "That option is not available.";
      }

      const nextState = allowCurrentQuestionFreeText(payload.questions, state);
      await this.progressUserInputRequest(request, payload, nextState, false);
      return "Reply with your answer.";
    }

    if (action === "opt") {
      const optionIndex = Number.parseInt(value ?? "", 10);
      const option = question.options?.[optionIndex];
      if (!option) {
        return "That option is no longer available.";
      }

      const nextState = answerCurrentUserInputQuestion(payload.questions, state, [option.label]);
      await this.progressUserInputRequest(request, payload, nextState);
      return "Answer recorded.";
    }

    return "Unsupported callback.";
  }

  private async progressUserInputRequest(
    request: PendingServerRequest,
    payload: UserInputServerRequest["params"],
    nextState: ReturnType<typeof parseUserInputState>,
    allowCompletion = true
  ): Promise<void> {
    const serializedState = stringifyUserInputState(nextState);
    const updated = await this.database.updateRequestState(request.requestIdJson, serializedState);
    const currentQuestion = getCurrentUserInputQuestion(payload.questions, nextState);

    if (!currentQuestion && allowCompletion) {
      const response = buildUserInputResponse(payload.questions, nextState);
      await this.codex.respondToUserInputRequest(parseRequestId(request.requestIdJson), response);
      await this.database.resolveRequest(request.requestIdJson, JSON.stringify(response));
      await this.finishUserInputRequest(updated);
      return;
    }

    await this.showUserInputPrompt(
      {
        ...updated,
        stateJson: serializedState
      },
      payload,
      nextState
    );
  }

  private async showUserInputPrompt(
    request: PendingServerRequest,
    payload: UserInputServerRequest["params"],
    state: ReturnType<typeof parseUserInputState>
  ): Promise<void> {
    const chatId = Number.parseInt(request.telegramChatId, 10);
    const prompt = buildUserInputPrompt(request.id, payload.questions, state);

    if (request.telegramMessageId) {
      await this.telegram.editMessageText(chatId, request.telegramMessageId, prompt.text, {
        message_thread_id: request.telegramTopicId,
        ...(prompt.replyMarkup ? { reply_markup: prompt.replyMarkup } : {})
      });
      return;
    }

    const message = await this.#messenger.sendMessage({
      chatId,
      topicId: request.telegramTopicId,
      text: prompt.text,
      ...(prompt.replyMarkup ? { replyMarkup: prompt.replyMarkup } : {})
    });

    await this.database.updateServerRequestMessageId(request.id, message.messageId);
  }

  private async finishUserInputRequest(request: PendingServerRequest): Promise<void> {
    if (!request.telegramMessageId) {
      await this.#messenger.sendMessage({
        chatId: Number.parseInt(request.telegramChatId, 10),
        topicId: request.telegramTopicId,
        text: "Sent your answers to Codex."
      });
      return;
    }

    await this.telegram.editMessageText(
      Number.parseInt(request.telegramChatId, 10),
      request.telegramMessageId,
      "Sent your answers to Codex.",
      {
        message_thread_id: request.telegramTopicId
      }
    );
  }

  private async findSessionForRequest(request: ServerRequest): Promise<TopicSession | undefined> {
    const threadId = "threadId" in request.params && typeof request.params.threadId === "string" ? request.params.threadId : null;
    if (!threadId) {
      return undefined;
    }

    return this.database.getSessionByCodexThreadId(threadId);
  }
}
