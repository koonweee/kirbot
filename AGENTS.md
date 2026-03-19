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

- Keep [packages/kirbot-core/src/bridge.ts](/home/jtkw/kirbot/packages/kirbot-core/src/bridge.ts) focused on high-level
  Telegram/Codex routing and session orchestration. Move reusable turn,
  request, or rendering logic into `packages/kirbot-core/src/bridge/*`
  helpers instead of growing the entrypoint further.
- Treat [packages/kirbot-core/src/bridge/presentation.ts](/home/jtkw/kirbot/packages/kirbot-core/src/bridge/presentation.ts)
  as the owner for Telegram-facing status, footer, and queue-preview rendering
  outside `packages/telegram-format/src`.
- Treat [packages/kirbot-core/src/turn-runtime.ts](/home/jtkw/kirbot/packages/kirbot-core/src/turn-runtime.ts) as the
  owner of in-memory turn and queue state, not persistence or Telegram
  rendering.
- Treat [packages/kirbot-core/src/db.ts](/home/jtkw/kirbot/packages/kirbot-core/src/db.ts) as the owner of persisted
  bridge state and restart-safe bookkeeping.
- Keep root-chat session start behavior and in-topic behavior aligned. When a
  flow creates a topic from root, verify both the Telegram UX in root/topic and
  the first Codex turn behavior.
- Treat [packages/kirbot-core/src/runtime.ts](/home/jtkw/kirbot/packages/kirbot-core/src/runtime.ts)
  as the owner of reusable kirbot bootstrap outside the `grammy` entrypoint.
- Treat
  [packages/telegram-harness/src/recording-telegram.ts](/home/jtkw/kirbot/packages/telegram-harness/src/recording-telegram.ts)
  as the owner of harness transcript synthesis and outbound Telegram event
  capture.

## Telegram Formatting

For all Telegram text/entity formatting work, see:

- [packages/telegram-format/AGENTS.md](/home/jtkw/kirbot/packages/telegram-format/AGENTS.md)
- [packages/telegram-harness/AGENTS.md](/home/jtkw/kirbot/packages/telegram-harness/AGENTS.md)
  for Telegram harness work

That directory owns:

- Markdown-to-Telegram-entity rendering
- manual Telegram formatting producers
- UTF-16 entity offset handling
- entity-aware truncation and clipping

Do not reimplement Telegram formatting logic elsewhere in the repo when it
belongs in `packages/telegram-format/src`.

## Change Strategy

- Start from the user-visible flow, then work inward to the owning module.
- Prefer small helper extraction over broad rewrites when the behavior boundary
  is already clear.
- When investigating or fixing Telegram-visible races, ordering bugs, or other
  integration behavior, prefer reproducing the issue at the harness/runtime
  level before or alongside narrower unit coverage.
- Prefer fail-open Telegram integration changes. If deep links, copies, draft
  updates, or other Telegram niceties fail, preserve the underlying Codex turn
  flow unless the feature explicitly requires hard failure.
- Preserve the topic-centric model: one Telegram topic maps to one Codex thread.

## Detached Local Runs

- Use `npm run dev:tmux` for a detached watched development session, or
  `npm run start:tmux` for a detached production session from `apps/bot/dist`.
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
  [packages/kirbot-core/tests/bridge.test.ts](/home/jtkw/kirbot/packages/kirbot-core/tests/bridge.test.ts) and the
  narrower unit around the touched subsystem, such as
  [packages/telegram-harness/tests/harness.test.ts](/home/jtkw/kirbot/packages/telegram-harness/tests/harness.test.ts),
  [packages/kirbot-core/tests/turn-lifecycle.test.ts](/home/jtkw/kirbot/packages/kirbot-core/tests/turn-lifecycle.test.ts),
  [packages/kirbot-core/tests/telegram-messenger.test.ts](/home/jtkw/kirbot/packages/kirbot-core/tests/telegram-messenger.test.ts),
  [packages/telegram-format/tests/telegram-format.test.ts](/home/jtkw/kirbot/packages/telegram-format/tests/telegram-format.test.ts),
  or [packages/codex-client/tests/codex.test.ts](/home/jtkw/kirbot/packages/codex-client/tests/codex.test.ts).
- Use the existing fake Telegram/Codex adapters in tests and extend them rather
  than introducing one-off mocks when possible.
- Prefer [packages/telegram-harness/tests/harness.test.ts](/home/jtkw/kirbot/packages/telegram-harness/tests/harness.test.ts) or
  direct harness probes when the important question is what Telegram would
  visibly show after async orchestration, especially for draft cleanup,
  ordering, callback flows, and restart/race regressions.
- When changing completion footers, queue previews, commands, approvals, or
  mode routing, assert the exact user-visible Telegram text so regressions stay
  obvious.
- Leave touched code clean under the repo's unused-code compiler checks.
  Remove unused imports, locals, parameters, exports, and placeholder no-op
  helpers instead of suppressing them or leaving dead compatibility shims in
  place.

## PR Notes

- When a bug has a concrete repro, describe the PR in terms of the
  user-visible before/after behavior, not just the internal refactor.
- If harness verification was part of the investigation, summarize the repro
  and the post-fix harness result in the PR description.

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
