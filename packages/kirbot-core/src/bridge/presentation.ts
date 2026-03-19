import { basename } from "node:path";

import type { CommandExecutionRequestApprovalParams } from "@kirbot/codex-client/generated/codex/v2/CommandExecutionRequestApprovalParams";
import type { FileChangeRequestApprovalParams } from "@kirbot/codex-client/generated/codex/v2/FileChangeRequestApprovalParams";
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
import type { ActivityLogEntry, ActivityLogLabel, QueueStateSnapshot } from "../turn-runtime";
import {
  buildMiniAppArtifactUrl,
  MiniAppArtifactType,
  type MiniAppArtifact
} from "../mini-app/url";

const TELEGRAM_MESSAGE_CHAR_LIMIT = 4000;
const TELEGRAM_DRAFT_PREVIEW_CHAR_LIMIT = 3500;
const COMMAND_FAILURE_OUTPUT_CHAR_LIMIT = 1200;
const FILE_CHANGE_PATH_PREVIEW_LIMIT = 8;
const RESPONSE_TRUNCATED_VIEW_SUFFIX = "\n\n[response truncated, continue in View]";
const RESPONSE_TRUNCATED_SUFFIX = "\n\n[response truncated]";
const COMMENTARY_LOGS_LABEL = "Logs";
const MAX_MINI_APP_REPLY_MARKUP_JSON_BYTES = 9_500;
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

type StructuredFailureEntry = Extract<ActivityLogEntry, { kind: "structuredFailure" }>;

export type ArtifactMessage = {
  text: string;
  replyMarkup: InlineKeyboardMarkup;
};

