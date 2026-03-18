# Harness Guidance

This directory owns the Telegram harness:

- synthetic inbound Telegram user/callback events
- recording outbound Telegram API events
- transcript synthesis for current visible chat state
- harness-specific CLI ergonomics

## Boundaries

- Keep real app startup, DB setup, Codex setup, and bridge wiring in
  [`packages/kirbot-core/src/runtime.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/runtime.ts),
  not duplicated in the harness.
- Treat
  [`packages/telegram-harness/src/recording-telegram.ts`](/home/jtkw/kirbot/packages/telegram-harness/src/recording-telegram.ts)
  as the owner of raw event capture and transcript reconstruction.
- Keep the harness at the `TelegramApi` seam. Do not emulate raw Telegram HTTP,
  `grammy` internals, or formatting logic that belongs in
  [`packages/telegram-format/src`](/home/jtkw/kirbot/.worktrees/telegram-harness/packages/telegram-format/src).

## Maintenance Rules

- When a kirbot change adds or changes Telegram-visible behavior, update the
  harness transport/transcript model in the same change.
- When a new inline-button or other harness-driveable interaction is added,
  expose it through the harness library before or alongside CLI support.
- Keep transcript assertions focused on exact durable user-visible text. Use raw
  event assertions for drafts, edits, deletes, or callback acknowledgements.
- Update [docs/telegram-harness.md](/home/jtkw/kirbot/docs/telegram-harness.md)
  whenever harness usage, extension workflow, or boundaries change.
