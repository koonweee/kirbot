import type { UserInput } from "@kirbot/codex-client/generated/codex/v2/UserInput";

export type SessionStatus = "provisioning" | "active" | "archived" | "errored";
export type SessionMode = "default" | "plan";

export type UserTurnInput =
  | Extract<UserInput, { type: "text" }>
  | {
      type: "telegramImage";
      fileId: string;
      fileName?: string | null;
      mimeType?: string | null;
    };

export type TopicSession = {
  id: number;
  telegramChatId: string;
  telegramTopicId: number;
  codexThreadId: string | null;
  status: SessionStatus;
  preferredMode: SessionMode;
};

export type PendingServerRequest = {
  id: number;
  requestIdJson: string;
  method: string;
  telegramChatId: string;
  telegramTopicId: number;
  telegramMessageId: number | null;
  payloadJson: string;
  stateJson: string | null;
  status: "pending" | "resolved" | "expired";
  createdAt: string;
};

export type UserTurnMessage = {
  chatId: number;
  topicId: number | null;
  messageId: number;
  updateId: number;
  userId: number;
  text: string;
  input: UserTurnInput[];
  submittedInputSignature?: string;
};

export type TopicLifecycleEvent = {
  chatId: number;
  topicId: number;
};
