# Group-Only Forum Supergroup Migration Design

## Summary

Kirbot should stop using Telegram bot private chats as its primary surface and
move to a single private forum-enabled supergroup. The supergroup's `General`
topic becomes the persistent root Codex session. Kirbot-created forum topics
remain the unit of isolated work, but each topic is now a shared session that
any group member can continue.

This migration is intended to solve the current UX issue where Telegram private
chat topics still feel like one consolidated DM thread. Forum supergroups are a
better fit for Kirbot's "main lobby plus work threads" interaction model.

## Goals

- Make Telegram topics feel like first-class parallel workspaces.
- Preserve Kirbot's current root-session plus spawned-topic workflow.
- Support shared collaborative sessions inside the group.
- Keep the user-facing command model close to the current one.

## Non-Goals

- Supporting both private-chat and supergroup modes at the same time.
- Preserving single-user-only access control.
- Requiring mentions or replies before Kirbot accepts input.
- Redesigning the core Codex thread/session abstractions beyond what the forum
  migration requires.

## Product Decisions

### Chat Mode

- Kirbot becomes group-only.
- Bot DMs are unsupported and should return a short redirect message pointing
  users to the configured forum supergroup.
- The configured supergroup is a dedicated Kirbot workspace, not a mixed-use
  social chat.

### Root Session

- The supergroup `General` topic is the persistent root Codex session.
- Normal messages in `General` continue the shared root session.
- Root `/plan [prompt]` in `General` creates a new plan-oriented forum topic,
  matching the current root `/plan` topic-spawn behavior.

### Topic Sessions

- Each non-`General` topic maps to one shared Codex session.
- `/thread <prompt>` in `General` creates a new forum topic, seeds the first
  user message into that topic, and starts its first turn there.
- Normal messages in an existing mapped topic continue that topic's shared
  session.
- If a user sends a normal message in an unmapped existing topic, Kirbot should
  start a shared session in that topic, matching the current "bootstrap an
  existing topic on first message" behavior.

### Access Control

- Any group member can use Kirbot.
- Kirbot no longer filters all traffic down to a single configured Telegram user
  ID.
- Session ownership is topic-based, not user-based.

### Input Rules

- In `General`, any normal supported message is treated as Kirbot input.
- In a Kirbot-managed topic, any normal supported message is treated as Kirbot
  input.
- Kirbot does not require mentions or replies for normal operation.
- Because of that, the workspace must be treated as dedicated to Kirbot.

## Interaction Model

### Commands

- `General` supports the root-oriented commands, including `/thread`,
  `/plan [prompt]`, and shared command-management flows such as `/cmd`.
- Topic-local commands such as `/stop`, topic `/plan`, `/implement`, and
  topic-level settings remain scoped to the current topic session.
- The existing root/topic command distinction stays conceptually the same, but
  it is reinterpreted as `General` versus non-`General` forum topic.

### Shared Topic Behavior

- A topic session is shared by everyone posting in that topic.
- Follow-up steering and queued messages are also shared.
- Approvals and structured user-input prompts are shared at the topic level.
- Telegram-visible queue and status UX should include actor attribution so users
  can tell who supplied a queued follow-up or answer.

### Workspace Onboarding

- Kirbot should post or refresh a short workspace explainer in `General`.
- The explainer should state that `General` is the main session, `/thread`
  creates work topics, and normal messages in Kirbot topics are treated as bot
  input.

## Architecture Impact

### Surface Model

Today, Kirbot effectively treats `topicId = null` as the root private chat and
`topicId != null` as a Telegram topic. That mapping is too implicit for a forum
supergroup migration because Telegram's `General` topic is special.

The bridge should move to an explicit surface model:

- `general` for the supergroup `General` topic
- `topic` for a named non-`General` forum topic

This can still persist a `chatId` plus optional Telegram thread identifier, but
the surface kind should no longer overload `null` to mean "private root chat".

### Telegram Update Handling

Inbound Telegram handling needs to become forum-supergroup aware:

- Accept updates from the configured workspace supergroup.
- Stop assuming the root chat is a private bot DM.
- Stop rejecting all users other than one configured owner.
- Normalize `General` and non-`General` topics into the new surface model before
  they reach bridge routing.

The code currently enforcing the single-user private-chat model lives in
`apps/bot/src/index.ts` and should be reworked around workspace chat identity
instead of sender identity.

### Command Sync

Telegram command sync currently targets default scope and a private chat whose
chat ID equals the configured allowed user ID. That must be replaced with
supergroup-scoped command sync for the configured workspace chat.

### Persistence

The database already stores session surface kind and Telegram topic ID. The
schema should be adjusted so it can clearly represent:

- the workspace `General` session
- named forum-topic sessions

Existing persisted rows for private-chat root sessions and private topics do not
need to be migrated in place if this rollout is explicitly group-only and
breaking. A clean workspace bootstrap is acceptable.

### Messenger And Delivery

Outgoing Telegram delivery should continue targeting the owning chat/topic
surface, but all assumptions about "private root chat" need to be removed.

Forum-topic message delivery remains based on `message_thread_id`. `General`
delivery needs to be normalized consistently so the bridge and messenger agree
on whether it is represented as an explicit general surface or as a missing
thread ID at the API boundary.

## Risks

### General Topic Semantics

Telegram treats the `General` topic differently from other forum topics. Kirbot
must normalize that behavior carefully so root-session routing is stable and not
dependent on ad hoc `null` handling.

### Shared Concurrency

The current UX assumes one human operator. In a shared topic, queued follow-ups,
approvals, and active-turn state become multi-user coordination surfaces. Actor
labels should be added as part of the migration so the shared state stays
understandable.

### Accidental Prompts

Because any plain message in `General` or a Kirbot topic counts as input, the
workspace must stay dedicated to Kirbot. Mixed-use chatter would create
accidental prompts.

### Telegram Delivery Constraints

Reliable group behavior depends on correct bot setup in the supergroup. The bot
must be configured so Telegram delivers the messages Kirbot expects in the
workspace.

## Rollout Strategy

### Migration Shape

- Treat this as a breaking product migration from private-chat mode to
  forum-supergroup mode.
- Update docs, environment/config naming, and startup validation to reflect the
  new workspace requirement.
- Prefer a clean new workspace over compatibility layers for legacy DM topics.

### Verification Targets

The migration should be covered by bridge-level tests for:

- `General` as the persistent root session
- root `/thread` and root `/plan` topic creation from `General`
- first-message bootstrap in an unmapped existing forum topic
- shared multi-user follow-ups and queue behavior inside one topic
- topic-local approvals and user-input prompts in shared sessions
- DM rejection/redirect behavior
- command sync scoped to the workspace supergroup

## Recommendation

Proceed with the group-only forum-supergroup migration, keeping `General` as the
persistent root session and using shared free-form sessions in all Kirbot topics.
This preserves Kirbot's current mental model while moving it onto a Telegram UX
surface that matches the product more naturally.
