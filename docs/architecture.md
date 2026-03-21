# Architecture

This document explains the stable shape of the system: the runtime pieces, the ownership boundaries between modules, and the persisted concepts a new engineer needs before changing behavior.

For step-by-step behavior, read [user-flows.md](user-flows.md). For setup and change workflow, read [engineering-guide.md](engineering-guide.md).

## System Shape

kirbot is a single-process bridge with four main responsibilities:

- accept Telegram updates from one allowed user
- translate those updates into Codex threads, turns, approvals, and follow-up input
- stream Codex output back into Telegram topics
- persist enough state to survive restarts and keep topic-to-thread routing stable

At runtime, the process owns both sides of the bridge:

- a Telegram bot client
- a spawned Codex app server from the pinned `@openai/codex` dependency
- an RPC client connected to that app server
- a SQLite database for bridge state

The Telegram Mini App frontend itself lives separately in [`apps/plan-mini-app`](/home/jtkw/kirbot/apps/plan-mini-app).

## Startup And Shutdown

The process entrypoint is [`apps/bot/src/index.ts`](/home/jtkw/kirbot/apps/bot/src/index.ts), with
shared runtime bootstrap in [`packages/kirbot-core/src/runtime.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/runtime.ts).

Startup responsibilities:

- load environment and `apps/bot/KIRBOT.md` via [`packages/kirbot-core/src/config.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/config.ts)
- open and migrate SQLite via [`packages/kirbot-core/src/db.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/db.ts)
- clean stale Telegram-downloaded media via [`packages/kirbot-core/src/media-store.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/media-store.ts)
- expire pending Codex requests left behind by a prior process
- spawn and connect to the pinned Codex app server via [`packages/codex-client/src/codex.ts`](/home/jtkw/kirbot/packages/codex-client/src/codex.ts)
- register Telegram handlers and sync the visible command menu

Shutdown responsibilities:

- stop the Telegram bot
- close the RPC transport
- stop the spawned Codex app server
- close the database

## Code Map

The core modules are intentionally split by responsibility rather than by Telegram event type.

[`apps/bot/src/index.ts`](/home/jtkw/kirbot/apps/bot/src/index.ts)
Owns the real `grammy` bot entrypoint and translates raw Telegram updates into bridge calls.

[`packages/kirbot-core/src/runtime.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/runtime.ts)
Owns reusable kirbot bootstrap: config, DB/media startup, Codex startup, bridge wiring, command sync, and shutdown.

[`packages/kirbot-core/src/bridge.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/bridge.ts)
Owns high-level session and turn orchestration. This is the entrypoint for Telegram-driven behavior: session creation, turn submission, slash commands, callback handling, request routing, and notification fan-in.

[`packages/kirbot-core/src/bridge/turn-lifecycle.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/bridge/turn-lifecycle.ts)
Owns the lifecycle of an active turn after submission: status drafts, streaming drafts, finalization, queue-preview sync, and post-turn follow-up handling.

[`packages/kirbot-core/src/bridge/request-coordinator.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/bridge/request-coordinator.ts)
Owns Codex server requests that need user action in Telegram: command approvals, file approvals, and structured user-input prompts.

[`packages/kirbot-core/src/bridge/custom-commands.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/bridge/custom-commands.ts)
Owns custom slash-command parsing, validation, prompt expansion, and confirmation callback payload helpers for the shared `/cmd` flow and root/topic invocation.

[`packages/kirbot-core/src/bridge/presentation.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/bridge/presentation.ts)
Owns Telegram-facing presentation outside the formatting subsystem: topic titles, status text, completion footers, and queue previews.

[`packages/kirbot-core/src/turn-runtime.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/turn-runtime.ts)
Tracks in-memory turn state that does not belong in the database, especially streaming assembly and follow-up queue state.

[`packages/kirbot-core/src/telegram-messenger.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/telegram-messenger.ts)
Owns Telegram delivery behavior: drafts, persistent messages, draft clearing, and chat-action throttling.

