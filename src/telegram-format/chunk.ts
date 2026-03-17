import type { MessageEntity } from "grammy/types";

import { clampUtf16Boundary } from "./utf16";
import {
  type FormattedText,
  normalizeFormattedText,
  shiftEntity
} from "./types";

export function chunkFormattedText(formatted: FormattedText, maxChars: number): FormattedText[] {
  if (formatted.text.length <= maxChars) {
    return [normalizeFormattedText(formatted)];
  }

  const chunks: FormattedText[] = [];
  let start = 0;

  while (start < formatted.text.length) {
    if (formatted.text.length - start <= maxChars) {
      chunks.push(sliceFormattedText(formatted, start, formatted.text.length));
      break;
    }

    const windowText = formatted.text.slice(start, start + maxChars + 1);
    let end = start + findChunkBoundary(windowText, maxChars);
    end = clampUtf16Boundary(formatted.text, end);

    if (end <= start) {
      end = clampUtf16Boundary(formatted.text, start + maxChars);
    }

    let contentEnd = end;
    while (contentEnd > start && /\s/u.test(formatted.text[contentEnd - 1] ?? "")) {
      contentEnd -= 1;
    }

    contentEnd = clampUtf16Boundary(formatted.text, contentEnd);
    if (contentEnd <= start) {
      contentEnd = end;
    }

    chunks.push(sliceFormattedText(formatted, start, contentEnd));

    start = end;
    while (start < formatted.text.length && /\s/u.test(formatted.text[start] ?? "")) {
      start += 1;
    }
  }

  return chunks.length > 0 ? chunks : [normalizeFormattedText(formatted)];
}

export function prependText(prefix: string, formatted: FormattedText): FormattedText {
  if (!prefix) {
    return normalizeFormattedText(formatted);
  }

  return normalizeFormattedText(
    formatted.entities
      ? {
          text: `${prefix}${formatted.text}`,
          entities: formatted.entities.map((entity) => shiftEntity(entity, prefix.length))
        }
      : {
          text: `${prefix}${formatted.text}`
        }
  );
}

export function sliceFormattedText(formatted: FormattedText, start: number, end: number): FormattedText {
  const boundedStart = clampUtf16Boundary(formatted.text, start);
  const boundedEnd = clampUtf16Boundary(formatted.text, end);
  const text = formatted.text.slice(boundedStart, boundedEnd);
  const entities = formatted.entities
    ?.map((entity) => clipEntity(entity, boundedStart, boundedEnd))
    .filter((entity): entity is MessageEntity => entity !== null);

  return normalizeFormattedText(
    entities
      ? {
          text,
          entities
        }
      : {
          text
        }
  );
}

function clipEntity(entity: MessageEntity, start: number, end: number): MessageEntity | null {
  const entityStart = entity.offset;
  const entityEnd = entity.offset + entity.length;
  const clippedStart = Math.max(start, entityStart);
  const clippedEnd = Math.min(end, entityEnd);

  if (clippedStart >= clippedEnd) {
    return null;
  }

  return {
    ...entity,
    offset: clippedStart - start,
    length: clippedEnd - clippedStart
  };
}

function findChunkBoundary(text: string, maxChars: number): number {
  const minPreferredIndex = Math.floor(maxChars * 0.6);
  const window = text.slice(0, maxChars + 1);
  const candidates = [window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" ")];

  for (const index of candidates) {
    if (index >= minPreferredIndex) {
      return index;
    }
  }

  return maxChars;
}
