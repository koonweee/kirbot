import type { ApprovalServerRequest, UserInputServerRequest } from "@kirbot/codex-client";
import { BridgeDatabase } from "../db";
import type { BridgeSession, PendingServerRequest, UserTurnMessage } from "../domain";
import type { RequestId } from "@kirbot/codex-client/generated/codex/RequestId";
import type { ServerRequest } from "@kirbot/codex-client/generated/codex/ServerRequest";
import type { CommandExecutionApprovalDecision } from "@kirbot/codex-client/generated/codex/v2/CommandExecutionApprovalDecision";
import type { FileChangeApprovalDecision } from "@kirbot/codex-client/generated/codex/v2/FileChangeApprovalDecision";
import type { PermissionsRequestApprovalResponse } from "@kirbot/codex-client/generated/codex/v2/PermissionsRequestApprovalResponse";
import type { ServerRequestResolvedNotification } from "@kirbot/codex-client/generated/codex/v2/ServerRequestResolvedNotification";
import type { ToolRequestUserInputResponse } from "@kirbot/codex-client/generated/codex/v2/ToolRequestUserInputResponse";
import type { TelegramApi, TelegramMessenger } from "../telegram-messenger";
import { prefixTelegramUsernameMention, type MentionableMessage } from "./telegram-mention-prefix";
import type { TurnContext } from "./turn-lifecycle";
import {
  allowCurrentQuestionFreeText,
  answerCurrentUserInputQuestion,
  buildApprovalKeyboard,
  buildCompletedUserInputPrompt,
  buildPermissionsApprovalKeyboard,
  buildUserInputPrompt,
  buildUserInputResponse,
  createInitialUserInputState,
  currentQuestionAcceptsFreeText,
  getCurrentUserInputQuestion,
  parseRequestId,
  parseUserInputState,
  resolvePermissionsApprovalResponse,
  resolveCommandApprovalDecision,
  resolveFileApprovalDecision,
  stringifyUserInputState
} from "./requests";
import {
  buildRenderedCommandApprovalPrompt,
  buildRenderedFileChangeApprovalPrompt,
  buildRenderedPermissionsApprovalPrompt,
  buildStatusDraft
} from "./presentation";

