import { parseMarkdownToMdast } from "./ast";
import { renderMdastToFormattedText } from "./mdast";
import type { FormattedText } from "./types";

export function renderMarkdownToFormattedText(markdown: string): FormattedText {
  return renderMdastToFormattedText(parseMarkdownToMdast(markdown));
}