[`packages/kirbot-core/src/mini-app/url.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/mini-app/url.ts)
Owns the typed Mini App artifact URL codec used by both the Telegram bridge and the shared static Mini App frontend.

[`packages/telegram-format/src/*`](/home/jtkw/kirbot/packages/telegram-format/src)
Owns Telegram text/entity formatting. This subsystem has its own local documentation and should be treated as the source of truth for formatting behavior.

[`packages/codex-client/src/codex.ts`](/home/jtkw/kirbot/packages/codex-client/src/codex.ts)
Wraps the Codex RPC surface in bridge-friendly operations such as thread start/resume, turn submission, turn interruption, thread archival, and turn readback.

[`packages/codex-client/src/rpc.ts`](/home/jtkw/kirbot/packages/codex-client/src/rpc.ts)
Implements the transport and request/response plumbing for the app-server connection.

[`packages/kirbot-core/src/db.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/db.ts)
Owns SQLite schema creation and all persistence operations used by the bridge.

[`packages/kirbot-core/src/telegram-command-sync.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/telegram-command-sync.ts)
Keeps Telegram command menus aligned with the commands kirbot supports.

[`packages/telegram-harness/src/*`](/home/jtkw/kirbot/packages/telegram-harness/src)
Owns the Telegram harness that drives the real kirbot core with synthetic inbound Telegram events and a recording outbound Telegram transport.

## Persisted Concepts

kirbot stores bridge state in SQLite, not Telegram metadata.

`topic_sessions`

- maps a Telegram chat/topic pair to one Codex thread
- stores the topic title and preferred session mode
- records whether a topic is provisioning, active, archived, or errored

`turn_messages`

- records one submitted Codex turn per Telegram user update
- stores streamed text, final message IDs, terminal status, and resolved assistant text

`server_requests`

- stores pending Codex requests that require Telegram interaction
- lets approvals and user-input prompts survive async handling and process restarts

`processed_updates`

- deduplicates Telegram updates so retries do not resubmit turns

`custom_commands`

- stores active user-defined topic slash commands and their expanded prompt text

`pending_custom_command_adds`

- stores pending `/cmd add` confirmations so add and cancel buttons survive async handling and process restarts

## Stable Design Rules

These boundaries matter more than the exact implementation:

- Keep `packages/kirbot-core/src/bridge.ts` as orchestration glue. Move reusable logic into `packages/kirbot-core/src/bridge/*` helpers.
- Keep Telegram formatting logic in `packages/telegram-format/src/*`, not in bridge or messenger code.
- Keep reusable app startup in `packages/kirbot-core/src/runtime.ts`, not split between the Telegram entrypoint and harness code.
- Prefer Telegram fail-open behavior when the extra UX affordance is optional. Session and turn delivery matter more than a copied message, deep link, or draft nicety.
- Treat tests as the executable contract for user-visible behavior.

## Where To Look For Behavior

When you need the authoritative behavior for a flow, start with tests:

- [`packages/kirbot-core/tests/bridge.test.ts`](/home/jtkw/kirbot/packages/kirbot-core/tests/bridge.test.ts) covers end-to-end bridge behavior and Telegram-visible outcomes.
- [`packages/kirbot-core/tests/turn-lifecycle.test.ts`](/home/jtkw/kirbot/packages/kirbot-core/tests/turn-lifecycle.test.ts) covers finalization, queueing, and completion metadata.
- [`packages/kirbot-core/tests/telegram-messenger.test.ts`](/home/jtkw/kirbot/packages/kirbot-core/tests/telegram-messenger.test.ts) covers draft delivery semantics.
- [`packages/telegram-format/tests/telegram-format.test.ts`](/home/jtkw/kirbot/packages/telegram-format/tests/telegram-format.test.ts) covers formatting behavior.
- [`packages/kirbot-core/tests/db.test.ts`](/home/jtkw/kirbot/packages/kirbot-core/tests/db.test.ts) and [`packages/codex-client/tests/codex.test.ts`](/home/jtkw/kirbot/packages/codex-client/tests/codex.test.ts) cover persistence and Codex integration contracts.
