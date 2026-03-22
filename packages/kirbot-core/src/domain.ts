import type { UserInput } from "@kirbot/codex-client/generated/codex/v2/UserInput";
import type { ReasoningEffort } from "@kirbot/codex-client/generated/codex/ReasoningEffort";
import type { ServiceTier } from "@kirbot/codex-client/generated/codex/ServiceTier";
import type { AskForApproval } from "@kirbot/codex-client/generated/codex/v2/AskForApproval";
import type { SandboxPolicy } from "@kirbot/codex-client/generated/codex/v2/SandboxPolicy";

export type SessionStatus = "provisioning" | "active" | "archived" | "errored";
export type SessionMode = "default" | "plan";
export type PendingCustomCommandStatus = "pending" | "confirmed" | "canceled";

export type SessionSurface =
  | { kind: "general" }
  | { kind: "topic"; topicId: number };

export type PersistedThreadSettings = {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  serviceTier: ServiceTier | null;
  approvalPolicy: AskForApproval | null;
  sandboxPolicy: SandboxPolicy | null;
};

export type ChatThreadDefaults = {
  telegramChatId: string;
  root: PersistedThreadSettings;
  spawn: PersistedThreadSettings;
};

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
  settings: PersistedThreadSettings;
};

export type BridgeSession = {
  id: number;
  telegramChatId: string;
  surface: SessionSurface;
  codexThreadId: string | null;
  status: SessionStatus;
  preferredMode: SessionMode;
  settings: PersistedThreadSettings;
};

export type PendingServerRequest = {
  id: number;
  requestIdJson: string;
  method: string;
  telegramChatId: string;
  telegramTopicId: number | null;
  telegramMessageId: number | null;
  payloadJson: string;
  stateJson: string | null;
  status: "pending" | "resolved" | "expired";
  createdAt: string;
};

export type CustomCommand = {
  id: number;
  command: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
};

export type PendingCustomCommandAdd = {
  id: number;
  command: string;
  prompt: string;
  telegramChatId: string;
  telegramMessageId: number | null;
  status: PendingCustomCommandStatus;
  createdAt: string;
  updatedAt: string;
};

export type UserTurnMessage = {
  chatId: number;
  topicId: number | null;
  messageId: number;
  updateId: number;
  userId: number;
  actorLabel?: string;
  telegramUsername?: string;
  text: string;
  input: UserTurnInput[];
  submittedInputSignature?: string;
};

export type TopicLifecycleEvent = {
  chatId: number;
  topicId: number;
};
