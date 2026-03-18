import type { MessageEntity } from "grammy/types";

export type FormattedText = {
  text: string;
  entities?: MessageEntity[];
};

export type TextRange = {
  offset: number;
  length: number;
};

export type EntityAnnotation = {
  type: MessageEntity["type"];
} & Record<string, unknown>;

export function normalizeFormattedText(formatted: FormattedText): FormattedText {
  const entities = formatted.entities
    ?.filter((entity) => entity.length > 0)
    .slice()
    .sort(compareMessageEntities);

  return entities && entities.length > 0 ? { text: formatted.text, entities } : { text: formatted.text };
}

export function shiftEntity(entity: MessageEntity, offsetDelta: number): MessageEntity {
  return {
    ...entity,
    offset: entity.offset + offsetDelta
  };
}

export function compareMessageEntities(left: MessageEntity, right: MessageEntity): number {
  if (left.offset !== right.offset) {
    return left.offset - right.offset;
  }

  if (left.length !== right.length) {
    return right.length - left.length;
  }

  return left.type.localeCompare(right.type);
}
