import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import type { Root } from "mdast";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";

export const MARKDOWN_AST_VERSION = "mdast-v1";

export type MarkdownAst = Root;

export function parseMarkdownToMdast(markdown: string): MarkdownAst {
  return fromMarkdown(markdown, {
    extensions: [gfmStrikethrough()],
    mdastExtensions: [gfmStrikethroughFromMarkdown()]
  });
}

export function serializeMarkdownAst(ast: MarkdownAst): string {
  return JSON.stringify(ast);
}

export function parseSerializedMarkdownAst(value: string): MarkdownAst {
  const parsed = JSON.parse(value) as Partial<MarkdownAst>;
  if (parsed.type !== "root" || !Array.isArray(parsed.children)) {
    throw new Error("Stored markdown AST is not a valid mdast root node");
  }

  return parsed as MarkdownAst;
}
