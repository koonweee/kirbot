import { basename } from "node:path";

import type { CommandExecutionRequestApprovalParams } from "@kirbot/codex-client/generated/codex/v2/CommandExecutionRequestApprovalParams";
import type { ThreadItem } from "@kirbot/codex-client/generated/codex/v2/ThreadItem";
import type { ReasoningEffort } from "@kirbot/codex-client/generated/codex/ReasoningEffort";
import {
  renderCodeText,
  renderMarkdownToFormattedText,
  renderPreformattedText,
  TelegramEntityBuilder,
  truncateFormattedText
} from "@kirbot/telegram-format";
import type {
  InlineKeyboardMarkup,
  TelegramInlineKeyboardButton,
  TelegramRenderedMessage
} from "../telegram-messenger";
import type { ActivityLogEntry, ActivityLogLabel, QueueStateSnapshot } from "../turn-runtime";
import {
  buildMiniAppArtifactUrl,
  MiniAppArtifactType,
  type MiniAppArtifact
} from "../mini-app/url";

const TELEGRAM_MESSAGE_CHAR_LIMIT = 4000;
const TELEGRAM_DRAFT_PREVIEW_CHAR_LIMIT = 3500;
const COMMAND_FAILURE_OUTPUT_CHAR_LIMIT = 1200;
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
  | "failed"
  | "interrupted";

