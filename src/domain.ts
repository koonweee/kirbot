export type SessionStatus = "provisioning" | "active" | "archived" | "errored";

export type TopicSession = {
  id: number;
  telegramChatId: string;
  telegramTopicId: number;
  rootMessageId: number | null;
  codexThreadId: string | null;
  createdByUserId: number;
  title: string;
  status: SessionStatus;
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
  responseJson: string | null;
  status: "pending" | "resolved" | "expired";
  createdAt: string;
  updatedAt: string;
};

export type UserTextMessage = {
  chatId: number;
  topicId: number | null;
  messageId: number;
  updateId: number;
  userId: number;
  text: string;
};

export type TopicLifecycleEvent = {
  chatId: number;
  topicId: number;
};
