import type { ThreadItem } from "../generated/codex/v2/ThreadItem";
import { chunkFormattedText, prependText } from "../telegram-format/chunk";
import { renderMarkdownToFormattedText } from "../telegram-format/markdown";
import { renderPreformattedText } from "../telegram-format/preformatted";
import type { InlineKeyboardMarkup, TelegramRenderedMessage } from "../telegram-messenger";
import type { QueueStateSnapshot } from "../turn-runtime";

const TELEGRAM_MESSAGE_CHAR_LIMIT = 4000;
const TELEGRAM_DRAFT_PREVIEW_CHAR_LIMIT = 3500;

export type TurnStatusState =
  | "thinking"
  | "planning"
  | "using tool"
  | "running"
  | "editing"
  | "searching"
  | "streaming"
  | "waiting"
  | "done"
  | "failed"
  | "interrupted";

export type TurnStatusDraft = {
  state: TurnStatusState;
  emoji: string;
  details: string | null;
};

export function deriveTopicTitle(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 60) || "New Codex Session";
}

export function buildStableDraftId(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 1) || 1;
}

export function buildStatusDraft(state: TurnStatusState, details: string | null = null): TurnStatusDraft {
  switch (state) {
    case "thinking":
      return { state, emoji: "🤔", details };
    case "planning":
      return { state, emoji: "🗺️", details };
    case "using tool":
      return { state, emoji: "🛠️", details };
    case "running":
      return { state, emoji: "💻", details };
    case "editing":
      return { state, emoji: "✏️", details };
    case "searching":
      return { state, emoji: "🔎", details };
    case "streaming":
      return { state, emoji: "✍️", details };
    case "waiting":
      return { state, emoji: "⏸️", details };
    case "done":
      return { state, emoji: "✅", details };
    case "failed":
      return { state, emoji: "❌", details };
    case "interrupted":
      return { state, emoji: "⏹️", details };
  }
}

export function buildStatusDraftForItem(item: ThreadItem): TurnStatusDraft {
  switch (item.type) {
    case "reasoning":
      return buildStatusDraft("thinking");
    case "commandExecution":
      return buildStatusDraft("running", item.command);
    case "fileChange":
      return buildStatusDraft("editing", summarizeFileChanges(item.changes));
    case "plan":
      return buildStatusDraft("planning");
    case "mcpToolCall":
      return buildStatusDraft("using tool", `${item.server}.${item.tool}`);
    case "dynamicToolCall":
      return buildStatusDraft("using tool", item.tool);
    case "collabAgentToolCall":
      return buildStatusDraft("using tool", item.tool);
    case "webSearch":
      return buildStatusDraft("searching", item.query);
    default:
      return buildStatusDraft("thinking");
  }
}

export function isSameStatusDraft(left: TurnStatusDraft | null, right: TurnStatusDraft | null): boolean {
  return left?.state === right?.state && left?.emoji === right?.emoji && left?.details === right?.details;
}

export function renderQueuePreview(queueState: QueueStateSnapshot): string | null {
  const lines: string[] = [];

  if (queueState.pendingSteers.length > 0) {
    lines.push("Queued for current turn:");
    for (const text of queueState.pendingSteers.slice(0, 3)) {
      lines.push(`- ${truncateStatus(text)}`);
    }
    if (queueState.pendingSteers.length > 3) {
      lines.push(`- …and ${queueState.pendingSteers.length - 3} more`);
    }
  }

  if (queueState.queuedFollowUps.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push("Queued for next turn:");
    for (const text of queueState.queuedFollowUps.slice(0, 3)) {
      lines.push(`- ${truncateStatus(text)}`);
    }
    if (queueState.queuedFollowUps.length > 3) {
      lines.push(`- …and ${queueState.queuedFollowUps.length - 3} more`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

export function buildQueuePreviewKeyboard(
  queueState: QueueStateSnapshot,
  activeTurnId: string | null,
  stopRequested = false
): InlineKeyboardMarkup | undefined {
  if (queueState.pendingSteers.length === 0 || !activeTurnId || stopRequested) {
    return undefined;
  }

  return {
    inline_keyboard: [[{ text: "Send now", callback_data: `turn:${activeTurnId}:sendNow` }]]
  };
}

export function renderTurnControlMessage(state: "active" | "stopping" | "finishing"): string {
  switch (state) {
    case "stopping":
      return "Stopping this turn…";
    case "finishing":
      return "This turn is already finishing…";
    case "active":
    default:
      return "Working on this request. Send another message to steer, or tap Stop.";
  }
}

export function buildTurnControlKeyboard(turnId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[{ text: "Stop", callback_data: `turn:${turnId}:stop` }]]
  };
}

export function renderTelegramStatusDraft(statusDraft: TurnStatusDraft | null): TelegramRenderedMessage | null {
  return statusDraft ? { text: buildStatusText(statusDraft) } : null;
}

export function renderTelegramAssistantDraft(text: string): TelegramRenderedMessage {
  return renderMarkdownToFormattedText(buildDraftPreviewWithLimit(text, TELEGRAM_DRAFT_PREVIEW_CHAR_LIMIT));
}

export function renderTelegramCommentaryDraft(text: string): TelegramRenderedMessage {
  return renderPreformattedText(buildCommentaryDraftPreviewWithLimit(text, TELEGRAM_DRAFT_PREVIEW_CHAR_LIMIT), "kirbot");
}

export function buildRenderedCommentaryMessage(text: string): TelegramRenderedMessage {
  return renderPreformattedText(buildCommentaryDraftPreviewWithLimit(text, TELEGRAM_MESSAGE_CHAR_LIMIT), "kirbot");
}

export function buildRenderedAssistantMessages(text: string): TelegramRenderedMessage[] {
  const reservedHeaderChars = 32;
  const formatted = renderMarkdownToFormattedText(text);
  const chunks = chunkFormattedText(formatted, TELEGRAM_MESSAGE_CHAR_LIMIT - reservedHeaderChars);

  if (chunks.length === 1) {
    return chunks;
  }

  return chunks.map((chunk, index) => prependText(`Part ${index + 1}/${chunks.length}\n\n`, chunk));
}

function truncateStatus(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function summarizeFileChanges(changes: Array<{ path: string }>): string | null {
  if (changes.length === 0) {
    return null;
  }

  if (changes.length === 1) {
    return changes[0]?.path ?? null;
  }

  const [first, second] = changes;
  if (changes.length === 2 && first && second) {
    return `${first.path}, ${second.path}`;
  }

  return `${first?.path ?? changes.length} (+${changes.length - 1} more)`;
}

function buildDraftPreviewWithLimit(text: string, limit: number): string {
  return buildTruncatedPreview(text, limit, "…\n", "\n\n[preview truncated]");
}

function buildCommentaryDraftPreviewWithLimit(text: string, limit: number): string {
  return buildTruncatedPreview(text, limit, "...\n", "\n\n[commentary truncated]");
}

function buildTruncatedPreview(text: string, limit: number, prefix: string, suffix: string): string {
  if (text.length <= limit) {
    return text;
  }

  const budget = Math.max(0, limit - prefix.length - suffix.length);
  return `${prefix}${text.slice(-budget)}${suffix}`;
}

function buildStatusText(statusDraft: TurnStatusDraft): string {
  if (!statusDraft.details) {
    return statusDraft.state;
  }

  return `${statusDraft.state}: ${statusDraft.details.replace(/\s+/g, " ").trim()}`;
}
