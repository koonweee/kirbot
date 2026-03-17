# Repository Guidance

This repository may contain more specific `AGENTS.md` files in subdirectories.
When working in a scoped area, follow the nearest relevant file.

## Start With The Docs

Before making cross-cutting changes, use the repo docs to recover the intended
mental model:

- [README.md](/home/jtkw/kirbot/README.md)
- [GLOSSARY.md](/home/jtkw/kirbot/GLOSSARY.md)
- [docs/architecture.md](/home/jtkw/kirbot/docs/architecture.md)
- [docs/user-flows.md](/home/jtkw/kirbot/docs/user-flows.md)
- [docs/engineering-guide.md](/home/jtkw/kirbot/docs/engineering-guide.md)

These docs are for onboarding and stable ownership boundaries. Do not turn them
into a line-by-line restatement of the implementation.

## Architecture Boundaries

- Keep [src/bridge.ts](/home/jtkw/kirbot/src/bridge.ts) focused on high-level
  Telegram/Codex routing and session orchestration. Move reusable turn,
  request, or rendering logic into `src/bridge/*` helpers instead of growing
  the entrypoint further.
- Treat [src/bridge/presentation.ts](/home/jtkw/kirbot/src/bridge/presentation.ts)
  as the owner for Telegram-facing status, footer, and queue-preview rendering
  outside `src/telegram-format`.
- Treat [src/turn-runtime.ts](/home/jtkw/kirbot/src/turn-runtime.ts) as the
  owner of in-memory turn and queue state, not persistence or Telegram
  rendering.
- Treat [src/db.ts](/home/jtkw/kirbot/src/db.ts) as the owner of persisted
  bridge state and restart-safe bookkeeping.
- Keep root-chat session start behavior and in-topic behavior aligned. When a
  flow creates a topic from root, verify both the Telegram UX in root/topic and
  the first Codex turn behavior.
- Treat [src/runtime.ts](/home/jtkw/kirbot/.worktrees/telegram-harness/src/runtime.ts)
- Treat [src/runtime.ts](/home/jtkw/kirbot/src/runtime.ts)
  as the owner of reusable kirbot bootstrap outside the `grammy` entrypoint.
- Treat
  [src/harness/recording-telegram.ts](/home/jtkw/kirbot/src/harness/recording-telegram.ts)
  as the owner of harness transcript synthesis and outbound Telegram event
  capture.

## Telegram Formatting

For all Telegram text/entity formatting work, see:

- [src/telegram-format/AGENTS.md](/home/jtkw/kirbot/src/telegram-format/AGENTS.md)
- [src/harness/AGENTS.md](/home/jtkw/kirbot/src/harness/AGENTS.md)
  for Telegram harness work

That directory owns:

- Markdown-to-Telegram-entity rendering
- manual Telegram formatting producers
- UTF-16 entity offset handling
- entity-aware chunking and prefix shifting

Do not reimplement Telegram formatting logic elsewhere in the repo when it
belongs in `src/telegram-format`.

## Change Strategy

- Start from the user-visible flow, then work inward to the owning module.
- Prefer small helper extraction over broad rewrites when the behavior boundary
  is already clear.
- Prefer fail-open Telegram integration changes. If deep links, copies, draft
  updates, or other Telegram niceties fail, preserve the underlying Codex turn
  flow unless the feature explicitly requires hard failure.
- Preserve the topic-centric model: one Telegram topic maps to one Codex thread.

## Detached Local Runs

- Use `npm run dev:tmux` for a detached watched development session, or
  `npm run start:tmux` for a detached production session from `dist/`.
- Use `npm run dev:tmux:attach` or `npm run start:tmux:attach` to attach to the
  existing tmux session and read live logs. When already inside tmux these
  commands switch clients instead of nesting sessions.
- Use `npm run dev:tmux:restart` or `npm run start:tmux:restart` to restart the
  detached pane in place. The restart commands create the session first if it
  does not exist yet.
- Build before detached production runs: use `npm run build` before
  `npm run start:tmux` or `npm run start:tmux:restart`.
- Prefer these tmux scripts over `nohup`, shell backgrounding, or leaving
  orphaned node processes behind.

## Tests

- Add or update Vitest coverage for behavior changes in
  [tests/bridge.test.ts](/home/jtkw/kirbot/tests/bridge.test.ts) and the
  narrower unit around the touched subsystem, such as
  [tests/harness.test.ts](/home/jtkw/kirbot/tests/harness.test.ts),
  [tests/turn-lifecycle.test.ts](/home/jtkw/kirbot/tests/turn-lifecycle.test.ts),
  [tests/telegram-messenger.test.ts](/home/jtkw/kirbot/tests/telegram-messenger.test.ts),
  [tests/telegram-format.test.ts](/home/jtkw/kirbot/tests/telegram-format.test.ts),
  or [tests/codex.test.ts](/home/jtkw/kirbot/tests/codex.test.ts).
- Use the existing fake Telegram/Codex adapters in tests and extend them rather
  than introducing one-off mocks when possible.
- When changing completion footers, queue previews, commands, approvals, or
  mode routing, assert the exact user-visible Telegram text so regressions stay
  obvious.

## Documentation Maintenance

- Update docs when you change user flows, onboarding guidance, ownership
  boundaries, setup steps, or agent instructions.
- Keep docs DRY: explain responsibilities, invariants, and navigation; link to
  code and tests for details.
- Prefer updating the narrowest owning doc instead of copying the same guidance
  into multiple files.
- If a change only renames internals without changing behavior or ownership, do
  not churn docs just to mirror the refactor.
- When you add a new subsystem README or `AGENTS.md`, link to it from the most
  relevant parent doc if a new engineer would otherwise miss it.
