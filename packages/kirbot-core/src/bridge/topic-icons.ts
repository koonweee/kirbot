import type { LoggerLike } from "../logging";
import {
  TELEGRAM_FORUM_TOPIC_ICON_COLORS,
  type TelegramApi,
  type TelegramCreateForumTopicOptions,
  type TelegramForumTopicIconColor
} from "../telegram-messenger";

export interface TopicIconPicker {
  pickCreateForumTopicOptions(): Promise<TelegramCreateForumTopicOptions>;
}

export class RandomTopicIconPicker implements TopicIconPicker {
  #customEmojiIds: string[] | null | undefined;

  constructor(
    private readonly telegram: Pick<TelegramApi, "getForumTopicIconStickers">,
    private readonly logger: LoggerLike = console,
    private readonly random: () => number = Math.random
  ) {}

  async pickCreateForumTopicOptions(): Promise<TelegramCreateForumTopicOptions> {
    const customEmojiId = await this.#pickCustomEmojiId();
    if (customEmojiId) {
      return { icon_custom_emoji_id: customEmojiId };
    }

    return { icon_color: pickRandomTopicIconColor(this.random) };
  }

  async #pickCustomEmojiId(): Promise<string | null> {
    if (this.#customEmojiIds === undefined) {
      try {
        const stickers = await this.telegram.getForumTopicIconStickers();
        this.#customEmojiIds = stickers.flatMap((sticker) =>
          typeof sticker.custom_emoji_id === "string" && sticker.custom_emoji_id.length > 0
            ? [sticker.custom_emoji_id]
            : []
        );
      } catch (error) {
        this.#customEmojiIds = null;
        this.logger.warn("Failed to load Telegram topic icon stickers; falling back to built-in icon colors.", error);
      }
    }

    if (!this.#customEmojiIds || this.#customEmojiIds.length === 0) {
      return null;
    }

    return this.#customEmojiIds[pickRandomIndex(this.#customEmojiIds.length, this.random)] ?? null;
  }
}

export function pickRandomTopicIconColor(random: () => number = Math.random): TelegramForumTopicIconColor {
  return (
    TELEGRAM_FORUM_TOPIC_ICON_COLORS[pickRandomIndex(TELEGRAM_FORUM_TOPIC_ICON_COLORS.length, random)] ??
    TELEGRAM_FORUM_TOPIC_ICON_COLORS[0]
  );
}

function pickRandomIndex(length: number, random: () => number): number {
  if (length <= 1) {
    return 0;
  }

  const value = random();
  if (!Number.isFinite(value)) {
    return 0;
  }

  const normalized = Math.min(Math.max(value, 0), 0.9999999999999999);
  return Math.floor(normalized * length);
}
