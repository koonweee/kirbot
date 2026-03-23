import type { MessageEntity } from "grammy/types";

import { shiftEntity } from "@kirbot/telegram-format";

export type MentionableMessage = {
  text: string;
  entities?: MessageEntity[];
};

export function prefixTelegramUsernameMention(
  message: MentionableMessage,
  telegramUsername?: string | null
): MentionableMessage {
  const username = telegramUsername?.trim();
  if (!username) {
    return message;
  }

  const prefix = `@${username} `;
  return {
    text: `${prefix}${message.text}`,
    ...(message.entities
      ? {
          entities: message.entities.map((entity) => shiftEntity(entity, prefix.length))
        }
      : {})
  };
}
