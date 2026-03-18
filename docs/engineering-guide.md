# Engineering Guide

This is the practical onboarding guide for engineers changing kirbot. It focuses on where to work, what to test, and how to keep the documentation useful without turning it into a duplicate of the code.

## Read In This Order

1. [README.md](../README.md)
2. [architecture.md](architecture.md)
3. [user-flows.md](user-flows.md)
4. [`packages/telegram-format/README.md`](/home/jtkw/kirbot/packages/telegram-format/README.md) if your change touches Telegram formatting
5. [telegram-harness.md](telegram-harness.md) if your change affects harness-driven E2E flows

## Local Setup

Prerequisites:

- Node.js 22+
- `tmux` if you want detached dev or production sessions
- a Telegram bot token
- the Telegram user ID kirbot should accept

Initial setup:

```bash
npm install
cp .env.example .env
```

Daily commands:

```bash
npm run dev
npm run dev:tmux
npm run dev:tmux:attach
npm run dev:tmux:restart
npm start
npm run start:tmux
npm run start:tmux:attach
npm run start:tmux:restart
npm run harness:telegram
npm test
npm run typecheck
```

Use `npm run dev` for watched local development. Use `npm start` only for the built production output in `dist/`.

Detached tmux workflow:

- `npm run dev:tmux` ensures a detached `kirbot-dev` session running the watched development command.
- `npm run start:tmux` ensures a detached `kirbot-prod` session running the production `start` command.
- `npm run dev:tmux:attach` and `npm run start:tmux:attach` attach to the existing tmux session so you can read live logs. When already inside tmux they switch clients instead of nesting sessions.
- `npm run dev:tmux:restart` and `npm run start:tmux:restart` restart the pane in place and create the tmux session first if it does not exist.
- Production tmux sessions assume `dist/` is current. Run `npm run build` before starting or restarting the detached production session.
- Prefer these tmux commands over ad-hoc `nohup`, background `&`, or orphaned node processes when an engineer or agent needs a detached kirbot process.

Telegram harness workflow:

- `npm run harness:telegram` starts an interactive harness that runs the real kirbot runtime with a recording Telegram transport.
- The harness now isolates its Codex app-server port, SQLite state, media temp directory, and Codex workspace by default, so it can run beside a live kirbot dev or production process safely.
- Use the harness when you want agent-driven app-level E2E coverage without a real Telegram client.
- See [telegram-harness.md](telegram-harness.md) for transcript, raw event, and log inspection details.

Codex upgrade commands:

```bash
npm run verify:codex-types
npm run generate:codex-types
npm run verify:codex-upgrade
```

## Change Map

Start from the user-visible behavior you want to change, then narrow to the owning module.

Session creation, topic routing, slash commands, callback routing:
[`packages/kirbot-core/src/bridge.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/bridge.ts)

Turn status, streaming, completion, queue drain:
[`packages/kirbot-core/src/bridge/turn-lifecycle.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/bridge/turn-lifecycle.ts)

Approvals and structured user input:
[`packages/kirbot-core/src/bridge/request-coordinator.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/bridge/request-coordinator.ts)

Telegram-facing status/footer/queue preview text:
[`packages/kirbot-core/src/bridge/presentation.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/bridge/presentation.ts)

Draft delivery and final Telegram messages:
[`packages/kirbot-core/src/telegram-messenger.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/telegram-messenger.ts)

Telegram formatting entities, chunking, UTF-16 offsets:
[`packages/telegram-format/src`](/home/jtkw/kirbot/packages/telegram-format/src)

Codex app-server interaction:
[`packages/codex-client/src/codex.ts`](/home/jtkw/kirbot/packages/codex-client/src/codex.ts) and [`packages/codex-client/src/rpc.ts`](/home/jtkw/kirbot/packages/codex-client/src/rpc.ts)

Persistence and restart behavior:
[`packages/kirbot-core/src/db.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/db.ts)

Reusable runtime bootstrap:
[`packages/kirbot-core/src/runtime.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/runtime.ts)

Telegram harness transport and transcript synthesis:
[`packages/telegram-harness/src`](/home/jtkw/kirbot/packages/telegram-harness/src)

## Testing Expectations

Prefer the existing fake Telegram and fake Codex adapters over new one-off mocks.

Common test targets:

- end-to-end bridge behavior: [`packages/kirbot-core/tests/bridge.test.ts`](/home/jtkw/kirbot/packages/kirbot-core/tests/bridge.test.ts)
- harness-driven conversational E2E coverage: [`packages/telegram-harness/tests/harness.test.ts`](/home/jtkw/kirbot/packages/telegram-harness/tests/harness.test.ts)
- turn finalization and queue semantics: [`packages/kirbot-core/tests/turn-lifecycle.test.ts`](/home/jtkw/kirbot/packages/kirbot-core/tests/turn-lifecycle.test.ts)
- Telegram delivery mechanics: [`packages/kirbot-core/tests/telegram-messenger.test.ts`](/home/jtkw/kirbot/packages/kirbot-core/tests/telegram-messenger.test.ts)
- formatting behavior: [`packages/telegram-format/tests/telegram-format.test.ts`](/home/jtkw/kirbot/packages/telegram-format/tests/telegram-format.test.ts)
- persistence behavior: [`packages/kirbot-core/tests/db.test.ts`](/home/jtkw/kirbot/packages/kirbot-core/tests/db.test.ts)
- Codex contract assumptions: [`packages/codex-client/tests/codex.test.ts`](/home/jtkw/kirbot/packages/codex-client/tests/codex.test.ts)

When changing user-visible Telegram text, assert the exact text in tests so regressions are obvious.
When changing harness-visible Telegram behavior, update the transcript/event expectations in
[`packages/telegram-harness/tests/harness.test.ts`](/home/jtkw/kirbot/packages/telegram-harness/tests/harness.test.ts)
and [telegram-harness.md](telegram-harness.md) if the usage model changed.

## Documentation Rules

The docs should help a new engineer build the right mental model quickly. They should not be a second copy of the implementation.

Keep docs DRY:

- document responsibilities, invariants, and user flows
- link to the owning file or test instead of describing function-by-function internals
- prefer one stable explanation of a concept and have other docs link to it

Update documentation when you change:

- the onboarding path for a new engineer
- a user-visible flow in Telegram
- module ownership or architectural boundaries
- setup, environment, or upgrade workflow
- any instruction in `AGENTS.md`

Do not update documentation only to mirror refactors with no behavioral or ownership change.

## Documentation Ownership

Use the narrowest document that still matches the change:

- `README.md` for repo entrypoint and quick-start expectations
- `docs/architecture.md` for system shape and code ownership
- `docs/user-flows.md` for user-visible behavior and flow-to-code mapping
- `docs/engineering-guide.md` for change workflow and maintenance guidance
- `docs/telegram-harness.md` for harness usage and extension guidance
- `packages/telegram-format/README.md` for formatting-specific behavior
- `AGENTS.md` files for instructions future contributors and coding agents should follow

## Before You Finish A Change

Run the narrowest meaningful verification first, then the broader suite if the change is cross-cutting.

Minimum close-out checklist:

- code change is in the owning module
- relevant tests were added or updated
- docs were updated if behavior, ownership, or setup changed
- generated Codex bindings were touched only if the pinned dependency changed
