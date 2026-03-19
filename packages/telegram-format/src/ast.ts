import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import type { Root } from "mdast";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";

export type MarkdownAst = Root;

export function parseMarkdownToMdast(markdown: string): MarkdownAst {
  return fromMarkdown(markdown, {
    extensions: [gfmStrikethrough()],
    mdastExtensions: [gfmStrikethroughFromMarkdown()]
  });
}