type BridgeCodexRequestsApi = {
  respondToCommandApproval(id: RequestId, response: { decision: CommandExecutionApprovalDecision }): Promise<void>;
  respondToFileChangeApproval(id: RequestId, response: { decision: FileChangeApprovalDecision }): Promise<void>;
  respondToPermissionsApproval(id: RequestId, response: PermissionsRequestApprovalResponse): Promise<void>;
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
  constructor(
    private readonly database: BridgeDatabase,
    private readonly telegram: TelegramApi,
    private readonly messenger: TelegramMessenger,
    private readonly codex: BridgeCodexRequestsApi,
    private readonly getTurnContext: (turnId: string) => TurnContext | undefined,
    private readonly updateTurnStatus: (
      turnId: string,
      statusDraft: ReturnType<typeof buildStatusDraft>,
      force?: boolean
    ) => Promise<void>
  ) {}

  async handleCallbackQuery(event: CallbackQueryEvent): Promise<boolean> {
    if (!event.data.startsWith("req:")) {
      return false;
    }

    const [, requestIdText, ...actionParts] = event.data.split(":");
    const requestId = Number.parseInt(requestIdText ?? "", 10);
    if (Number.isNaN(requestId)) {
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: "Invalid callback payload"
      });
      return true;
    }

    const request = await this.database.getServerRequestById(requestId);
    if (!request || request.status !== "pending") {
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: "This request is no longer pending"
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

    if (request.method === "item/permissions/requestApproval") {
      await this.resolvePermissionsApprovalAction(request, actionParts);
      await this.telegram.answerCallbackQuery(event.callbackQueryId, {
        text: "Permissions request updated"
      });
      return true;
    }

    await this.resolveApprovalAction(request, actionParts);
    await this.telegram.answerCallbackQuery(event.callbackQueryId, {
      text: "Request updated"
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

    if (request.method === "item/permissions/requestApproval") {
      await this.handlePermissionsApprovalRequest(session, request);
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
      await this.messenger.sendMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: "Use the buttons on the pending question, or choose Other… to reply in text"
      });
      return true;
    }

    const answer = message.text.trim();
    if (!answer) {
      await this.messenger.sendMessage({
        chatId: message.chatId,
        topicId: message.topicId,
        text: "Reply with text for the pending question"
      });
      return true;
    }

    const nextState = answerCurrentUserInputQuestion(payload.questions, state, [answer]);
    await this.progressUserInputRequest(pending, payload, nextState, true, answer);
    return true;
  }

  async handleServerRequestResolved(params: ServerRequestResolvedNotification): Promise<void> {
    const request = await this.database.getPendingRequest(JSON.stringify(params.requestId)).catch(() => undefined);
    if (!request || request.status !== "pending") {
      return;
    }

    const resolved = await this.database.resolveRequestExternally(request.requestIdJson);
    if (!resolved.telegramMessageId) {
      return;
    }

    await this.telegram.editMessageText(
      Number.parseInt(resolved.telegramChatId, 10),
      resolved.telegramMessageId,
      "Request resolved"
    );
  }

  private async handleApprovalRequest(session: BridgeSession, request: ApprovalServerRequest): Promise<void> {
    if (!session.codexThreadId) {
      throw new Error("Expected session.codexThreadId for approval request handling");
    }
    const sessionTopicId = session.surface.kind === "topic" ? session.surface.topicId : null;

    await this.updateTurnStatus(
      request.params.turnId,
      buildStatusDraft("waiting"),
      true
    );

    const prompt =
      request.method === "item/commandExecution/requestApproval"
        ? buildRenderedCommandApprovalPrompt(request.params)
        : buildRenderedFileChangeApprovalPrompt(request.params);

    const pending = await this.database.createPendingRequest({
      requestIdJson: JSON.stringify(request.id),
      method: request.method,
      telegramChatId: session.telegramChatId,
      telegramTopicId: sessionTopicId,
      telegramMessageId: null,
      payloadJson: JSON.stringify(request.params)
    });

    const message = await this.messenger.sendMessage({
      chatId: Number.parseInt(session.telegramChatId, 10),
      topicId: sessionTopicId,
      ...this.prefixInitialRequestPrompt(request.params.turnId, prompt),
      replyMarkup: buildApprovalKeyboard(
        pending.id,
        request.method === "item/commandExecution/requestApproval" ? request.params.availableDecisions ?? null : null
      ),
      disableNotification: false
    });

    await this.database.updateServerRequestMessageId(pending.id, message.messageId);
  }

  private async handleUserInputRequest(session: BridgeSession, request: UserInputServerRequest): Promise<void> {
    if (!session.codexThreadId) {
      throw new Error("Expected session.codexThreadId for user-input request handling");
    }
    const sessionTopicId = session.surface.kind === "topic" ? session.surface.topicId : null;

    await this.updateTurnStatus(request.params.turnId, buildStatusDraft("waiting"), true);

    const pending = await this.database.createPendingRequest({
      requestIdJson: JSON.stringify(request.id),
      method: request.method,
      telegramChatId: session.telegramChatId,
      telegramTopicId: sessionTopicId,
      telegramMessageId: null,
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

  private async handlePermissionsApprovalRequest(
    session: BridgeSession,
    request: Extract<ServerRequest, { method: "item/permissions/requestApproval" }>
  ): Promise<void> {
    if (!session.codexThreadId) {
      throw new Error("Expected session.codexThreadId for permissions request handling");
    }
    const sessionTopicId = session.surface.kind === "topic" ? session.surface.topicId : null;

    await this.updateTurnStatus(request.params.turnId, buildStatusDraft("waiting"), true);

    const pending = await this.database.createPendingRequest({
      requestIdJson: JSON.stringify(request.id),
      method: request.method,
      telegramChatId: session.telegramChatId,
      telegramTopicId: sessionTopicId,
      telegramMessageId: null,
      payloadJson: JSON.stringify(request.params)
    });

    const prompt = buildRenderedPermissionsApprovalPrompt(request.params);
    const message = await this.messenger.sendMessage({
      chatId: Number.parseInt(session.telegramChatId, 10),
      topicId: sessionTopicId,
      ...this.prefixInitialRequestPrompt(request.params.turnId, prompt),
      replyMarkup: buildPermissionsApprovalKeyboard(pending.id),
      disableNotification: false
    });

    await this.database.updateServerRequestMessageId(pending.id, message.messageId);
  }

  private async resolveApprovalAction(request: PendingServerRequest, actionParts: string[]): Promise<void> {
    const requestId = parseRequestId(request.requestIdJson);
    const chatId = Number.parseInt(request.telegramChatId, 10);

    let resolvedActionSummary = actionParts.join(":") || "cancel";
    if (request.method === "item/commandExecution/requestApproval") {
      const payload = JSON.parse(request.payloadJson) as Extract<
        ApprovalServerRequest,
        { method: "item/commandExecution/requestApproval" }
      >["params"];
      const decision = resolveCommandApprovalDecision(payload.availableDecisions ?? null, actionParts);
      const response = {
        decision
      };
      await this.codex.respondToCommandApproval(requestId, response);
      await this.database.resolveRequest(request.requestIdJson);
      resolvedActionSummary = describeCommandApprovalDecision(decision);
    } else if (request.method === "item/fileChange/requestApproval") {
      const decision = resolveFileApprovalDecision(actionParts);
      const response = {
        decision
      };
      await this.codex.respondToFileChangeApproval(requestId, response);
      await this.database.resolveRequest(request.requestIdJson);
      resolvedActionSummary = decision;
    } else {
      await this.codex.respondUnsupportedRequest(requestId, `Unsupported approval action for ${request.method}`);
      return;
    }

    if (request.telegramMessageId) {
      await this.telegram.editMessageText(
        chatId,
        request.telegramMessageId,
        `Resolved ${request.method} with "${resolvedActionSummary}".`
      );
    }
  }

  private async resolvePermissionsApprovalAction(
    request: PendingServerRequest,
    actionParts: string[]
  ): Promise<void> {
    const requestId = parseRequestId(request.requestIdJson);
    const chatId = Number.parseInt(request.telegramChatId, 10);
    const payload = JSON.parse(request.payloadJson) as Extract<
      ServerRequest,
      { method: "item/permissions/requestApproval" }
    >["params"];
    const response = resolvePermissionsApprovalResponse(payload, actionParts);
    await this.codex.respondToPermissionsApproval(requestId, response);
    await this.database.resolveRequest(request.requestIdJson);

    if (request.telegramMessageId) {
      const summary =
        Object.keys(response.permissions).length === 0
          ? "Denied additional permissions"
          : `Allowed additional permissions for this ${response.scope}`;
      await this.telegram.editMessageText(chatId, request.telegramMessageId, summary);
    }
  }

  private async resolveUserInputAction(request: PendingServerRequest, actionParts: string[]): Promise<string> {
    const payload = JSON.parse(request.payloadJson) as UserInputServerRequest["params"];
    const state = parseUserInputState(request.stateJson);
    const question = getCurrentUserInputQuestion(payload.questions, state);
    if (!question) {
      return "Request already completed";
    }

    const [action, value] = actionParts;
    if (action === "other") {
      if (!question.isOther) {
        return "That option is not available";
      }

      const nextState = allowCurrentQuestionFreeText(payload.questions, state);
      await this.progressUserInputRequest(request, payload, nextState, false);
      return "Reply with your answer";
    }

    if (action === "opt") {
      const optionIndex = Number.parseInt(value ?? "", 10);
      const option = question.options?.[optionIndex];
      if (!option) {
        return "That option is no longer available";
      }

      const nextState = answerCurrentUserInputQuestion(payload.questions, state, [option.label]);
      await this.progressUserInputRequest(request, payload, nextState, true, option.label);
      return "Answer recorded";
    }

    return "Unsupported callback";
  }

  private async progressUserInputRequest(
    request: PendingServerRequest,
    payload: UserInputServerRequest["params"],
    nextState: ReturnType<typeof parseUserInputState>,
    allowCompletion = true,
    completedAnswer?: string
  ): Promise<void> {
    const serializedState = stringifyUserInputState(nextState);
    const updated = await this.database.updateRequestState(request.requestIdJson, serializedState);
    const currentQuestion = getCurrentUserInputQuestion(payload.questions, nextState);

    if (!currentQuestion && allowCompletion) {
      const response = buildUserInputResponse(payload.questions, nextState);
      await this.codex.respondToUserInputRequest(parseRequestId(request.requestIdJson), response);
      await this.database.resolveRequest(request.requestIdJson);
      await this.finishUserInputRequest(updated, completedAnswer);
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
        ...(prompt.replyMarkup ? { reply_markup: prompt.replyMarkup } : {})
      });
      return;
    }

    const message = await this.messenger.sendMessage({
      chatId,
      topicId: request.telegramTopicId,
      ...this.prefixInitialRequestPrompt(payload.turnId, prompt),
      disableNotification: false
    });

    await this.database.updateServerRequestMessageId(request.id, message.messageId);
  }

  private async finishUserInputRequest(request: PendingServerRequest, answer?: string): Promise<void> {
    const completionPrompt = answer ? buildCompletedUserInputPrompt(answer) : { text: "User answered" };

    if (!request.telegramMessageId) {
      await this.messenger.sendMessage({
        chatId: Number.parseInt(request.telegramChatId, 10),
        topicId: request.telegramTopicId,
        text: completionPrompt.text,
        ...(completionPrompt.entities ? { entities: completionPrompt.entities } : {})
      });
      return;
    }

    await this.telegram.editMessageText(
      Number.parseInt(request.telegramChatId, 10),
      request.telegramMessageId,
      completionPrompt.text,
      {
        ...(completionPrompt.entities ? { entities: completionPrompt.entities } : {})
      }
    );
  }

  private async findSessionForRequest(request: ServerRequest): Promise<BridgeSession | undefined> {
    const threadId = "threadId" in request.params && typeof request.params.threadId === "string" ? request.params.threadId : null;
    if (!threadId) {
      return undefined;
    }

    return this.database.getSessionByCodexThreadId(threadId);
  }

  private prefixInitialRequestPrompt<T extends MentionableMessage>(turnId: string, prompt: T): T {
    const turnContext = this.getTurnContext(turnId);
    return {
      ...prompt,
      ...prefixTelegramUsernameMention(prompt, turnContext?.telegramUsername)
    } as T;
  }
}

function describeCommandApprovalDecision(decision: CommandExecutionApprovalDecision): string {
  if (typeof decision === "string") {
    return decision;
  }

  if ("acceptWithExecpolicyAmendment" in decision) {
    return "acceptWithExecpolicyAmendment";
  }

  if ("applyNetworkPolicyAmendment" in decision) {
    return "applyNetworkPolicyAmendment";
  }

  return "cancel";
}
