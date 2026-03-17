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
  return builder.build();
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
