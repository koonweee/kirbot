# Unified Session Model Design

**Date:** 2026-03-21

**Status:** Proposed

## Goal

Refactor kirbot from a topic-centric bridge into a unified session model where:

- the Telegram root chat owns one persistent Codex thread
- plain root messages continue that persistent root thread
- `/thread <prompt>` creates a new topic-backed session
- root `/plan [prompt]` still creates a new plan-oriented topic-backed session
- root `/model`, `/fast`, and `/permissions` manage both the persistent root session settings and the defaults used for newly spawned topic sessions
- custom commands are shared across the Telegram chat and can be invoked from either root or topic sessions

## Current State

Today, kirbot is intentionally topic-centric:

- a root-chat message usually creates a new Telegram topic and a new Codex thread
- a Telegram topic maps to one Codex thread
- `topic_sessions` is the primary persisted identity
- custom commands are topic-only

This model conflicts with the desired product behavior because the root chat is becoming a first-class long-lived session instead of only a topic-spawning lobby.

## Design Summary

Replace the current topic-centric persistence and routing model with a unified session model:

- a `root` session represents the persistent Codex thread bound to the Telegram root chat
- a `topic` session represents a Codex thread bound to a Telegram topic
- both session types share the same core lifecycle, mode, turn routing, and settings handling
- root-level settings are split into:
  - settings for the live persistent root session
  - defaults for newly spawned topic sessions

This keeps Telegram surfaces distinct while removing the assumption that only topics can own a Codex thread.

## User-Facing Behavior

### Root Chat

- Plain non-command messages in the root chat are sent to the persistent root Codex session.
- The first such message after deploy lazily creates the root session if it does not exist yet.
- `/thread <prompt>` creates a new Telegram topic, creates a new topic-backed Codex session using spawn defaults, mirrors the prompt into the topic, and starts the first turn there.
- `/plan [prompt]` in root continues to create a new plan-oriented topic-backed session instead of switching the root session into plan mode.
- `/start` is removed.

### Topic Sessions

- Existing topic-backed behavior remains largely intact.
- Plain messages continue the mapped topic session.
- `/plan` and `/implement` continue to switch the topic session mode.
- `/model`, `/fast`, and `/permissions` in a topic affect only that topic session.

### Settings Commands In Root

- `/model`, `/fast`, and `/permissions` in root must let the user choose between:
  - updating the persistent root session
  - updating spawn defaults for future topic sessions
- The chosen scope must be explicit in the callback flow and confirmation text.

### Custom Commands

- Custom commands are shared across the Telegram chat.
- They can be invoked from root or topic sessions.
- Invocation always expands into the current session surface:
  - root invocation targets the persistent root session
  - topic invocation targets that topic session
- Existing command-management flows remain chat-scoped, not session-scoped.

## Data Model

### Sessions

Replace `topic_sessions` with a generic `sessions` table.

Each row stores:

- `id`
- `telegram_chat_id`
- `surface_kind` with values `root` or `topic`
- `telegram_topic_id`, nullable for `root`, required for `topic`
- `codex_thread_id`
- `status`
- `preferred_mode`

Constraints:

- exactly one active `root` session per Telegram chat
- exactly one session per `(telegram_chat_id, telegram_topic_id)` for `topic` sessions
- `telegram_topic_id` must be null for `root` and non-null for `topic`

`preferred_mode` remains persisted in kirbot for now. Upstream Codex core appears to persist collaboration mode internally, but the current app-server protocol used by kirbot does not expose mode reliably enough for kirbot to trust it as restart-safe thread metadata.

### Chat Defaults

Add a chat-scoped defaults table for root and spawn settings.

Each row stores:

- `telegram_chat_id`
- `root_model`
- `root_reasoning_effort`
- `root_service_tier`
- `root_approval_policy`
- `root_sandbox_policy`
- `spawn_model`
- `spawn_reasoning_effort`
- `spawn_service_tier`
- `spawn_approval_policy`
- `spawn_sandbox_policy`

This separates:

- the settings for the live persistent root session
- the defaults applied when creating new topic sessions from `/thread` or root `/plan`

### Existing Tables

Keep these concepts intact unless implementation proves a rename is necessary:

- `server_requests`
- `processed_updates`
- `custom_commands`
- `pending_custom_command_adds`

`server_requests` will need routing updates so each request resolves back to the owning session surface instead of assuming topic-only ownership.

## Routing Model

### Session Resolution

Introduce a generic session lookup layer:

- resolve root messages to the chat's `root` session
- resolve topic messages to the `(chat, topicId)` `topic` session
- lazily create the root session when missing
- lazily create a topic session only through explicit spawn flows such as `/thread` or root `/plan`, not by plain root messages

### Turn Submission

All turn submission should flow through generic session-aware helpers:

- resolve the target session
- ensure the Codex thread exists and is loaded
- compute effective collaboration mode from the session's persisted `preferred_mode`
- submit the turn
- attach Telegram-visible lifecycle state to the correct surface

