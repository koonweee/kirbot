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
import type { MessageEntity } from "grammy/types";

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

export function renderMdastToFormattedText(tree: Root): FormattedText {
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
    case "inlineCode":
      builder.appendFormatted(codeFormattedText({ text: node.value }));
      return;
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

  const parts: string[] = [];
  const entities = (formatted.entities ?? []).slice();
  const spoilerEntities: MessageEntity[] = [];
  let cursor = 0;
  let removed = 0;

  for (let index = 0; index + 1 < delimiterPositions.length; index += 2) {
    const start = delimiterPositions[index]!;
    const end = delimiterPositions[index + 1]!;
    parts.push(formatted.text.slice(cursor, start));
    parts.push(formatted.text.slice(start + 2, end));

    const spoilerOffset = start - removed;
    const spoilerLength = end - start - 2;
    if (spoilerLength > 0) {
      spoilerEntities.push({
        type: "spoiler",
        offset: spoilerOffset,
        length: spoilerLength
      });
    }

    removed += 4;
    cursor = end + 2;
  }

  parts.push(formatted.text.slice(cursor));
  const normalizedText = parts.join("");
  const normalizedEntities = entities
    .map((entity) => shiftEntityPastSpoilerDelimiters(entity, delimiterPositions))
    .filter((entity): entity is MessageEntity => entity !== null)
    .concat(spoilerEntities);

  return normalizedEntities.length > 0
    ? {
        text: normalizedText,
        entities: normalizedEntities
      }
    : {
        text: normalizedText
      };
}

function findSpoilerDelimiterPositions(formatted: FormattedText): number[] {
  const protectedRanges = (formatted.entities ?? []).filter((entity) => entity.type === "code" || entity.type === "pre");
  const positions: number[] = [];

  for (let index = 0; index < formatted.text.length - 1; index += 1) {
    if (formatted.text[index] !== "|" || formatted.text[index + 1] !== "|") {
      continue;
    }

    if (protectedRanges.some((entity) => index >= entity.offset && index < entity.offset + entity.length)) {
      continue;
    }

    positions.push(index);
    index += 1;
  }

  return positions;
}

function shiftEntityPastSpoilerDelimiters(
  entity: MessageEntity,
  delimiterPositions: number[]
): MessageEntity | null {
  let removedBeforeStart = 0;
  let removedInside = 0;

  for (const delimiter of delimiterPositions) {
    if (delimiter < entity.offset) {
      removedBeforeStart += 2;
      continue;
    }

    if (delimiter >= entity.offset && delimiter < entity.offset + entity.length) {
      removedInside += 2;
    }
  }

  const nextLength = entity.length - removedInside;
  if (nextLength <= 0) {
    return null;
  }

  return {
    ...entity,
    offset: entity.offset - removedBeforeStart,
    length: nextLength
  };
}
