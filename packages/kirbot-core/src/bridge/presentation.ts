import { basename } from "node:path";

import type { ThreadItem } from "@kirbot/codex-client/generated/codex/v2/ThreadItem";
import type { ReasoningEffort } from "@kirbot/codex-client/generated/codex/ReasoningEffort";
import {
  renderCodeText,
  renderMarkdownToFormattedText,
  renderPreformattedText,
  renderQuotedText,
  TelegramEntityBuilder,
  truncateFormattedText
} from "@kirbot/telegram-format";
import type {
  InlineKeyboardMarkup,
  TelegramInlineKeyboardButton,
  TelegramRenderedMessage
} from "../telegram-messenger";
import type { QueueStateSnapshot } from "../turn-runtime";
import {
  buildMiniAppArtifactUrl,
  MiniAppArtifactType,
  type MiniAppArtifact
} from "../mini-app/url";

const TELEGRAM_MESSAGE_CHAR_LIMIT = 4000;
const TELEGRAM_DRAFT_PREVIEW_CHAR_LIMIT = 3500;
const TELEGRAM_STATUS_QUOTE_PREVIEW_CHAR_LIMIT = 280;
const RESPONSE_TRUNCATED_VIEW_SUFFIX = "\n\n[response truncated, continue in View]";
const RESPONSE_TRUNCATED_SUFFIX = "\n\n[response truncated]";
export const TOPIC_IMPLEMENT_CALLBACK_DATA = "topic:implement";

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
  inlineDetails: string | null;
  quotedDetails: string | null;
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
  inlineDetails: string | null = null,
  quotedDetails: string | null = null
): TurnStatusDraft {
  switch (state) {
    case "thinking":
      return { state, emoji: "🤔", inlineDetails, quotedDetails };
    case "planning":
      return { state, emoji: "🗺️", inlineDetails, quotedDetails };
    case "using tool":
      return { state, emoji: "🛠️", inlineDetails, quotedDetails };
    case "running":
      return { state, emoji: "💻", inlineDetails, quotedDetails };
    case "editing":
      return { state, emoji: "✏️", inlineDetails, quotedDetails };
    case "searching":
      return { state, emoji: "🔎", inlineDetails, quotedDetails };
    case "streaming":
      return { state, emoji: "✍️", inlineDetails, quotedDetails };
    case "waiting":
      return { state, emoji: "⏸️", inlineDetails, quotedDetails };
    case "done":
      return { state, emoji: "✅", inlineDetails, quotedDetails };
    case "failed":
      return { state, emoji: "❌", inlineDetails, quotedDetails };
    case "interrupted":
      return { state, emoji: "⏹️", inlineDetails, quotedDetails };
  }
}

export function buildStatusDraftForItem(item: ThreadItem): TurnStatusDraft {
  switch (item.type) {
    case "reasoning":
      return buildStatusDraft("thinking");
    case "commandExecution":
      return buildStatusDraft("running", null, item.command);
    case "fileChange":
      return buildStatusDraft("editing", null, summarizeFileChanges(item.changes));
    case "plan":
      return buildStatusDraft("planning");
    case "mcpToolCall":
      return buildStatusDraft("using tool", null, `${item.server}.${item.tool}`);
    case "dynamicToolCall":
      return buildStatusDraft("using tool", null, item.tool);
    case "collabAgentToolCall":
      return buildStatusDraft("using tool", null, item.tool);
    case "webSearch":
      return buildStatusDraft("searching", item.query);
    default:
      return buildStatusDraft("thinking");
  }
}

export function buildCompletedStatusDraftForItem(item: ThreadItem): TurnStatusDraft | null {
  switch (item.type) {
    case "commandExecution":
      return buildStatusDraft("done", null, item.command);
    case "fileChange":
      return buildStatusDraft("done", null, summarizeFileChanges(item.changes));
    case "mcpToolCall":
      return buildStatusDraft("done", null, `${item.server}.${item.tool}`);
    case "dynamicToolCall":
      return buildStatusDraft("done", null, item.tool);
    case "collabAgentToolCall":
      return buildStatusDraft("done", null, item.tool);
    case "webSearch":
      return buildStatusDraft("done", null, item.query);
    case "imageView":
      return buildStatusDraft("done", null, basename(item.path) || item.path);
    case "imageGeneration":
      return isImageGenerationSuccess(item) ? buildStatusDraft("done", null, "image generated") : null;
    case "enteredReviewMode": {
      const review = item.review.trim();
      return buildStatusDraft("done", null, review ? `review mode: ${review}` : "review mode");
    }
    case "exitedReviewMode": {
      const review = item.review.trim();
      return buildStatusDraft("done", null, review ? `exited review mode: ${review}` : "exited review mode");
    }
    case "contextCompaction":
      return buildStatusDraft("done", null, "context compacted");
    default:
      return null;
  }
}

