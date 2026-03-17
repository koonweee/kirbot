import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import type {
  BlockContent,
  Code,
  DefinitionContent,
  Heading,
  HTML,
  Image,
  InlineCode,
  Link,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Strong,
  Emphasis,
  Break,
  Delete,
  Text,
  ThematicBreak,
  Blockquote,
  LinkReference,
  ImageReference,
  FootnoteReference
} from "mdast";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";

import { TelegramEntityBuilder } from "./entity-builder";
import {
  boldFormattedText,
  codeFormattedText,
  italicFormattedText,
  linkFormattedText,
  preformattedFormattedText,
  quoteFormattedText,
  strikethroughFormattedText
} from "./formatters";
import type { FormattedText } from "./types";

export function renderMarkdownToFormattedText(markdown: string): FormattedText {
  if (markdown.length === 0) {
    return { text: "" };
  }

  const tree = fromMarkdown(markdown, {
    extensions: [gfmStrikethrough()],
    mdastExtensions: [gfmStrikethroughFromMarkdown()]
  });
  const builder = new TelegramEntityBuilder();
  renderBlockSequence(builder, tree.children, "\n\n");
  return applySpoilerEntities(builder.build());
}

function renderBlockSequence(
  builder: TelegramEntityBuilder,
  nodes: Root["children"] | Array<BlockContent | DefinitionContent>,
  separator: string
): void {
  let renderedAny = false;

  for (const node of nodes) {
    if (node.type === "definition") {
      continue;
    }

    if (renderedAny) {
      builder.appendText(separator);
    }

    renderBlock(builder, node);
    renderedAny = true;
  }
}

function renderBlock(builder: TelegramEntityBuilder, node: RootContent | BlockContent): void {
  switch (node.type) {
    case "paragraph":
      renderInlineSequence(builder, node.children);
      return;
    case "heading":
      renderHeading(builder, node);
      return;
    case "blockquote":
      renderBlockquote(builder, node);
      return;
    case "code":
      renderCodeBlock(builder, node);
      return;
    case "list":
      renderList(builder, node);
      return;
    case "thematicBreak":
      builder.appendText("---");
      return;
    case "html":
      builder.appendText(node.value);
      return;
    default:
      renderFallback(builder, node);
  }
}

function renderHeading(builder: TelegramEntityBuilder, node: Heading): void {
  builder.appendFormatted(boldFormattedText(renderInlineFragment(node.children)));
}

function renderBlockquote(builder: TelegramEntityBuilder, node: Blockquote): void {
  const fragmentBuilder = new TelegramEntityBuilder();
  renderBlockSequence(fragmentBuilder, node.children, "\n\n");
  builder.appendFormatted(quoteFormattedText(fragmentBuilder.build()));
}

function renderCodeBlock(builder: TelegramEntityBuilder, node: Code): void {
  builder.appendFormatted(preformattedFormattedText({ text: node.value }, node.lang ?? undefined));
}

function renderList(builder: TelegramEntityBuilder, node: List): void {
  node.children.forEach((item, index) => {
    if (index > 0) {
      builder.appendText("\n");
    }

    const prefix = node.ordered ? `${(node.start ?? 1) + index}. ` : "- ";
    builder.appendText(prefix);
    builder.appendFormatted(renderListItemFragment(item));
  });
}

function renderListItemFragment(node: ListItem): FormattedText {
  const builder = new TelegramEntityBuilder();
  renderBlockSequence(builder, node.children, "\n");
  return builder.build();
}

function renderInlineSequence(builder: TelegramEntityBuilder, nodes: PhrasingContent[]): void {
  for (const node of nodes) {
    renderInline(builder, node);
  }
}

function renderInline(builder: TelegramEntityBuilder, node: PhrasingContent): void {
  switch (node.type) {
    case "text":
      builder.appendText(node.value);
      return;
    case "strong":
      renderAnnotatedFragment(builder, node, boldFormattedText);
      return;
    case "emphasis":
      renderAnnotatedFragment(builder, node, italicFormattedText);
      return;
    case "delete":
      renderAnnotatedFragment(builder, node, strikethroughFormattedText);
      return;
    case "inlineCode": {
      builder.appendFormatted(codeFormattedText({ text: node.value }));
      return;
    }
    case "link":
      renderLink(builder, node);
      return;
    case "break":
      builder.appendText("\n");
      return;
    case "html":
      builder.appendText(node.value);
      return;
    case "linkReference":
      renderInlineSequence(builder, node.children);
      return;
    case "image":
      builder.appendText(node.alt ?? node.url);
      return;
    case "imageReference":
      builder.appendText(node.alt ?? node.label ?? "");
      return;
    case "footnoteReference":
      builder.appendText(`[^${node.identifier}]`);
      return;
    default:
      renderFallback(builder, node);
  }
}

