import type { MessageEntity } from "grammy/types";

import { clampUtf16Boundary } from "./utf16";
import { type FormattedText, normalizeFormattedText } from "./types";

export function truncateFormattedText(formatted: FormattedText, maxChars: number, suffix = ""): FormattedText {
  const normalized = normalizeFormattedText(formatted);
  if (normalized.text.length <= maxChars) {
    return normalized;
  }

  const contentEnd = Math.max(0, maxChars - suffix.length);
  const sliced = sliceFormattedText(normalized, 0, contentEnd);
  return normalizeFormattedText({
    text: `${sliced.text}${suffix}`,
    ...(sliced.entities ? { entities: sliced.entities } : {})
  });
}

function sliceFormattedText(formatted: FormattedText, start: number, end: number): FormattedText {
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