export function isDurableCompletedItem(item: ThreadItem): boolean {
  switch (item.type) {
    case "commandExecution":
      return isCommandExecutionFailed(item);
    case "fileChange":
      return item.status !== "completed";
    case "mcpToolCall":
    case "dynamicToolCall":
    case "collabAgentToolCall":
      return item.status === "failed";
    case "imageGeneration":
      return !isImageGenerationSuccess(item);
    default:
      return false;
  }
}

export function buildRenderedCompletedItemMessage(item: ThreadItem): TelegramRenderedMessage | null {
  switch (item.type) {
    case "reasoning":
      return null;
    case "commandExecution":
      return buildLabeledCodeMessage(
        isCommandExecutionFailed(item) ? "Command failed: " : "Command completed: ",
        item.command
      );
    case "fileChange":
      return buildRenderedFileChangeCompletionMessage(item.status, item.changes);
    case "mcpToolCall":
      return {
        text: `${item.status === "failed" ? "Tool failed" : "Tool completed"}: ${item.server}.${item.tool}`
      };
    case "dynamicToolCall":
      return {
        text: `${item.status === "failed" ? "Tool failed" : "Tool completed"}: ${item.tool}`
      };
    case "collabAgentToolCall":
      return {
        text: `${item.status === "failed" ? "Agent task failed" : "Agent task updated"}: ${item.tool}`
      };
    case "webSearch": {
      const query = item.query.trim();
      return { text: query ? `Web search completed: ${query}` : "Web search completed." };
    }
    case "imageView":
      return buildLabeledCodeMessage("Viewed image: ", basename(item.path) || item.path);
    case "imageGeneration":
      return { text: isImageGenerationSuccess(item) ? "Image generated." : "Image generation failed." };
    case "enteredReviewMode": {
      const review = item.review.trim();
      return { text: review ? `Entered review mode: ${review}` : "Entered review mode." };
    }
    case "exitedReviewMode": {
      const review = item.review.trim();
      return { text: review ? `Exited review mode: ${review}` : "Exited review mode." };
    }
    case "contextCompaction":
      return { text: "Context compacted." };
    default:
      return null;
  }
}