export type ArtifactPublication = {
  attachedButton: TelegramInlineKeyboardButton | null;
  standaloneMessages: ArtifactMessage[];
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
      return buildRenderedFileChangeCompletionMessage(item);
    case "mcpToolCall":
      return item.status === "failed"
        ? buildRenderedStructuredFailureMessage(buildStructuredFailureForMcpToolCall(item))
        : {
            text: `Tool completed: ${item.server}.${item.tool}`
          };
    case "dynamicToolCall":
      return item.status === "failed"
        ? buildRenderedStructuredFailureMessage(buildStructuredFailureForDynamicToolCall(item))
        : {
            text: `Tool completed: ${item.tool}`
          };
    case "collabAgentToolCall":
      return item.status === "failed"
        ? buildRenderedStructuredFailureMessage(buildStructuredFailureForCollabAgentToolCall(item))
        : {
            text: `Agent task updated: ${item.tool}`
          };
    case "webSearch": {
      const query = item.query.trim();
      return { text: query ? `Web search completed: ${query}` : "Web search completed." };
    }
    case "imageView":
      return buildLabeledCodeMessage("Viewed image: ", basename(item.path) || item.path);
    case "imageGeneration":
      return isImageGenerationSuccess(item)
        ? { text: "Image generated." }
        : buildRenderedStructuredFailureMessage(buildStructuredFailureForImageGeneration(item));
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

export function buildRenderedFileChangeApprovalPrompt(
  params: FileChangeRequestApprovalParams
): TelegramRenderedMessage {
  const builder = new TelegramEntityBuilder();
  builder.appendText("File change approval needed");

  if (params.reason?.trim()) {
    builder.appendText("\n\nReason: ");
    builder.appendText(params.reason.trim());
  }

  if (params.grantRoot?.trim()) {
    builder.appendText("\nRequested root: ");
    builder.appendFormatted(renderCodeText(params.grantRoot.trim()));
    builder.appendText("\nScope: this approval is for this change; accepting also proposes this write root for the session");
  } else {
    builder.appendText("\nScope: this approval is for this file change only");
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
  const replyMarkup = {
    inline_keyboard: [buttons]
  };

  if (measureReplyMarkupJsonBytes(replyMarkup) > MAX_MINI_APP_REPLY_MARKUP_JSON_BYTES) {
    throw new Error("mini_app_artifact_too_large");
  }

  return replyMarkup;
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

export function buildCommentaryArtifactPublication(
  publicUrl: string,
  entries: ActivityLogEntry[],
  options?: { attachToAssistant?: boolean }
): ArtifactPublication {
  if (entries.length === 0) {
    return {
      attachedButton: null,
      standaloneMessages: []
    };
  }

  const chunks = buildCommentaryArtifactChunks(publicUrl, entries);
  if ((options?.attachToAssistant ?? false) && chunks.length === 1) {
    return {
      attachedButton: buildCommentaryArtifactButton(publicUrl, chunks[0] ?? []),
      standaloneMessages: []
    };
  }

  return {
    attachedButton: null,
    standaloneMessages: chunks.map((chunk, index) =>
      buildArtifactAvailabilityMessage(
        buildCommentaryArtifactButton(publicUrl, chunk),
        buildArtifactAvailabilityText("Commentary", index, chunks.length, "available")
      )
    )
  };
}

export function buildResponseArtifactPublication(
  publicUrl: string,
  markdownText: string
): ArtifactPublication {
  const chunks = buildMarkdownArtifactChunks({
    publicUrl,
    artifactType: MiniAppArtifactType.Response,
    title: "Response",
    buttonText: "Response",
    markdownText,
    splitKind: "paragraphs"
  });
  if (chunks.length === 1) {
    return {
      attachedButton: buildResponseArtifactButton(publicUrl, chunks[0] ?? ""),
      standaloneMessages: []
    };
  }

  return {
    attachedButton: null,
    standaloneMessages: chunks.map((chunk, index) =>
      buildArtifactAvailabilityMessage(
        buildResponseArtifactButton(publicUrl, chunk),
        buildArtifactAvailabilityText("Response", index, chunks.length, "available")
      )
    )
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

export function buildPlanArtifactMessages(publicUrl: string, markdownText: string): ArtifactMessage[] {
  const implementButton: TelegramInlineKeyboardButton = {
    text: "Implement",
    callback_data: TOPIC_IMPLEMENT_CALLBACK_DATA
  };
  const chunks = buildMarkdownArtifactChunks({
    publicUrl,
    artifactType: MiniAppArtifactType.Plan,
    title: "Plan",
    buttonText: "Plan",
    markdownText,
    splitKind: "lines",
    trailingButtons: [implementButton]
  });

  return chunks.map((chunk, index) => {
    const planButton = buildMarkdownArtifactButton({
      publicUrl,
      artifact: {
        v: 1,
        type: MiniAppArtifactType.Plan,
        title: "Plan",
        markdownText: chunk
      },
      buttonText: "Plan"
    });

    return {
      text: buildArtifactAvailabilityText("Plan", index, chunks.length, "ready"),
      replyMarkup: buildArtifactReplyMarkup([
        planButton,
        ...(index === chunks.length - 1 ? [implementButton] : [])
      ])
    };
  });
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
      return item.status === "completed"
        ? buildActivityEventEntry("File Edit", summarizeFileChanges(item.changes), "inlineCode")
        : buildStructuredFailureForFileChange(item);
    case "mcpToolCall":
      return item.status === "failed"
        ? buildStructuredFailureForMcpToolCall(item)
        : buildActivityEventEntry("Tool", `${item.server}.${item.tool}`, "inlineCode");
    case "dynamicToolCall":
      return item.status === "failed"
        ? buildStructuredFailureForDynamicToolCall(item)
        : buildActivityEventEntry("Tool", item.tool, "inlineCode");
    case "collabAgentToolCall":
      return item.status === "failed"
        ? buildStructuredFailureForCollabAgentToolCall(item)
        : buildActivityEventEntry("Agent Task", item.tool, "inlineCode");
    case "webSearch":
      return buildActivityEventEntry("Web Search", item.query, "text");
    case "imageGeneration":
      return isImageGenerationSuccess(item) ? null : buildStructuredFailureForImageGeneration(item);
    default:
      return null;
  }
}

function buildCommentaryMarkdown(entries: ActivityLogEntry[]): string {
  return buildCommentaryMarkdownSections(entries).join("\n\n");
}

function buildCommentaryMarkdownSections(entries: ActivityLogEntry[]): string[] {
  const sections: string[] = [];
  let activityBuffer: Array<Exclude<ActivityLogEntry, { kind: "commentary" }>> = [];

  const flushActivityBuffer = (): void => {
    if (activityBuffer.length === 0) {
      return;
    }

    const rendered = renderCollapsibleActivityLog(activityBuffer);
    if (rendered) {
      sections.push(rendered);
    }
    activityBuffer = [];
  };

  for (const entry of entries) {
    if (entry.kind === "commentary") {
      const text = entry.text.trim();
      if (!text) {
        continue;
      }

      flushActivityBuffer();
      sections.push(text);
      continue;
    }

    activityBuffer.push(entry);
  }

  flushActivityBuffer();
  return sections;
}

function renderCollapsibleActivityLog(entries: Array<Exclude<ActivityLogEntry, { kind: "commentary" }>>): string {
  const renderedEntries = entries.flatMap((entry) => renderActivityLogEntry(entry));
  if (renderedEntries.length === 0) {
    return "";
  }

  return [`:::details ${COMMENTARY_LOGS_LABEL} (${entries.length})`, renderedEntries.join("\n\n"), ":::"].join("\n");
}

function measureReplyMarkupJsonBytes(replyMarkup: InlineKeyboardMarkup): number {
  return Buffer.byteLength(JSON.stringify(replyMarkup), "utf8");
}

function buildArtifactAvailabilityMessage(button: TelegramInlineKeyboardButton, text: string): ArtifactMessage {
  return {
    text,
    replyMarkup: buildArtifactReplyMarkup([button])
  };
}

function buildArtifactAvailabilityText(
  label: "Commentary" | "Response" | "Plan",
  index: number,
  total: number,
  state: "available" | "ready"
): string {
  if (total <= 1) {
    return label === "Plan" ? "Plan is ready" : `${label} is available.`;
  }

  return `${label} part ${index + 1} of ${total} is ${state}.`;
}

function buildCommentaryArtifactChunks(publicUrl: string, entries: ActivityLogEntry[]): ActivityLogEntry[][] {
  const normalizedEntries = entries.flatMap((entry) => splitOversizedCommentaryEntry(publicUrl, entry));
  return packSequentialItems(normalizedEntries, (chunk) => {
    buildArtifactReplyMarkup([buildCommentaryArtifactButton(publicUrl, chunk)]);
  });
}

function splitOversizedCommentaryEntry(publicUrl: string, entry: ActivityLogEntry): ActivityLogEntry[] {
  if (entry.kind !== "commentary") {
    return [entry];
  }

  return splitOversizedCommentaryText(publicUrl, entry.text).map((text) => ({
    kind: "commentary" as const,
    text
  }));
}

function splitOversizedCommentaryText(publicUrl: string, text: string): string[] {
  return splitOversizedTextByBudget({
    text,
    splitKind: "paragraphs",
    fits(candidate) {
      buildArtifactReplyMarkup([
        buildCommentaryArtifactButton(publicUrl, [
          {
            kind: "commentary",
            text: candidate
          }
        ])
      ]);
    }
  });
}

function buildMarkdownArtifactChunks(input: {
  publicUrl: string;
  artifactType: MiniAppArtifactType;
  title: string;
  buttonText: string;
  markdownText: string;
  splitKind: "paragraphs" | "lines";
  trailingButtons?: TelegramInlineKeyboardButton[];
}): string[] {
  const normalizedSections = splitOversizedTextByBudget({
    text: input.markdownText,
    splitKind: input.splitKind,
    fits: (candidate) => {
      const button = buildMarkdownArtifactButton({
        publicUrl: input.publicUrl,
        artifact: {
          v: 1,
          type: input.artifactType,
          title: input.title,
          markdownText: candidate
        },
        buttonText: input.buttonText
      });
      buildArtifactReplyMarkup([button, ...(input.trailingButtons ?? [])]);
    }
  });

  return packSequentialItems(normalizedSections, (chunk) => {
    const markdownText = chunk.join(input.splitKind === "paragraphs" ? "\n\n" : "\n");
    const button = buildMarkdownArtifactButton({
      publicUrl: input.publicUrl,
      artifact: {
        v: 1,
        type: input.artifactType,
        title: input.title,
        markdownText
      },
      buttonText: input.buttonText
    });
    buildArtifactReplyMarkup([button, ...(input.trailingButtons ?? [])]);
  }).map((chunk) => chunk.join(input.splitKind === "paragraphs" ? "\n\n" : "\n"));
}

function splitOversizedTextByBudget(input: {
  text: string;
  splitKind: "paragraphs" | "lines";
  fits(candidate: string): void;
}): string[] {
  const sections = splitTextSections(input.text, input.splitKind);
  return sections.flatMap((section) => splitSectionUntilItFits(section, input.fits, input.splitKind));
}

function splitSectionUntilItFits(
  section: string,
  fits: (candidate: string) => void,
  splitKind: "paragraphs" | "lines"
): string[] {
  const normalized = section.trim();
  if (!normalized) {
    return [];
  }

  try {
    fits(normalized);
    return [normalized];
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "mini_app_artifact_too_large") {
      throw error;
    }
  }

  const fallbackSplitters = splitKind === "paragraphs" ? [splitParagraphs, splitLines] : [splitLines];

  for (const split of fallbackSplitters) {
    const parts = split(normalized);
    if (parts.length <= 1) {
      continue;
    }

    return parts.flatMap((part) => splitSectionUntilItFits(part, fits, splitKind));
  }

  if (normalized.length <= 1) {
    throw new Error("mini_app_artifact_too_large");
  }

  const midpoint = Math.ceil(normalized.length / 2);
  return [
    ...splitSectionUntilItFits(normalized.slice(0, midpoint), fits, splitKind),
    ...splitSectionUntilItFits(normalized.slice(midpoint), fits, splitKind)
  ];
}

function packSequentialItems<T>(items: T[], assertFits: (items: T[]) => void): T[][] {
  if (items.length === 0) {
    return [];
  }

  const chunks: T[][] = [];
  let currentChunk: T[] = [];

  for (const item of items) {
    const candidate = [...currentChunk, item];
    try {
      assertFits(candidate);
      currentChunk = candidate;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "mini_app_artifact_too_large") {
        throw error;
      }

      if (currentChunk.length === 0) {
        throw error;
      }

      chunks.push(currentChunk);
      currentChunk = [item];
      assertFits(currentChunk);
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function splitTextSections(text: string, splitKind: "paragraphs" | "lines"): string[] {
  const sections = (splitKind === "paragraphs" ? splitParagraphs(text) : splitLines(text)).map((section) => section.trim());
  return sections.filter((section) => section.length > 0);
}

function splitParagraphs(text: string): string[] {
  return text.split(/\n{2,}/g);
}

function splitLines(text: string): string[] {
  return text.split("\n");
}

function renderActivityLogEntry(entry: Exclude<ActivityLogEntry, { kind: "commentary" }>): string[] {
  if (entry.kind === "structuredFailure") {
    return [buildStructuredFailureMarkdown(entry)];
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
  return item.status === "declined" || isCommandExecutionFailed(item)
    ? buildStructuredFailureForCommandExecution(item)
    : buildActivityEventEntry("Command", item.command, "codeBlock");
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
  return item.status === "declined" || isCommandExecutionFailed(item)
    ? buildRenderedStructuredFailureMessage(buildStructuredFailureForCommandExecution(item))
    : buildLabeledCodeMessage("Command completed: ", item.command);
}

function truncateCommandFailureOutput(output: string | null): string | null {
  const normalized = output?.replace(/\r\n/g, "\n").trim() ?? "";
  if (!normalized) {
    return null;
  }

  return buildTruncatedPreview(normalized, COMMAND_FAILURE_OUTPUT_CHAR_LIMIT, "...\n", "");
}

function buildRenderedFileChangeCompletionMessage(
  item: Extract<ThreadItem, { type: "fileChange" }>
): TelegramRenderedMessage {
  return item.status === "completed"
    ? buildLabeledCodeMessage("Applied file changes: ", summarizeFileChanges(item.changes) ?? "(unknown files)")
    : buildRenderedStructuredFailureMessage(buildStructuredFailureForFileChange(item));
}

function buildRenderedStructuredFailureMessage(entry: StructuredFailureEntry): TelegramRenderedMessage {
  const builder = new TelegramEntityBuilder();
  builder.appendText(entry.title);

  if (entry.subject) {
    builder.appendText("\n");
    appendStructuredFailureBlock(builder, entry.subject);
  }

  if (entry.metadata.length > 0) {
    builder.appendText(entry.subject ? "\n\n" : "\n");
    entry.metadata.forEach((line, index) => {
      if (index > 0) {
        builder.appendText("\n");
      }
      builder.appendText(`${line.label}: `);
      if (line.code) {
        builder.appendFormatted(renderCodeText(line.value));
      } else {
        builder.appendText(line.value);
      }
    });
  }

  if (entry.detail) {
    builder.appendText(`\n\n${entry.detail.title}\n`);
    appendStructuredFailureBlock(builder, entry.detail);
  }

  return builder.build();
}

function buildStructuredFailureMarkdown(entry: StructuredFailureEntry): string {
  let markdown = `**${escapeMarkdownText(entry.title)}**`;

  if (entry.subject) {
    markdown += `\n${renderStructuredFailureBlockMarkdown(entry.subject)}`;
  }

  if (entry.metadata.length > 0) {
    markdown += `\n\n${entry.metadata
      .map((line) => `${escapeMarkdownText(line.label)}: ${line.code ? renderInlineCodeMarkdown(line.value) : escapeMarkdownText(line.value)}`)
      .join("  \n")}`;
  }

  if (entry.detail) {
    markdown += `\n\n${escapeMarkdownText(entry.detail.title)}\n${renderStructuredFailureBlockMarkdown(entry.detail)}`;
  }

  return markdown;
}

function appendStructuredFailureBlock(
  builder: TelegramEntityBuilder,
  block: StructuredFailureEntry["subject"] | NonNullable<StructuredFailureEntry["detail"]>
): void {
  if (!block) {
    return;
  }

  switch (block.style) {
    case "codeBlock":
      builder.appendFormatted(renderPreformattedText(block.value));
      return;
    case "quoteBlock":
      builder.appendFormatted(renderQuotedText(block.value));
      return;
    case "inlineCode":
      builder.appendFormatted(renderCodeText(block.value));
      return;
    case "text":
      builder.appendText(block.value);
      return;
  }
}

function renderStructuredFailureBlockMarkdown(
  block: NonNullable<StructuredFailureEntry["subject"]> | NonNullable<StructuredFailureEntry["detail"]>
): string {
  switch (block.style) {
    case "codeBlock":
      return buildFencedCodeBlock(block.value);
    case "quoteBlock":
      return buildMarkdownQuoteBlock(block.value);
    case "inlineCode":
      return renderInlineCodeMarkdown(block.value);
    case "text":
      return escapeMarkdownText(block.value);
  }
}

function buildStructuredFailureForCommandExecution(
  item: Extract<ThreadItem, { type: "commandExecution" }>
): StructuredFailureEntry {
  const errorOutput = truncateCommandFailureOutput(item.aggregatedOutput);
  return {
    kind: "structuredFailure",
    title: item.status === "declined" ? "Command declined" : "Command failed",
    subject: {
      value: item.command.trim() || "(unknown command)",
      style: "codeBlock"
    },
    metadata: [
      { label: "CWD", value: item.cwd?.trim() || "(unknown cwd)", code: true },
      ...(item.exitCode !== null ? [{ label: "Exit code", value: String(item.exitCode), code: true }] : []),
      ...(item.durationMs !== null
        ? [{ label: "Duration", value: formatElapsedDuration(item.durationMs, true), code: true }]
        : [])
    ],
    detail: errorOutput
      ? {
          title: "Error",
          value: errorOutput,
          style: "quoteBlock"
        }
      : null
  };
}

function buildStructuredFailureForFileChange(
  item: Extract<ThreadItem, { type: "fileChange" }>
): StructuredFailureEntry {
  return {
    kind: "structuredFailure",
    title: item.status === "declined" ? "File changes declined" : "File changes failed",
    subject: {
      value: buildFileChangePathPreview(item.changes),
      style: "codeBlock"
    },
    metadata: item.changes.length > 0 ? [{ label: "Files", value: String(item.changes.length), code: true }] : [],
    detail: null
  };
}

function buildStructuredFailureForMcpToolCall(
  item: Extract<ThreadItem, { type: "mcpToolCall" }>
): StructuredFailureEntry {
  return {
    kind: "structuredFailure",
    title: "Tool failed",
    subject: {
      value: `${item.server}.${item.tool}`,
      style: "inlineCode"
    },
    metadata: item.durationMs !== null
      ? [{ label: "Duration", value: formatElapsedDuration(item.durationMs, true), code: true }]
      : [],
    detail: item.error?.message?.trim()
      ? {
          title: "Error",
          value: item.error.message.trim(),
          style: "quoteBlock"
        }
      : null
  };
}

function buildStructuredFailureForDynamicToolCall(
  item: Extract<ThreadItem, { type: "dynamicToolCall" }>
): StructuredFailureEntry {
  return {
    kind: "structuredFailure",
    title: "Tool failed",
    subject: {
      value: item.tool,
      style: "inlineCode"
    },
    metadata: item.durationMs !== null
      ? [{ label: "Duration", value: formatElapsedDuration(item.durationMs, true), code: true }]
      : [],
    detail: null
  };
}

function buildStructuredFailureForCollabAgentToolCall(
  item: Extract<ThreadItem, { type: "collabAgentToolCall" }>
): StructuredFailureEntry {
  const agentStateSummary = summarizeCollabAgentStates(item.agentsStates);
  return {
    kind: "structuredFailure",
    title: "Agent task failed",
    subject: {
      value: item.tool,
      style: "inlineCode"
    },
    metadata: [
      ...(item.receiverThreadIds.length > 0 ? [{ label: "Agents", value: String(item.receiverThreadIds.length), code: true }] : []),
      ...(item.model?.trim() ? [{ label: "Model", value: item.model.trim(), code: true }] : []),
      ...(item.reasoningEffort ? [{ label: "Reasoning", value: item.reasoningEffort, code: true }] : [])
    ],
    detail: agentStateSummary
      ? {
          title: "Agents",
          value: agentStateSummary,
          style: "codeBlock"
        }
      : null
  };
}

function buildStructuredFailureForImageGeneration(
  item: Extract<ThreadItem, { type: "imageGeneration" }>
): StructuredFailureEntry {
  const result = item.result.trim();
  return {
    kind: "structuredFailure",
    title: "Image generation failed",
    subject: null,
    metadata: item.status.trim() ? [{ label: "Status", value: item.status.trim(), code: true }] : [],
    detail: result
      ? {
          title: "Result",
          value: truncateCommandFailureOutput(result) ?? result,
          style: "quoteBlock"
        }
      : null
  };
}

function buildFileChangePathPreview(changes: Array<{ path: string }>): string {
  const paths = changes.map((change) => change.path.trim()).filter((path) => path.length > 0);
  if (paths.length === 0) {
    return "(unknown files)";
  }

  const preview = paths.slice(0, FILE_CHANGE_PATH_PREVIEW_LIMIT);
  if (paths.length > preview.length) {
    preview.push(`... (+${paths.length - preview.length} more)`);
  }

  return preview.join("\n");
}

function summarizeCollabAgentStates(states: Extract<ThreadItem, { type: "collabAgentToolCall" }>["agentsStates"]): string | null {
  const lines = Object.entries(states)
    .map(([threadId, state]) => {
      if (!state) {
        return null;
      }
      const message = state.message?.trim();
      return `${threadId}: ${state.status}${message ? ` - ${message}` : ""}`;
    })
    .filter((value): value is string => Boolean(value));

  return lines.length > 0 ? lines.join("\n") : null;
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

function buildMarkdownQuoteBlock(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
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