export type TurnStatusDraft = {
  state: TurnStatusState;
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

export function buildStatusDraft(state: TurnStatusState): TurnStatusDraft {
  return { state };
}

export function buildStatusDraftForItem(item: ThreadItem): TurnStatusDraft {
  switch (item.type) {
    case "reasoning":
      return buildStatusDraft("thinking");
    case "commandExecution":
      return buildStatusDraft("running");
    case "fileChange":
      return buildStatusDraft("editing");
    case "plan":
      return buildStatusDraft("planning");
    case "mcpToolCall":
      return buildStatusDraft("using tool");
    case "dynamicToolCall":
      return buildStatusDraft("using tool");
    case "collabAgentToolCall":
      return buildStatusDraft("using tool");
    case "webSearch":
      return buildStatusDraft("searching");
    default:
      return buildStatusDraft("thinking");
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
      return buildRenderedCommandExecutionCompletionMessage(item);
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

export function buildRenderedCommandApprovalPrompt(
  params: CommandExecutionRequestApprovalParams
): TelegramRenderedMessage {
  const builder = new TelegramEntityBuilder();
  builder.appendText("Command approval needed");

  const reason = buildCommandApprovalReason(params);
  if (reason) {
    builder.appendText("\n\nReason: ");
    builder.appendText(reason);
  }

  builder.appendText("\n\n");
  builder.appendFormatted(renderPreformattedText(params.command?.trim() || "(unknown command)"));

  builder.appendText("\n\nCWD: ");
  builder.appendFormatted(renderCodeText(params.cwd?.trim() || "(unknown cwd)"));

  const intent = summarizeCommandActions(params.commandActions ?? null);
  if (intent) {
    builder.appendText("\nIntent: ");
    builder.appendText(intent);
  }

  const permissionLines = buildApprovalPermissionLines(params);
  for (const line of permissionLines) {
    builder.appendText(`\n${line.label}: `);
    if (line.code) {
      builder.appendFormatted(renderCodeText(line.value));
    } else {
      builder.appendText(line.value);
    }
  }

  const scope = buildApprovalScopeNote(params);
  if (scope) {
    builder.appendText("\nScope: ");
    builder.appendText(scope);
  }

  return builder.build();
}

export function isSameStatusDraft(left: TurnStatusDraft | null, right: TurnStatusDraft | null): boolean {
  return left?.state === right?.state;
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

export function buildCommentaryArtifactButton(publicUrl: string, entries: ActivityLogEntry[]): TelegramInlineKeyboardButton {
  return buildMarkdownArtifactButton({
    publicUrl,
    artifact: {
      v: 1,
      type: MiniAppArtifactType.Commentary,
      title: "Commentary",
      markdownText: buildCommentaryMarkdown(entries)
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

export function buildActivityLogEntryForItemStarted(item: ThreadItem): ActivityLogEntry | null {
  void item;
  return null;
}

export function buildActivityLogEntryForItemCompleted(item: ThreadItem): ActivityLogEntry | null {
  switch (item.type) {
    case "commandExecution":
      return buildActivityLogEntryForCommandCompletion(item);
    case "fileChange":
      return buildActivityEventEntry(getFileChangeCompletionLabel(item.status), summarizeFileChanges(item.changes), "inlineCode");
    case "mcpToolCall":
      return buildActivityEventEntry(item.status === "failed" ? "Tool Failed" : "Tool", `${item.server}.${item.tool}`, "inlineCode");
    case "dynamicToolCall":
      return buildActivityEventEntry(item.status === "failed" ? "Tool Failed" : "Tool", item.tool, "inlineCode");
    case "collabAgentToolCall":
      return buildActivityEventEntry(
        item.status === "failed" ? "Agent Task Failed" : "Agent Task",
        item.tool,
        "inlineCode"
      );
    case "webSearch":
      return buildActivityEventEntry("Web Search", item.query, "text");
    default:
      return null;
  }
}

function buildCommentaryMarkdown(entries: ActivityLogEntry[]): string {
  const renderedEntries = entries.flatMap((entry) => renderActivityLogEntry(entry));
  return renderedEntries.length > 0 ? `## Activity Log\n\n${renderedEntries.join("\n\n")}` : "";
}

function renderActivityLogEntry(entry: ActivityLogEntry): string[] {
  if (entry.kind === "commentary") {
    const text = entry.text.trim();
    return text.length > 0 ? [`**Commentary**\n\n${text}`] : [];
  }

  if (entry.kind === "commandFailure") {
    return [buildCommandFailureMarkdown(entry)];
  }

  const detail = formatActivityDetail(entry.detail, entry.detailStyle);
  if (!detail) {
    return [`- **${entry.label}**`];
  }

  if (entry.detailStyle === "codeBlock") {
    return [`- **${entry.label}**\n${detail}`];
  }

  return [`- **${entry.label}:** ${detail}`];
}

function buildActivityLogEntryForCommandCompletion(
  item: Extract<ThreadItem, { type: "commandExecution" }>
): ActivityLogEntry {
  if (item.status === "declined") {
    return {
      kind: "commandFailure",
      title: "Command declined",
      command: item.command,
      cwd: item.cwd,
      exitCode: null,
      durationMs: item.durationMs,
      errorOutput: null
    };
  }

  if (isCommandExecutionFailed(item)) {
    return {
      kind: "commandFailure",
      title: "Command failed",
      command: item.command,
      cwd: item.cwd,
      exitCode: item.exitCode,
      durationMs: item.durationMs,
      errorOutput: item.aggregatedOutput
    };
  }

  return buildActivityEventEntry("Command", item.command, "codeBlock");
}

function buildActivityEventEntry(
  label: ActivityLogLabel,
  detail: string | null,
  detailStyle: "codeBlock" | "inlineCode" | "text"
): ActivityLogEntry {
  const normalizedDetail = detail?.trim() ?? "";
  return {
    kind: "activity",
    label,
    detail: normalizedDetail.length > 0 ? normalizedDetail : null,
    detailStyle
  };
}

function getFileChangeCompletionLabel(
  status: Extract<ThreadItem, { type: "fileChange" }>["status"]
): "File Edit" | "File Edit Failed" | "File Edit Declined" {
  switch (status) {
    case "declined":
      return "File Edit Declined";
    case "failed":
      return "File Edit Failed";
    default:
      return "File Edit";
  }
}

function formatActivityDetail(detail: string | null, style: "codeBlock" | "inlineCode" | "text"): string | null {
  if (!detail) {
    return null;
  }

  if (style === "codeBlock") {
    return buildFencedCodeBlock(detail);
  }

  return style === "inlineCode" ? renderInlineCodeMarkdown(detail) : escapeMarkdownText(detail);
}

function renderInlineCodeMarkdown(value: string): string {
  const maxFenceLength = Math.max(...Array.from(value.matchAll(/`+/g), (match) => match[0].length), 0) + 1;
  const fence = "`".repeat(Math.max(1, maxFenceLength));
  const padded = /^[` ]|[` ]$/.test(value) ? ` ${value} ` : value;
  return `${fence}${padded}${fence}`;
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+\-!>|])/g, "\\$1");
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
  parts.push(statusDraft.state);

  if (elapsedMs !== null) {
    parts.push(formatElapsedDuration(elapsedMs));
  }

  return parts.join(" · ");
}

function buildRenderedStatusText(
  statusDraft: TurnStatusDraft,
  elapsedMs: number | null
): TelegramRenderedMessage {
  return { text: buildStatusText(statusDraft, elapsedMs) };
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
  return `${minutes}m ${seconds}s`;
}

function buildRenderedCommandExecutionCompletionMessage(
  item: Extract<ThreadItem, { type: "commandExecution" }>
): TelegramRenderedMessage {
  if (item.status === "declined") {
    return buildRenderedCommandFailureMessage({
      title: "Command declined",
      command: item.command,
      cwd: item.cwd,
      exitCode: null,
      durationMs: item.durationMs,
      errorOutput: null
    });
  }

  if (isCommandExecutionFailed(item)) {
    return buildRenderedCommandFailureMessage({
      title: "Command failed",
      command: item.command,
      cwd: item.cwd,
      exitCode: item.exitCode,
      durationMs: item.durationMs,
      errorOutput: item.aggregatedOutput
    });
  }

  return buildLabeledCodeMessage("Command completed: ", item.command);
}

function buildRenderedCommandFailureMessage(input: {
  title: "Command failed" | "Command declined";
  command: string;
  cwd: string | null;
  exitCode: number | null;
  durationMs: number | null;
  errorOutput: string | null;
}): TelegramRenderedMessage {
  const builder = new TelegramEntityBuilder();
  builder.appendText(input.title);
  builder.appendText("\n\n");
  builder.appendFormatted(renderPreformattedText(input.command.trim() || "(unknown command)"));
  builder.appendText("\n\nCWD: ");
  builder.appendFormatted(renderCodeText(input.cwd?.trim() || "(unknown cwd)"));

  if (input.exitCode !== null) {
    builder.appendText("\nExit code: ");
    builder.appendFormatted(renderCodeText(String(input.exitCode)));
  }

  if (input.durationMs !== null) {
    builder.appendText("\nDuration: ");
    builder.appendFormatted(renderCodeText(formatElapsedDuration(input.durationMs, true)));
  }

  const errorOutput = truncateCommandFailureOutput(input.errorOutput);
  if (errorOutput) {
    builder.appendText("\n\nError\n\n");
    builder.appendFormatted(renderPreformattedText(errorOutput));
  }

  return builder.build();
}

function buildCommandFailureMarkdown(entry: Extract<ActivityLogEntry, { kind: "commandFailure" }>): string {
  const sections = [
    `**${escapeMarkdownText(entry.title)}**`,
    buildFencedCodeBlock(entry.command.trim() || "(unknown command)")
  ];

  const metadataLines = [
    `CWD: ${renderInlineCodeMarkdown(entry.cwd?.trim() || "(unknown cwd)")}`,
    ...(entry.exitCode !== null ? [`Exit code: ${renderInlineCodeMarkdown(String(entry.exitCode))}`] : []),
    ...(entry.durationMs !== null
      ? [`Duration: ${renderInlineCodeMarkdown(formatElapsedDuration(entry.durationMs, true))}`]
      : [])
  ];
  sections.push(metadataLines.join("  \n"));

  const errorOutput = truncateCommandFailureOutput(entry.errorOutput);
  if (errorOutput) {
    sections.push(`Error\n\n${buildFencedCodeBlock(errorOutput)}`);
  }

  return sections.join("\n\n");
}

function truncateCommandFailureOutput(output: string | null): string | null {
  const normalized = output?.replace(/\r\n/g, "\n").trim() ?? "";
  if (!normalized) {
    return null;
  }

  return buildTruncatedPreview(normalized, COMMAND_FAILURE_OUTPUT_CHAR_LIMIT, "...\n", "");
}

function buildCommandApprovalReason(params: CommandExecutionRequestApprovalParams): string | null {
  if (params.reason?.trim()) {
    return params.reason.trim();
  }

  if (params.networkApprovalContext) {
    return `network access required for ${params.networkApprovalContext.protocol}://${params.networkApprovalContext.host}`;
  }

  if (params.additionalPermissions) {
    return "additional permissions required";
  }

  return null;
}

function summarizeCommandActions(actions: CommandExecutionRequestApprovalParams["commandActions"]): string | null {
  if (!actions || actions.length === 0) {
    return null;
  }

  const summaries = actions
    .slice(0, 3)
    .map((action) => {
      switch (action.type) {
        case "read":
          return `read ${action.name} from ${action.path}`;
        case "listFiles":
          return action.path ? `list files in ${action.path}` : "list files";
        case "search":
          return action.query
            ? `search for ${action.query}${action.path ? ` in ${action.path}` : ""}`
            : action.path
              ? `search ${action.path}`
              : "search files";
        case "unknown":
        default:
          return null;
      }
    })
    .filter((value): value is string => Boolean(value));

  if (summaries.length === 0) {
    return null;
  }

  return summaries.join(", ");
}

function buildApprovalPermissionLines(
  params: CommandExecutionRequestApprovalParams
): Array<{ label: string; value: string; code: boolean }> {
  const lines: Array<{ label: string; value: string; code: boolean }> = [];

  if (params.networkApprovalContext) {
    lines.push({
      label: "Network",
      value: `${params.networkApprovalContext.protocol}://${params.networkApprovalContext.host}`,
      code: true
    });
  }

  const permissionSummary = summarizeAdditionalPermissions(params);
  if (permissionSummary) {
    lines.push({
      label: "Permissions",
      value: permissionSummary,
      code: false
    });
  }

  if (params.skillMetadata?.pathToSkillsMd?.trim()) {
    lines.push({
      label: "Skill",
      value: params.skillMetadata.pathToSkillsMd.trim(),
      code: true
    });
  }

  return lines;
}

function summarizeAdditionalPermissions(params: CommandExecutionRequestApprovalParams): string | null {
  const profile = params.additionalPermissions;
  if (!profile) {
    return null;
  }

  const parts: string[] = [];
  if (profile.network?.enabled) {
    parts.push("network");
  }

  const readCount = profile.fileSystem?.read?.length ?? 0;
  if (readCount > 0) {
    parts.push(`filesystem read (${readCount})`);
  }

  const writeCount = profile.fileSystem?.write?.length ?? 0;
  if (writeCount > 0) {
    parts.push(`filesystem write (${writeCount})`);
  }

  if (profile.macos) {
    parts.push("macOS");
  }

  return parts.length > 0 ? parts.join(", ") : null;
}

function buildApprovalScopeNote(params: CommandExecutionRequestApprovalParams): string | null {
  const decisions = params.availableDecisions ?? [];
  const hasSession = decisions.some((decision) => decision === "acceptForSession");
  const hasReusable = decisions.some((decision) => typeof decision === "object" && decision !== null);

  if (hasSession && hasReusable) {
    return "allow only this run, allow matching runs for this session, or apply the proposed reusable permission";
  }

  if (hasSession) {
    return "allow only this run, or all matching runs for this session";
  }

  if (hasReusable) {
    return "this approval includes a proposed reusable permission for similar requests";
  }

  if (decisions.some((decision) => decision === "accept")) {
    return "this approval is for this command only";
  }

  return null;
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
