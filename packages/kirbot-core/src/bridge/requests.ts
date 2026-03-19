import type { RequestId } from "@kirbot/codex-client/generated/codex/RequestId";
import type { CommandExecutionApprovalDecision } from "@kirbot/codex-client/generated/codex/v2/CommandExecutionApprovalDecision";
import type { FileChangeApprovalDecision } from "@kirbot/codex-client/generated/codex/v2/FileChangeApprovalDecision";
import type { FileChangeRequestApprovalParams } from "@kirbot/codex-client/generated/codex/v2/FileChangeRequestApprovalParams";
import type { ToolRequestUserInputResponse } from "@kirbot/codex-client/generated/codex/v2/ToolRequestUserInputResponse";
import type { UserInputServerRequest } from "@kirbot/codex-client";
import type { InlineKeyboardMarkup } from "../telegram-messenger";

export type UserInputRequestState = {
  answers: Record<string, string[]>;
  currentQuestionIndex: number;
  awaitingFreeTextQuestionId: string | null;
};

type UserInputQuestion = UserInputServerRequest["params"]["questions"][number];

export function buildApprovalKeyboard(
  requestId: number,
  availableDecisions: ReadonlyArray<CommandExecutionApprovalDecision> | null
): InlineKeyboardMarkup {
  const decisions = availableDecisions ?? ["accept", "decline", "cancel"];

  const allowRow = decisions
    .map((decision, index) => buildCommandApprovalButton(requestId, decision, index))
    .filter(
      (button): button is {
        text: string;
        callback_data: string;
      } => button !== null && isAllowApprovalButton(button.text)
    );

  const denyRow = decisions
    .map((decision, index) => buildCommandApprovalButton(requestId, decision, index))
    .filter(
      (button): button is {
        text: string;
        callback_data: string;
      } => button !== null && !isAllowApprovalButton(button.text)
    );

  return {
    inline_keyboard: [allowRow, denyRow].filter((row) => row.length > 0)
  };
}

export function formatFileChangeApprovalPrompt(params: FileChangeRequestApprovalParams): string {
  return ["Codex requested file-change approval.", `Turn: ${params.turnId}`, `Item: ${params.itemId}`].join("\n");
}

export function createInitialUserInputState(): UserInputRequestState {
  return {
    answers: {},
    currentQuestionIndex: 0,
    awaitingFreeTextQuestionId: null
  };
}

export function parseUserInputState(stateJson: string | null): UserInputRequestState {
  if (!stateJson) {
    return createInitialUserInputState();
  }

  const parsed = JSON.parse(stateJson) as Partial<UserInputRequestState>;
  return {
    answers: parsed.answers ?? {},
    currentQuestionIndex: parsed.currentQuestionIndex ?? 0,
    awaitingFreeTextQuestionId: parsed.awaitingFreeTextQuestionId ?? null
  };
}

export function stringifyUserInputState(state: UserInputRequestState): string {
  return JSON.stringify(state);
}

export function getCurrentUserInputQuestion(
  questions: UserInputServerRequest["params"]["questions"],
  state: UserInputRequestState
): UserInputQuestion | null {
  return questions[state.currentQuestionIndex] ?? null;
}

export function buildUserInputPrompt(
  requestId: number,
  questions: UserInputServerRequest["params"]["questions"],
  state: UserInputRequestState
): { text: string; replyMarkup?: InlineKeyboardMarkup } {
  const question = getCurrentUserInputQuestion(questions, state);
  if (!question) {
    return {
      text: "Sent your answers to Codex."
    };
  }

  const lines = ["Codex is asking for user input."];
  if (questions.length > 1) {
    lines.push(`Question ${state.currentQuestionIndex + 1}/${questions.length}`);
  }

  if (question.header.trim()) {
    lines.push(question.header.trim());
  }

  lines.push(question.question);

  if (question.isSecret) {
    lines.push("Sensitive input. Your reply stays visible in this topic.");
  }

  const awaitingFreeText = state.awaitingFreeTextQuestionId === question.id;
  if (question.options?.length) {
    lines.push("");
    for (const option of question.options) {
      lines.push(option.description ? `- ${option.label}: ${option.description}` : `- ${option.label}`);
    }

    lines.push("");
    lines.push(awaitingFreeText ? "Reply with your own answer in this topic." : "Use the buttons below to answer.");
  } else {
    lines.push("");
    lines.push("Reply with your answer in this topic.");
  }

  const replyMarkup =
    question.options?.length && !awaitingFreeText
      ? {
          inline_keyboard: [
            ...question.options.map((option: NonNullable<UserInputQuestion["options"]>[number], index: number) => [
              { text: option.label, callback_data: `req:${requestId}:opt:${index}` }
            ]),
            ...(question.isOther ? [[{ text: "Other…", callback_data: `req:${requestId}:other` }]] : [])
          ]
        }
      : undefined;

  return {
    text: lines.join("\n"),
    ...(replyMarkup ? { replyMarkup } : {})
  };
}

