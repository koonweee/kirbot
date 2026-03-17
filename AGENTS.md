# Repository Guidance

This repository may contain more specific `AGENTS.md` files in subdirectories.
When working in a scoped area, follow the nearest relevant file.

## Telegram Formatting

For all Telegram text/entity formatting work, see:

- [src/telegram-format/AGENTS.md](/tmp/kirbot-message-formatting-overhaul/src/telegram-format/AGENTS.md)

That directory owns:

- Markdown-to-Telegram-entity rendering
- manual Telegram formatting producers
- UTF-16 entity offset handling
- entity-aware chunking and prefix shifting

Do not reimplement Telegram formatting logic elsewhere in the repo when it
belongs in `src/telegram-format`.
