import type { MessageEntity } from "grammy/types";

import {
  type EntityAnnotation,
  type FormattedText,
  type TextRange,
  normalizeFormattedText,
  shiftEntity
} from "./types";

export class TelegramEntityBuilder {
  #parts: string[] = [];
  #entities: MessageEntity[] = [];
  #length = 0;

  get length(): number {
    return this.#length;
  }

  appendText(text: string): TextRange {
    const offset = this.#length;
    this.#parts.push(text);
    this.#length += text.length;
    return {
      offset,
      length: text.length
    };
  }

  appendFormatted(formatted: FormattedText): TextRange {
    const range = this.appendText(formatted.text);
    for (const entity of formatted.entities ?? []) {
      this.#entities.push(shiftEntity(entity, range.offset));
    }
    return range;
  }

  annotate(range: TextRange, annotation: EntityAnnotation): MessageEntity | null {
    if (range.length <= 0) {
      return null;
    }

    if (range.offset < 0 || range.offset + range.length > this.#length) {
      throw new RangeError("Entity range is outside the current text buffer");
    }

    const entity = {
      ...annotation,
      offset: range.offset,
      length: range.length
    } as MessageEntity;
    this.#entities.push(entity);
    return entity;
  }

  build(): FormattedText {
    return normalizeFormattedText({
      text: this.#parts.join(""),
      entities: this.#entities
    });
  }
}

export function buildFormattedText(
  text: string,
  annotations: Array<
    {
      offset: number;
      length: number;
    } & EntityAnnotation
  >
): FormattedText {
  const builder = new TelegramEntityBuilder();
  builder.appendText(text);
  for (const annotation of annotations) {
    builder.annotate(
      {
        offset: annotation.offset,
        length: annotation.length
      },
      annotation
    );
  }
  return builder.build();
}
