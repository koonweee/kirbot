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

## Working Patterns

- Keep `src/bridge.ts` focused on high-level Telegram/Codex routing and session
  orchestration. Move reusable turn, request, or rendering logic into
  `src/bridge/*` helpers instead of growing `src/bridge.ts` further.
- Treat `src/bridge/presentation.ts` as the owner for Telegram-facing status,
  footer, and queue-preview rendering outside `src/telegram-format`.
- Keep root-chat session start behavior and in-topic behavior aligned. When a
  flow creates a topic from root, verify both the Telegram UX in root/topic and
  the first Codex turn behavior.
- Prefer fail-open Telegram integration changes. If deep links, copies, draft
  updates, or other Telegram niceties fail, preserve the underlying Codex turn
  flow unless the feature explicitly requires hard failure.

## Tests

- Add or update Vitest coverage for behavior changes in `tests/bridge.test.ts`
  and the narrower unit around the touched subsystem, such as
  `tests/turn-lifecycle.test.ts`, `tests/telegram-messenger.test.ts`, or
  `tests/codex.test.ts`.
- Use the existing fake Telegram/Codex adapters in tests and extend them rather
  than introducing one-off mocks when possible.
- When changing completion footers, queue previews, or mode routing, assert the
  exact user-visible Telegram text so regressions stay obvious.
