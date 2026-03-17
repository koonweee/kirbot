import { TelegramEntityBuilder } from "./entity-builder";
import type { FormattedText } from "./types";

export type QuoteKind = "blockquote" | "expandable_blockquote";
const UNSUPPORTED_LINK_PROTOCOLS = new Set(["data:", "file:", "javascript:"]);
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;
const RELATIVE_PATH_PREFIX = /^(?:\.{1,2}\/|~\/)/;
const REPO_RELATIVE_FILE_PATH = /^(?:[^/\s]+\/)+[^/\s]+\.[A-Za-z0-9]+$/;

export function annotateFormattedText(
  formatted: FormattedText,
  annotation:
    | { type: "bold" }
    | { type: "italic" }
    | { type: "spoiler" }
    | { type: "strikethrough" }
    | { type: "code" }
    | { type: "text_link"; url: string }
    | { type: "pre"; language?: string }
    | { type: QuoteKind }
): FormattedText {
  const builder = new TelegramEntityBuilder();
  const range = builder.appendFormatted(formatted);
  builder.annotate(range, annotation);
  return builder.build();
}

export function boldFormattedText(formatted: FormattedText): FormattedText {
  return annotateFormattedText(formatted, { type: "bold" });
}

export function italicFormattedText(formatted: FormattedText): FormattedText {
  return annotateFormattedText(formatted, { type: "italic" });
}

export function strikethroughFormattedText(formatted: FormattedText): FormattedText {
  return annotateFormattedText(formatted, { type: "strikethrough" });
}

export function spoilerFormattedText(formatted: FormattedText): FormattedText {
  return annotateFormattedText(formatted, { type: "spoiler" });
}

export function codeFormattedText(formatted: FormattedText): FormattedText {
  return annotateFormattedText(formatted, { type: "code" });
}

export function linkFormattedText(formatted: FormattedText, url: string): FormattedText {
  const targetKind = classifyLinkTarget(url);
  if (targetKind === "path") {
    return codeFormattedText(formatted);
  }

  if (targetKind === "invalid") {
    return formatted;
  }

  return annotateFormattedText(formatted, { type: "text_link", url });
}

export function preformattedFormattedText(formatted: FormattedText, language?: string): FormattedText {
  return annotateFormattedText(formatted, language ? { type: "pre", language } : { type: "pre" });
}

export function quoteFormattedText(formatted: FormattedText, options: { kind?: QuoteKind } = {}): FormattedText {
  // Default to expandable quotes for shared quote rendering so Markdown and
  // manual producers stay aligned unless a caller explicitly asks otherwise.
  return annotateFormattedText(formatted, {
    type: options.kind ?? "expandable_blockquote"
  });
}

export function renderBoldText(text: string): FormattedText {
  return boldFormattedText({ text });
}

export function renderItalicText(text: string): FormattedText {
  return italicFormattedText({ text });
}

export function renderStrikethroughText(text: string): FormattedText {
  return strikethroughFormattedText({ text });
}

export function renderSpoilerText(text: string): FormattedText {
  return spoilerFormattedText({ text });
}

export function renderCodeText(text: string): FormattedText {
  return codeFormattedText({ text });
}

export function renderLinkedText(text: string, url: string): FormattedText {
  return linkFormattedText({ text }, url);
}

export function renderPreformattedText(text: string, language?: string): FormattedText {
  return preformattedFormattedText({ text }, language);
}

export function renderQuotedText(text: string, options: { kind?: QuoteKind } = {}): FormattedText {
  return quoteFormattedText({ text }, options);
}

function isTelegramLinkUrl(url: string): boolean {
  if (!/^[A-Za-z][A-Za-z\d+.-]*:/.test(url)) {
    return false;
  }

  try {
    const parsed = new URL(url);
    return !UNSUPPORTED_LINK_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

function classifyLinkTarget(url: string): "telegram-url" | "path" | "invalid" {
  if (isTelegramLinkUrl(url)) {
    return "telegram-url";
  }

  if (isPathLikeLinkTarget(url)) {
    return "path";
  }

  return "invalid";
}

function isPathLikeLinkTarget(url: string): boolean {
  if (url.startsWith("/")) {
    return true;
  }

  if (WINDOWS_ABSOLUTE_PATH.test(url) || RELATIVE_PATH_PREFIX.test(url)) {
    return true;
  }

  if (url.startsWith("file:")) {
    return true;
  }

  return REPO_RELATIVE_FILE_PATH.test(url);
}
