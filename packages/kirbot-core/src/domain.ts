import type { UserInput } from "@kirbot/codex-client/generated/codex/v2/UserInput";

export type SessionStatus = "provisioning" | "active" | "archived" | "errored";
export type SessionMode = "default" | "plan";
export type ArtifactKind = "plan";

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
  rootMessageId: number | null;
  codexThreadId: string | null;
  createdByUserId: number;
  title: string;
  status: SessionStatus;
  preferredMode: SessionMode;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type TurnMessageRecord = {
  id: number;
  telegramUpdateId: number;
  telegramChatId: string;
  telegramTopicId: number;
  codexThreadId: string;
  codexTurnId: string;
  draftId: number;
  finalMessageId: number | null;
  streamText: string;
  status: "streaming" | "completed" | "failed" | "interrupted";
  resolvedAssistantText: string;
  createdAt: string;
  updatedAt: string;
};

export type PendingServerRequest = {
  id: number;
  requestIdJson: string;
  method: string;
  telegramChatId: string;
  telegramTopicId: number;
  telegramMessageId: number | null;
  codexThreadId: string;
  turnId: string | null;
  itemId: string | null;
  payloadJson: string;
  stateJson: string | null;
  responseJson: string | null;
  status: "pending" | "resolved" | "expired";
  createdAt: string;
  updatedAt: string;
};

export type ArtifactRecord = {
  id: number;
  artifactId: string;
  kind: ArtifactKind;
  title: string;
  telegramChatId: string;
  telegramTopicId: number;
  codexThreadId: string;
  codexTurnId: string;
  itemId: string;
  markdownText: string;
  mdastJson: string;
  astVersion: string;
  createdAt: string;
  updatedAt: string;
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
