import { TelegramEntityBuilder } from "./entity-builder";
import type { FormattedText } from "./types";

export function renderPreformattedText(text: string, language?: string): FormattedText {
  const builder = new TelegramEntityBuilder();
  const range = builder.appendText(text);
  builder.annotate(range, language ? { type: "pre", language } : { type: "pre" });
  return builder.build();
}
