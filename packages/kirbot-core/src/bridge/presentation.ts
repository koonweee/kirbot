import type { ThreadItem } from "@kirbot/codex-client/generated/codex/v2/ThreadItem";
import type { ReasoningEffort } from "@kirbot/codex-client/generated/codex/ReasoningEffort";
import {
  chunkFormattedText,
  prependText,
  renderCodeText,
  renderMarkdownToFormattedText,
  renderPreformattedText,
  TelegramEntityBuilder
} from "@kirbot/telegram-format";
import type { InlineKeyboardMarkup, TelegramRenderedMessage } from "../telegram-messenger";
import type { QueueStateSnapshot } from "../turn-runtime";
import {
  buildMiniAppArtifactUrl,
  MiniAppArtifactType,
  type MiniAppArtifact
} from "../mini-app/url";

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
  snippet: string | null;
};

export type CompletionFooterDetails = {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  durationMs: number;
  changedFiles: number;
  contextLeftPercent: number | null;
  cwd: string | null;
  branch: string | null;
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

export function buildStatusDraft(
  state: TurnStatusState,
  details: string | null = null,
  snippet: string | null = null
): TurnStatusDraft {
  switch (state) {
    case "thinking":
      return { state, emoji: "🤔", details, snippet };
    case "planning":
      return { state, emoji: "🗺️", details, snippet };
    case "using tool":
      return { state, emoji: "🛠️", details, snippet };
    case "running":
      return { state, emoji: "💻", details, snippet };
    case "editing":
      return { state, emoji: "✏️", details, snippet };
    case "searching":
      return { state, emoji: "🔎", details, snippet };
    case "streaming":
      return { state, emoji: "✍️", details, snippet };
    case "waiting":
      return { state, emoji: "⏸️", details, snippet };
    case "done":
      return { state, emoji: "✅", details, snippet };
    case "failed":
      return { state, emoji: "❌", details, snippet };
    case "interrupted":
      return { state, emoji: "⏹️", details, snippet };
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
  return (
    left?.state === right?.state &&
    left?.emoji === right?.emoji &&
    left?.details === right?.details &&
    left?.snippet === right?.snippet
  );
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

export function renderTelegramStatusDraft(
  statusDraft: TurnStatusDraft | null,
  elapsedMs: number | null = null
): TelegramRenderedMessage | null {
  return statusDraft ? buildRenderedStatusText(statusDraft, elapsedMs) : null;
}

export function renderTelegramAssistantDraft(text: string): TelegramRenderedMessage {
  return renderMarkdownToFormattedText(buildDraftPreviewWithLimit(text, TELEGRAM_DRAFT_PREVIEW_CHAR_LIMIT));
}

export function renderTelegramPlanDraft(text: string): TelegramRenderedMessage {
  return renderMarkdownToFormattedText(buildPlanPreviewText(buildDraftPreviewWithLimit(text, TELEGRAM_DRAFT_PREVIEW_CHAR_LIMIT)));
}

export function buildRenderedCommentaryMessages(items: string[]): TelegramRenderedMessage[] {
  if (items.length === 0) {
    return [];
  }

  return buildHeaderedMarkdownMessages(buildCommentaryMarkdown(items), "Commentary");
}

export function buildCommentaryArtifactMessage(publicUrl: string, items: string[]): {
  text: string;
  replyMarkup: InlineKeyboardMarkup;
} {
  return buildMarkdownArtifactMessage({
    publicUrl,
    artifact: {
      v: 1,
      type: MiniAppArtifactType.Commentary,
      title: "Commentary",
      markdownText: buildCommentaryMarkdown(items)
    },
    text: "Commentary ready. Open in Mini App.",
    buttonText: "Open commentary"
  });
}

export function buildOversizeCommentaryArtifactMessage(): { text: string } {
  return {
    text: "Commentary ready, but too large for Mini App link."
  };
}

export function buildRenderedCompletionFooter(details: CompletionFooterDetails): TelegramRenderedMessage {
  return renderPreformattedText(buildCompletionFooterText(details), "status");
}

export function buildRenderedInitialPromptMessage(text: string): TelegramRenderedMessage {
  return renderPreformattedText(text, "user prompt");
}

export function buildRenderedPlanMessages(text: string): TelegramRenderedMessage[] {
  return buildHeaderedMarkdownMessages(text, "Plan");
}

export function buildPlanArtifactMessage(publicUrl: string, markdownText: string): {
  text: string;
  replyMarkup: InlineKeyboardMarkup;
} {
  return buildMarkdownArtifactMessage({
    publicUrl,
    artifact: {
      v: 1,
      type: MiniAppArtifactType.Plan,
      title: "Plan",
      markdownText
    },
    text: "Plan is ready",
    buttonText: "Open plan"
  });
}

export function buildOversizePlanArtifactMessage(): { text: string } {
  return {
    text: "Plan ready, but too large for Mini App link."
  };
}

export function buildRenderedAssistantMessages(text: string): TelegramRenderedMessage[] {
  return buildHeaderedMarkdownMessages(text);
}

function buildHeaderedMarkdownMessages(text: string, header?: string): TelegramRenderedMessage[] {
  return buildHeaderedFormattedMessages(renderMarkdownToFormattedText(text), header);
}

function buildMarkdownArtifactMessage(input: {
  publicUrl: string;
  artifact: MiniAppArtifact;
  text: string;
  buttonText: string;
}): {
  text: string;
  replyMarkup: InlineKeyboardMarkup;
} {
  return {
    text: input.text,
    replyMarkup: {
      inline_keyboard: [[{ text: input.buttonText, web_app: { url: buildMiniAppArtifactUrl(input.publicUrl, input.artifact) } }]]
    }
  };
}

function buildHeaderedFormattedMessages(formatted: TelegramRenderedMessage, header?: string): TelegramRenderedMessage[] {
  const reservedHeaderChars = 32;
  const chunks = chunkFormattedText(formatted, TELEGRAM_MESSAGE_CHAR_LIMIT - reservedHeaderChars);

  if (chunks.length === 1) {
    return header ? [prependText(`${header}\n\n`, chunks[0]!)] : chunks;
  }

  return chunks.map((chunk, index) => {
    const prefix = header ? `${header} ${index + 1}/${chunks.length}\n\n` : `Part ${index + 1}/${chunks.length}\n\n`;
    return prependText(prefix, chunk);
  });
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

function buildPlanPreviewText(text: string): string {
  return `Plan\n\n${text}`;
}

function buildCommentaryMarkdown(items: string[]): string {
  return items.map((item) => buildFencedCodeBlock(item)).join("\n\n");
}

function buildTruncatedPreview(text: string, limit: number, prefix: string, suffix: string): string {
  if (text.length <= limit) {
    return text;
  }

  const budget = Math.max(0, limit - prefix.length - suffix.length);
  return `${prefix}${text.slice(-budget)}${suffix}`;
}

function buildStatusText(statusDraft: TurnStatusDraft, elapsedMs: number | null): string {
  const parts: string[] = [];
  const details = buildStatusDetails(statusDraft);

  if (!details) {
    parts.push(statusDraft.state);
  } else {
    parts.push(`${statusDraft.state}: ${details}`);
  }

  if (elapsedMs !== null) {
    parts.push(formatElapsedDuration(elapsedMs));
  }

  const firstLine = parts.join(" · ");
  const snippet = buildStatusSnippet(statusDraft.snippet);
  return snippet ? `${firstLine}\nNow: ${snippet}` : firstLine;
}

function buildRenderedStatusText(
  statusDraft: TurnStatusDraft,
  elapsedMs: number | null
): TelegramRenderedMessage {
  if (statusDraft.state !== "running" || !statusDraft.details?.trim()) {
    return { text: buildStatusText(statusDraft, elapsedMs) };
  }

  const builder = new TelegramEntityBuilder();
  builder.appendText(`${statusDraft.state}: `);
  builder.appendFormatted(renderCodeText(buildStatusDetails(statusDraft) ?? ""));

  if (elapsedMs !== null) {
    builder.appendText(` · ${formatElapsedDuration(elapsedMs)}`);
  }

  const snippet = buildStatusSnippet(statusDraft.snippet);
  if (snippet) {
    builder.appendText(`\nNow: ${snippet}`);
  }

  return builder.build();
}

function buildCompletionFooterText(details: CompletionFooterDetails): string {
  const fileLabel = details.changedFiles === 1 ? "file" : "files";
  const contextLeft =
    typeof details.contextLeftPercent === "number" ? `${details.contextLeftPercent}% left` : "100% left";
  const cwd = shortenHomePath(details.cwd);
  const branch = details.branch?.trim() ? details.branch : "no-branch";
  const model = details.model?.trim() ? details.model : "unknown-model";
  const modelLabel = details.reasoningEffort ? `${model} ${details.reasoningEffort}` : model;

  return [
    modelLabel,
    formatElapsedDuration(details.durationMs, true),
    `${details.changedFiles} ${fileLabel}`,
    contextLeft,
    cwd,
    branch
  ].join(" • ");
}

function formatElapsedDuration(durationMs: number, allowLessThanOneSecond = false): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));

  if (allowLessThanOneSecond && totalSeconds === 0) {
    return "<1s";
  }

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function buildStatusSnippet(text: string | null): string | null {
  if (!text) {
    return null;
  }

  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return null;
  }

  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function buildStatusDetails(statusDraft: TurnStatusDraft): string | null {
  if (!statusDraft.details) {
    return null;
  }

  const normalized = statusDraft.details.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return null;
  }

  return normalized;
}

function buildFencedCodeBlock(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  const fenceLength = Math.max(3, getLongestBacktickRun(normalized) + 1);
  const fence = "`".repeat(fenceLength);
  return `${fence}\n${normalized}\n${fence}`;
}

function getLongestBacktickRun(text: string): number {
  let longest = 0;
  let current = 0;

  for (const char of text) {
    if (char === "`") {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }

  return longest;
}

function shortenHomePath(value: string | null): string {
  if (!value) {
    return "(unknown cwd)";
  }

  if (value === process.env.HOME) {
    return "~";
  }

  if (process.env.HOME && value.startsWith(`${process.env.HOME}/`)) {
    return `~${value.slice(process.env.HOME.length)}`;
  }

  return value;
}
