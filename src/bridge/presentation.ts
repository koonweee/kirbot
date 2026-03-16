import type { ThreadItem } from "../generated/codex/v2/ThreadItem";
import type {
  InlineKeyboardMarkup,
  TelegramParseMode,
  TelegramRenderedMessage
} from "../telegram-messenger";
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
  activeTurnId: string | null
): InlineKeyboardMarkup | undefined {
  if (queueState.pendingSteers.length === 0 || !activeTurnId) {
    return undefined;
  }

  return {
    inline_keyboard: [[{ text: "Send now", callback_data: `turn:${activeTurnId}:sendNow` }]]
  };
}

export function renderTelegramStatusDraft(statusDraft: TurnStatusDraft | null): TelegramRenderedMessage | null {
  return statusDraft ? renderTelegramAssistantText(buildStatusText(statusDraft)) : null;
}

export function renderTelegramAssistantDraft(text: string): TelegramRenderedMessage {
  let budget = TELEGRAM_DRAFT_PREVIEW_CHAR_LIMIT;
  let rendered = renderTelegramAssistantText(buildDraftPreviewWithLimit(text, budget));

  for (let attempt = 0; attempt < 3 && rendered.text.length > TELEGRAM_DRAFT_PREVIEW_CHAR_LIMIT; attempt += 1) {
    const overflow = rendered.text.length - TELEGRAM_DRAFT_PREVIEW_CHAR_LIMIT;
    budget = Math.max(0, budget - overflow - 16);
    rendered = renderTelegramAssistantText(buildDraftPreviewWithLimit(text, budget));
  }

  return toRenderedMessage(rendered);
}

export function renderTelegramCommentaryDraft(text: string): TelegramRenderedMessage {
  const budget = Math.max(0, TELEGRAM_DRAFT_PREVIEW_CHAR_LIMIT - "```kirbot\n\n```".length);
  return toRenderedMessage(renderTelegramAssistantText(buildCommentaryText(buildCommentaryDraftPreviewWithLimit(text, budget))));
}

export function buildRenderedCommentaryMessage(text: string): TelegramRenderedMessage {
  const budget = Math.max(0, TELEGRAM_MESSAGE_CHAR_LIMIT - "```kirbot\n\n```".length);
  return toRenderedMessage(renderTelegramAssistantText(buildCommentaryText(buildCommentaryDraftPreviewWithLimit(text, budget))));
}

export function buildRenderedAssistantMessages(text: string): TelegramRenderedMessage[] {
  return chunkTelegramMessage(text).map((chunk) => toRenderedMessage(renderTelegramAssistantText(chunk)));
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

function buildCommentaryText(text: string): string {
  return `\`\`\`kirbot\n${text}\n\`\`\``;
}

function chunkTelegramMessage(text: string): string[] {
  const reservedHeaderChars = 32;
  const rawChunks = splitTextForTelegram(text, TELEGRAM_MESSAGE_CHAR_LIMIT - reservedHeaderChars);
  if (rawChunks.length === 1) {
    return rawChunks;
  }

  return rawChunks.map((chunk, index) => `Part ${index + 1}/${rawChunks.length}\n\n${chunk}`);
}

function splitTextForTelegram(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    const splitIndex = findChunkBoundary(remaining, maxChars);
    chunks.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).replace(/^\s+/, "");
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks.length > 0 ? chunks : [text];
}

function findChunkBoundary(text: string, maxChars: number): number {
  const minPreferredIndex = Math.floor(maxChars * 0.6);
  const window = text.slice(0, maxChars + 1);
  const candidates = [window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" ")];

  for (const index of candidates) {
    if (index >= minPreferredIndex) {
      return index;
    }
  }

  return maxChars;
}

function renderTelegramAssistantText(text: string): { text: string; parse_mode?: TelegramParseMode } {
  const rendered = markdownToTelegramHtml(text);
  if (rendered === text) {
    return { text };
  }

  return {
    text: rendered,
    parse_mode: "HTML"
  };
}

function toRenderedMessage(rendered: { text: string; parse_mode?: TelegramParseMode }): TelegramRenderedMessage {
  return rendered.parse_mode ? { text: rendered.text, parseMode: rendered.parse_mode } : { text: rendered.text };
}

function markdownToTelegramHtml(text: string): string {
  const segments = splitMarkdownByFences(text);
  const rendered = segments
    .map((segment) =>
      segment.type === "fence" ? renderTelegramCodeFence(segment.language, segment.content) : renderTelegramInlineMarkdown(segment.content)
    )
    .join("");

  return rendered === escapeHtml(text) ? text : rendered;
}

function splitMarkdownByFences(
  text: string
): Array<{ type: "text"; content: string } | { type: "fence"; language: string; content: string }> {
  const segments: Array<{ type: "text"; content: string } | { type: "fence"; language: string; content: string }> = [];
  const pattern = /```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g;
  let lastIndex = 0;

  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      segments.push({
        type: "text",
        content: text.slice(lastIndex, index)
      });
    }

    segments.push({
      type: "fence",
      language: (match[1] ?? "").trim(),
      content: match[2] ?? ""
    });
    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({
      type: "text",
      content: text.slice(lastIndex)
    });
  }

  return segments.length > 0 ? segments : [{ type: "text", content: text }];
}

function renderTelegramCodeFence(language: string, content: string): string {
  const escapedCode = escapeHtml(content.replace(/\n$/, ""));
  if (!language) {
    return `<pre><code>${escapedCode}</code></pre>`;
  }

  return `<pre><code class="language-${escapeHtmlAttribute(language)}">${escapedCode}</code></pre>`;
}

function renderTelegramInlineMarkdown(text: string): string {
  let html = "";
  let index = 0;

  while (index < text.length) {
    if (text.startsWith("`", index)) {
      const closingIndex = text.indexOf("`", index + 1);
      if (closingIndex > index + 1 && !text.slice(index + 1, closingIndex).includes("\n")) {
        html += `<code>${escapeHtml(text.slice(index + 1, closingIndex))}</code>`;
        index = closingIndex + 1;
        continue;
      }
    }

    const strongDelimiter = text.startsWith("**", index) ? "**" : text.startsWith("__", index) ? "__" : null;
    if (strongDelimiter) {
      const closingIndex = text.indexOf(strongDelimiter, index + strongDelimiter.length);
      if (closingIndex > index + strongDelimiter.length) {
        html += `<b>${renderTelegramInlineMarkdown(text.slice(index + strongDelimiter.length, closingIndex))}</b>`;
        index = closingIndex + strongDelimiter.length;
        continue;
      }
    }

    html += escapeHtml(text[index] ?? "");
    index += 1;
  }

  return html;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeHtmlAttribute(text: string): string {
  return escapeHtml(text).replaceAll("\"", "&quot;");
}