### Session Creation

The bridge should expose one shared session-creation path parameterized by surface:

- `root` session creation for persistent root thread bootstrap
- `topic` session creation for `/thread`
- `topic` session creation for root `/plan` with initial mode `plan`

This creation path should own:

- persistence
- Codex thread creation
- startup footer / startup presentation
- optional prompt mirroring
- optional initial turn

## Presentation And UX

The existing footer and command rendering should become surface-aware instead of topic-only.

Requirements:

- root startup/footer messaging should render in the main chat without topic metadata
- topic startup/footer messaging should keep the current topic presentation style
- root command UI for `/model`, `/fast`, and `/permissions` must clearly identify whether the user is editing:
  - the current root session
  - future spawned-topic defaults
- help text, docs, and invalid-command responses must stop describing root as only a topic-spawning lobby
- command keyboards and root/topic command availability need updating for `/thread` and `/start` removal

## Migration Strategy

Migration should be additive and low-risk.

### Database Migration

1. Add the new `sessions` table.
2. Add the new chat-defaults table.
3. Backfill all existing `topic_sessions` rows into `sessions` with `surface_kind = topic`.
4. Leave root sessions absent until first use after deploy.
5. Once bridge code is cut over, remove old `topic_sessions` reads and writes.

It is acceptable to keep the old table temporarily during rollout if that reduces migration risk. Final cleanup can happen in a follow-up once the new path is stable.

### Runtime Migration

- Existing topic sessions continue working after migration.
- The first root interaction after deploy creates or resumes the persistent root session.
- No attempt should be made to invent historical root-session state from old root messages.
- Existing custom commands remain valid because they stay chat-scoped.

## Error Handling

- If persistent root-session creation fails, respond in root and do not leave behind a partially active session row.
- If `/thread` creates the Telegram topic but Codex thread creation fails, mark the session errored and report failure in the topic.
- If session-scoped settings changes are attempted while a turn is active, keep the current rejection behavior.
- If root-scope settings flow is ambiguous or callback state is stale, fail explicitly rather than silently applying the wrong scope.
- Optional Telegram niceties should remain fail-open when possible; underlying Codex turn routing matters more than presentation extras.

## Testing Strategy

Update tests around the user-visible contract first.

### Bridge Coverage

Add or update tests for:

- persistent root session creation on first plain root message
- repeated plain root messages reusing the same root Codex thread
- `/thread <prompt>` creating a topic session using spawn defaults
- root `/plan [prompt]` creating a topic session in plan mode using spawn defaults
- root `/model`, `/fast`, and `/permissions` scoping between root-session settings and spawn defaults
- topic `/model`, `/fast`, and `/permissions` still affecting only the topic session
- root and topic custom command invocation using the current session
- `/start` no longer being available

### Persistence Coverage

Add or update tests for:

- `sessions` uniqueness rules for `root` and `topic`
- session lookup by root surface and topic surface
- backfilled topic-session compatibility
- chat-defaults reads and writes for root and spawn settings

### Request Routing Coverage

Add or update tests for:

- approvals requested from the root session routing back to the root chat
- approvals requested from topic sessions routing back to the correct topic
- structured user-input requests preserving the owning surface

### Harness Coverage

Prefer harness-level verification for root/topic UX differences:

- root transcript shows persistent ongoing conversation instead of automatic topic creation
- `/thread` creates a topic transcript with the initial prompt mirrored into the topic
- topic behavior remains stable for existing flows

## Risks

### Medium Risk: Topic-Centric Assumptions

The current bridge, docs, and tests assume one Telegram topic maps to one Codex thread. This refactor changes that invariant to "one Telegram session surface maps to one Codex thread". Hidden topic-only assumptions may exist in:

- request routing
- presentation helpers
- startup footer logic
- command keyboards
- tests asserting topic creation on root messages

### Medium Risk: Split Root Settings UX

Root-scoped `/model`, `/fast`, and `/permissions` become dual-scope operations. If the UI is unclear, users may accidentally change the current root session when they intended to edit spawn defaults, or vice versa.

### Low Risk: Custom Command Scope Expansion

Because custom commands remain chat-scoped, broadening invocation from topic-only to root-plus-topic is conceptually simple. The main work is removing routing and help-text assumptions.

## Out Of Scope

These are intentionally excluded from this refactor:

- per-session custom command sets
- changing root `/plan` to reuse the persistent root session
- inferring or restoring historical root conversations from pre-migration data
- relying on app-server collaboration-mode persistence as kirbot's sole mode source
- redesigning Mini App artifacts beyond what is needed for the new routing model

## Recommendation

Implement the unified session model in kirbot while keeping Telegram root and topic surfaces distinct. This gives the product behavior you want without preserving the old special-case "topic owns thread, root only spawns topics" assumption in persistence and routing.
