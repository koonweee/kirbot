import { TelegramEntityBuilder } from "./entity-builder";
import type { FormattedText } from "./types";

export function renderPreformattedText(text: string, language?: string): FormattedText {
  const builder = new TelegramEntityBuilder();
  const range = builder.appendText(text);
  builder.annotate(range, language ? { type: "pre", language } : { type: "pre" });
  return builder.build();
}

export function renderQuotedText(
  text: string,
  options: { kind?: "blockquote" | "expandable_blockquote" } = {}
): FormattedText {
  const builder = new TelegramEntityBuilder();
  const range = builder.appendText(text);

  // Default to expandable quotes on the manual path because callers choosing this
  // API are making an explicit presentation decision outside of Markdown syntax.
  builder.annotate(range, {
    type: options.kind ?? "expandable_blockquote"
  });

  return builder.build();
}