export function currentQuestionAcceptsFreeText(question: UserInputQuestion, state: UserInputRequestState): boolean {
  return !question.options?.length || state.awaitingFreeTextQuestionId === question.id;
}

export function answerCurrentUserInputQuestion(
  questions: UserInputServerRequest["params"]["questions"],
  state: UserInputRequestState,
  answers: string[]
): UserInputRequestState {
  const question = getCurrentUserInputQuestion(questions, state);
  if (!question) {
    return state;
  }

  const nextState: UserInputRequestState = {
    answers: {
      ...state.answers,
      [question.id]: answers
    },
    currentQuestionIndex: state.currentQuestionIndex,
    awaitingFreeTextQuestionId: null
  };

  let nextIndex = state.currentQuestionIndex + 1;
  while (nextIndex < questions.length && nextState.answers[questions[nextIndex]!.id]) {
    nextIndex += 1;
  }
  nextState.currentQuestionIndex = nextIndex;
  return nextState;
}

export function allowCurrentQuestionFreeText(
  questions: UserInputServerRequest["params"]["questions"],
  state: UserInputRequestState
): UserInputRequestState {
  const question = getCurrentUserInputQuestion(questions, state);
  if (!question) {
    return state;
  }

  return {
    ...state,
    awaitingFreeTextQuestionId: question.id
  };
}

export function buildUserInputResponse(
  questions: UserInputServerRequest["params"]["questions"],
  state: UserInputRequestState
): ToolRequestUserInputResponse {
  return {
    answers: Object.fromEntries(
      questions.map((question: UserInputQuestion) => [
        question.id,
        {
          answers: state.answers[question.id] ?? []
        }
      ])
    )
  };
}

export function parseRequestId(value: string): RequestId {
  return JSON.parse(value) as RequestId;
}

export function resolveCommandApprovalDecision(
  availableDecisions: ReadonlyArray<CommandExecutionApprovalDecision> | null,
  actionParts: string[]
): CommandExecutionApprovalDecision {
  const [action, value] = actionParts;
  if (action === "decision") {
    const decisionIndex = Number.parseInt(value ?? "", 10);
    const decision = availableDecisions?.[decisionIndex];
    if (decision) {
      return decision;
    }
  }

  return normalizeCommandApprovalDecision(action ?? "cancel");
}

function normalizeCommandApprovalDecision(action: string): CommandExecutionApprovalDecision {
  switch (action) {
    case "accept":
      return "accept";
    case "acceptForSession":
      return "acceptForSession";
    case "decline":
      return "decline";
    case "cancel":
    default:
      return "cancel";
  }
}

export function normalizeFileApprovalDecision(action: string): FileChangeApprovalDecision {
  switch (action) {
    case "accept":
      return "accept";
    case "acceptForSession":
      return "acceptForSession";
    case "decline":
      return "decline";
    case "cancel":
    default:
      return "cancel";
  }
}

function buildCommandApprovalButton(
  requestId: number,
  decision: CommandExecutionApprovalDecision,
  index: number
): { text: string; callback_data: string } | null {
  if (typeof decision === "string") {
    switch (decision) {
      case "accept":
        return { text: "Allow once", callback_data: `req:${requestId}:decision:${index}` };
      case "acceptForSession":
        return { text: "Allow this session", callback_data: `req:${requestId}:decision:${index}` };
      case "decline":
        return { text: "Deny", callback_data: `req:${requestId}:decision:${index}` };
      case "cancel":
        return { text: "Interrupt turn", callback_data: `req:${requestId}:decision:${index}` };
      default:
        return null;
    }
  }

  if ("acceptWithExecpolicyAmendment" in decision) {
    return { text: "Allow similar commands", callback_data: `req:${requestId}:decision:${index}` };
  }

  if ("applyNetworkPolicyAmendment" in decision) {
    return {
      text: `Allow ${decision.applyNetworkPolicyAmendment.network_policy_amendment.host}`,
      callback_data: `req:${requestId}:decision:${index}`
    };
  }

  return null;
}

function isAllowApprovalButton(label: string): boolean {
  return label.startsWith("Allow");
}