export function isSameStatusDraft(left: TurnStatusDraft | null, right: TurnStatusDraft | null): boolean {
  return (
    left?.state === right?.state &&
    left?.emoji === right?.emoji &&
    left?.inlineDetails === right?.inlineDetails &&
    left?.quotedDetails === right?.quotedDetails
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

export function buildCommentaryArtifactButton(publicUrl: string, items: string[]): TelegramInlineKeyboardButton {
  return buildMarkdownArtifactButton({
    publicUrl,
    artifact: {
      v: 1,
      type: MiniAppArtifactType.Commentary,
      title: "Commentary",
      markdownText: buildCommentaryMarkdown(items)
    },
    buttonText: "Commentary"
  });
}

export function buildResponseArtifactButton(publicUrl: string, markdownText: string): TelegramInlineKeyboardButton {
  return buildMarkdownArtifactButton({
    publicUrl,
    artifact: {
      v: 1,
      type: MiniAppArtifactType.Response,
      title: "Response",
      markdownText
    },
    buttonText: "Response"
  });
}

export function buildArtifactReplyMarkup(buttons: TelegramInlineKeyboardButton[]): InlineKeyboardMarkup {
  return {
    inline_keyboard: [buttons]
  };
}

export function buildCommentaryArtifactStubMessage(replyMarkup: InlineKeyboardMarkup): {
  text: string;
  replyMarkup: InlineKeyboardMarkup;
} {
  return {
    text: "Commentary is available.",
    replyMarkup
  };
}

export function buildOversizeCommentaryArtifactMessage(): { text: string } {
  return {
    text: "Commentary artifact was too large to encode."
  };
}

export function buildOversizeResponseArtifactMessage(): { text: string } {
  return {
    text: "Response artifact was too large to encode."
  };
}

export function buildRenderedCompletionFooter(details: CompletionFooterDetails): TelegramRenderedMessage {
  return renderPreformattedText(buildCompletionFooterText(details), "status");
}

export function buildRenderedInitialPromptMessage(text: string): TelegramRenderedMessage {
  return renderPreformattedText(text, "user prompt");
}

export function buildRenderedAssistantMessage(
  text: string,
  options?: { includeContinueInViewNote?: boolean }
): TelegramRenderedMessage {
  return truncateFormattedText(
    renderMarkdownToFormattedText(text),
    TELEGRAM_MESSAGE_CHAR_LIMIT,
    options?.includeContinueInViewNote ? RESPONSE_TRUNCATED_VIEW_SUFFIX : RESPONSE_TRUNCATED_SUFFIX
  );
}

export function buildPlanArtifactMessage(publicUrl: string, markdownText: string): {
  text: string;
  replyMarkup: InlineKeyboardMarkup;
} {
  return {
    text: "Plan is ready",
    replyMarkup: buildArtifactReplyMarkup([
      buildMarkdownArtifactButton({
        publicUrl,
        artifact: {
          v: 1,
          type: MiniAppArtifactType.Plan,
          title: "Plan",
          markdownText
        },
        buttonText: "Plan"
      }),
      {
        text: "Implement",
        callback_data: TOPIC_IMPLEMENT_CALLBACK_DATA
      }
    ])
  };
}

export function buildOversizePlanArtifactMessage(): { text: string } {
  return {
    text: "Plan artifact was too large to encode."
  };
}

function buildMarkdownArtifactButton(input: {
  publicUrl: string;
  artifact: MiniAppArtifact;
  buttonText: string;
}): TelegramInlineKeyboardButton {
  return { text: input.buttonText, web_app: { url: buildMiniAppArtifactUrl(input.publicUrl, input.artifact) } };
}

function truncateStatus(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function summarizeFileChanges(changes: Array<{ path: string }>): string | null {
  const summary = summarizeFileChangePaths(changes);
  if (!summary) {
    return null;
  }

  if (summary.paths.length === 1) {
    return summary.paths[0] ?? null;
  }

  const [first, second] = summary.paths;
  if (summary.additionalCount === 0 && first && second) {
    return `${first}, ${second}`;
  }

  return `${first ?? changes.length} (+${summary.additionalCount} more)`;
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
  const details = buildInlineStatusDetails(statusDraft);

  if (!details) {
    parts.push(statusDraft.state);
  } else {
    parts.push(`${statusDraft.state}: ${details}`);
  }

  if (elapsedMs !== null) {
    parts.push(formatElapsedDuration(elapsedMs));
  }

  return parts.join(" · ");
}

function buildRenderedStatusText(
  statusDraft: TurnStatusDraft,
  elapsedMs: number | null
): TelegramRenderedMessage {
  const quotedDetails = buildQuotedStatusDetails(statusDraft);
  const text = buildStatusText(statusDraft, elapsedMs);

  if (!quotedDetails) {
    return { text };
  }

  const builder = new TelegramEntityBuilder();
  builder.appendText(text);
  builder.appendText("\n\n");
  builder.appendFormatted(renderQuotedText(quotedDetails, { kind: "blockquote" }));
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

function buildInlineStatusDetails(statusDraft: TurnStatusDraft): string | null {
  if (!statusDraft.inlineDetails) {
    return null;
  }

  const normalized = statusDraft.inlineDetails.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return null;
  }

  return normalized;
}

function buildQuotedStatusDetails(statusDraft: TurnStatusDraft): string | null {
  if (!statusDraft.quotedDetails) {
    return null;
  }

  const normalized = statusDraft.quotedDetails.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return null;
  }

  return normalized.length > TELEGRAM_STATUS_QUOTE_PREVIEW_CHAR_LIMIT
    ? `${normalized.slice(0, TELEGRAM_STATUS_QUOTE_PREVIEW_CHAR_LIMIT - 3)}...`
    : normalized;
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

function summarizeFileChangePaths(changes: Array<{ path: string }>): { paths: string[]; additionalCount: number } | null {
  if (changes.length === 0) {
    return null;
  }

  if (changes.length === 1) {
    return { paths: [changes[0]?.path ?? ""], additionalCount: 0 };
  }

  const [first, second] = changes;
  if (changes.length === 2) {
    return {
      paths: [first?.path ?? "", second?.path ?? ""].filter((path) => path.length > 0),
      additionalCount: 0
    };
  }

  return {
    paths: first?.path ? [first.path] : [],
    additionalCount: changes.length - 1
  };
}

function buildRenderedFileChangeCompletionMessage(
  status: "inProgress" | "completed" | "failed" | "declined",
  changes: Array<{ path: string }>
): TelegramRenderedMessage {
  const builder = new TelegramEntityBuilder();
  builder.appendText(status === "completed" ? "Applied file changes: " : "File changes failed: ");
  appendInlineCodeFileSummary(builder, changes);
  return builder.build();
}

function appendInlineCodeFileSummary(builder: TelegramEntityBuilder, changes: Array<{ path: string }>): void {
  const summary = summarizeFileChangePaths(changes);
  if (!summary || summary.paths.length === 0) {
    builder.appendText("(unknown files)");
    return;
  }

  summary.paths.forEach((path, index) => {
    if (index > 0) {
      builder.appendText(", ");
    }
    builder.appendFormatted(renderCodeText(path));
  });

  if (summary.additionalCount > 0) {
    builder.appendText(` (+${summary.additionalCount} more)`);
  }
}

function buildLabeledCodeMessage(prefix: string, value: string): TelegramRenderedMessage {
  const builder = new TelegramEntityBuilder();
  builder.appendText(prefix);
  builder.appendFormatted(renderCodeText(value.trim().length > 0 ? value : "(unknown)"));
  return builder.build();
}

function isCommandExecutionFailed(item: Extract<ThreadItem, { type: "commandExecution" }>): boolean {
  return item.status === "failed" || item.status === "declined" || (item.exitCode !== null && item.exitCode !== 0);
}

function isImageGenerationSuccess(item: Extract<ThreadItem, { type: "imageGeneration" }>): boolean {
  return !/fail/i.test(item.status) && item.result.trim().length > 0;
}