function renderAnnotatedFragment(
  builder: TelegramEntityBuilder,
  node: Strong | Emphasis | Delete,
  apply: (formatted: FormattedText) => FormattedText
): void {
  builder.appendFormatted(apply(renderInlineFragment(node.children)));
}

function renderLink(builder: TelegramEntityBuilder, node: Link): void {
  builder.appendFormatted(linkFormattedText(renderInlineFragment(node.children), node.url));
}

function renderInlineFragment(nodes: PhrasingContent[]): FormattedText {
  const builder = new TelegramEntityBuilder();
  renderInlineSequence(builder, nodes);
  return builder.build();
}

function renderFallback(
  builder: TelegramEntityBuilder,
  node:
    | RootContent
    | BlockContent
    | PhrasingContent
    | DefinitionContent
    | HTML
    | Image
    | InlineCode
    | Text
    | ThematicBreak
    | Break
    | LinkReference
    | ImageReference
    | FootnoteReference
): void {
  if ("children" in node && Array.isArray(node.children)) {
    for (const child of node.children) {
      if (isPhrasingContent(child)) {
        renderInline(builder, child);
      } else if (child.type !== "definition") {
        renderBlock(builder, child);
      }
    }
    return;
  }

  if ("value" in node && typeof node.value === "string") {
    builder.appendText(node.value);
  }
}

function isPhrasingContent(node: RootContent | BlockContent | PhrasingContent): node is PhrasingContent {
  return (
    node.type === "text" ||
    node.type === "strong" ||
    node.type === "emphasis" ||
    node.type === "delete" ||
    node.type === "inlineCode" ||
    node.type === "link" ||
    node.type === "break" ||
    node.type === "html" ||
    node.type === "linkReference" ||
    node.type === "image" ||
    node.type === "imageReference" ||
    node.type === "footnoteReference"
  );
}

function applySpoilerEntities(formatted: FormattedText): FormattedText {
  const delimiterPositions = findSpoilerDelimiterPositions(formatted);
  if (delimiterPositions.length < 2) {
    return formatted;
  }

  const pairedDelimiters = delimiterPositions.slice(0, delimiterPositions.length - (delimiterPositions.length % 2));
  const removed = new Uint8Array(formatted.text.length);
  const spoilerRanges: Array<{ start: number; end: number }> = [];

  for (let index = 0; index < pairedDelimiters.length; index += 2) {
    const start = pairedDelimiters[index]!;
    const end = pairedDelimiters[index + 1]!;
    removed[start] = 1;
    removed[start + 1] = 1;
    removed[end] = 1;
    removed[end + 1] = 1;
    spoilerRanges.push({ start: start + 2, end });
  }

  const removedPrefixCounts = new Uint32Array(formatted.text.length + 1);
  for (let index = 0; index < formatted.text.length; index += 1) {
    removedPrefixCounts[index + 1] = removedPrefixCounts[index]! + removed[index]!;
  }

  const builder = new TelegramEntityBuilder();
  builder.appendText(
    formatted.text
      .split("")
      .filter((_, index) => removed[index] === 0)
      .join("")
  );

  for (const entity of formatted.entities ?? []) {
    const offset = entity.offset - removedPrefixCounts[entity.offset]!;
    const length =
      entity.length -
      (removedPrefixCounts[entity.offset + entity.length]! - removedPrefixCounts[entity.offset]!);

    if (length > 0) {
      builder.annotate({ offset, length }, { ...entity, offset, length });
    }
  }

  for (const range of spoilerRanges) {
    const offset = range.start - removedPrefixCounts[range.start]!;
    const end = range.end - removedPrefixCounts[range.end]!;
    if (end > offset) {
      builder.annotate({ offset, length: end - offset }, { type: "spoiler" });
    }
  }

  return builder.build();
}

function findSpoilerDelimiterPositions(formatted: FormattedText): number[] {
  const protectedRanges = (formatted.entities ?? []).filter((entity) => entity.type === "code" || entity.type === "pre");
  const positions: number[] = [];

  for (let index = 0; index < formatted.text.length - 1; index += 1) {
    if (formatted.text[index] !== "|" || formatted.text[index + 1] !== "|") {
      continue;
    }

    if (isWithinProtectedRange(index, protectedRanges) || isWithinProtectedRange(index + 1, protectedRanges)) {
      continue;
    }

    positions.push(index);
    index += 1;
  }

  return positions;
}

function isWithinProtectedRange(index: number, ranges: Array<{ offset: number; length: number }>): boolean {
  return ranges.some((range) => index >= range.offset && index < range.offset + range.length);
}
