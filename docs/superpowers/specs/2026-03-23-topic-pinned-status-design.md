# Topic Pinned Status Design

## Summary

Kirbot should turn the topic startup footer into a durable pinned topic-status
message for each non-`General` forum topic session. That message becomes the
stable "thread status" surface for the topic.

Per-turn live progress should stay exactly where it is today: the transient
status bubble managed by
[telegram-turn-surface.ts](/home/dev/kirbot/packages/kirbot-core/src/bridge/telegram-turn-surface.ts).
The behavior change is only for the durable footer path:

- when a topic session starts, Kirbot sends the startup footer, stores its
  message id, and pins it
- when a topic turn finishes, Kirbot edits that pinned topic-status message
  with the latest completion footer instead of sending a new footer message

Assistant replies remain separate normal Telegram messages.

## Goals

- Keep one stable, pinned status message per Kirbot-managed topic session.
- Remove the extra footer message Kirbot currently sends after topic assistant
  replies.
- Preserve the current live-progress UX during active turns.
- Make the topic-status message survive process restarts so later turns can
  keep editing it.
- Keep the change scoped to topic sessions, not `General`.

## Non-Goals

- Replacing assistant reply messages with edits to the pinned status message.
- Replacing the transient live-progress status bubble.
- Changing root/`General` completion-footer behavior in this pass.
- Reworking request-coordinator prompts, queue previews, or approval flows.
- Adding a broader "message pinning policy" abstraction for all Telegram
  surfaces.

## Current Behavior

Kirbot currently has two different Telegram status surfaces for a topic:

1. A startup footer sent once when a topic session is provisioned in
   [bridge.ts](/home/dev/kirbot/packages/kirbot-core/src/bridge.ts#L1948)
   through
   [maybeSendThreadStartFooterMessage](/home/dev/kirbot/packages/kirbot-core/src/bridge.ts#L2000).
2. A transient per-turn status bubble in
   [telegram-turn-surface.ts](/home/dev/kirbot/packages/kirbot-core/src/bridge/telegram-turn-surface.ts#L31)
   that is edited during the turn and either deleted after the final assistant
   message or reused only for terminal fallback text.

After a completed turn, Kirbot also sends a fresh completion footer message in
[turn-finalization.ts](/home/dev/kirbot/packages/kirbot-core/src/bridge/turn-finalization.ts#L286).
That creates a growing trail of status/footer messages in the topic even though
the footer content is logically "current topic state."

## Proposed Approaches

### 1. Recommended: persistent pinned topic-status message

Persist one message id per topic session. Create and pin that message at topic
startup, then edit it with the latest completion footer after each completed
topic turn.

Pros:

- matches the desired UX directly
- keeps live progress isolated from durable topic metadata
- survives restarts because the message id is stored with the session
- minimizes behavioral churn outside topic startup/finalization

Cons:

- requires database and Telegram API surface changes
- needs fallback behavior when the stored message was deleted or unpinned

### 2. Reuse the transient per-turn status bubble

Promote the existing live-progress bubble into the durable pinned topic-status
message and stop deleting it after the final assistant publish.

Pros:

- avoids a second topic-status concept

Cons:

- couples temporary turn-local state to durable topic state
- makes turn-surface lifecycle much harder to reason about
- risks race conditions between live status edits and completion-footer updates

### 3. Derive the pinned message id from Telegram state on demand

Do not persist the topic-status message id. Instead, rely on Telegram's pinned
message state or topic service messages whenever Kirbot needs to update the
status.

Pros:

- avoids a schema change

Cons:

- Telegram does not give Kirbot a clean, local, restart-safe ownership model
  for "the Kirbot topic-status message"
- makes failure handling and tests much more fragile

## Recommendation

Use a persistent pinned topic-status message.

Kirbot already treats topic sessions as durable bridge state. The pinned status
message is part of that session surface and should be owned the same way, with
an explicit stored message id rather than inference from Telegram state.

## Architecture

### Session State

Add a nullable `topic_status_message_id` field to topic-capable session rows in
[db.ts](/home/dev/kirbot/packages/kirbot-core/src/db.ts) and expose it through
the session/domain types.

Requirements:

- `general` sessions keep this field `null`
- topic sessions may start with `null` during provisioning failures or legacy
  rows
- bridge code can read and update the stored topic-status message id without
  inferring it from Telegram

This should be a normal schema migration, not an in-memory cache, because the
message must remain editable after a process restart.

### Telegram API Surface

Extend the Telegram abstraction to support topic-status pinning:

- add `pinChatMessage(chatId, messageId, options?)`
- optionally add `unpinChatMessage` only if implementation needs cleanup; it is
  not required for the requested behavior

`apps/bot/src/index.ts` should wire the new method through `grammy`'s raw Bot
API. `telegram-messenger.ts` should own the public messenger-level helper for
pinning, keeping Telegram writes centralized.

### Topic Status Ownership

Introduce a bridge/database helper responsible for "ensure topic-status
message":

- if the session already has `topic_status_message_id`, use it
- otherwise create the startup footer message, store its id, and pin it

This helper should be callable both during topic startup and later finalization
fallbacks. That avoids a brittle one-shot assumption that the startup pin
always succeeded.

## Runtime Flow

### Topic Startup

Current topic startup in
[bridge.ts](/home/dev/kirbot/packages/kirbot-core/src/bridge.ts#L1915) should
change from "send startup footer best-effort" to "ensure pinned topic-status
message."

Recommended flow:

1. Provision/activate the topic session as today.
2. Render the existing thread-start footer text.
3. Send it as a normal topic message.
4. Store the returned message id on the topic session.
5. Pin that message in the topic.
6. Continue with initial prompt mirroring and optional first turn even if the
   pin step fails.

Important behavior:

- sending the startup footer is still best-effort for startup continuity
- if sending succeeds but pinning fails, the stored message id should still be
  retained so Kirbot can edit that same message later
- if sending fails entirely, the session should still start; later completion
  footer updates can lazily create the missing topic-status message

### Active Turn Progress

No behavior change.

The transient bubble in
[telegram-turn-surface.ts](/home/dev/kirbot/packages/kirbot-core/src/bridge/telegram-turn-surface.ts)
continues to:

- send typing actions
- create/edit a temporary status message during the turn
- delete that temporary status message after the final assistant message is
  published

This preserves the current "live progress stays transient" rule.

### Topic Turn Finalization

Current topic finalization in
[turn-finalization.ts](/home/dev/kirbot/packages/kirbot-core/src/bridge/turn-finalization.ts#L286)
should branch by surface:

- `General` or root turns keep the current "send a completion footer message"
  behavior
- topic turns render the same completion footer content but edit the pinned
  topic-status message instead of sending a new message

Recommended flow for topic turns:

1. Build the completion footer exactly as today.
2. Ask the bridge/topic-status helper for the topic status message id.
3. Edit that message with the rendered footer text.
4. Attach the topic command reply keyboard if present, matching the current
   completion footer behavior.

The final assistant reply still publishes first. Only the footer publication
step changes.

## Failure Handling

### Missing Stored Message Id

If a topic session has no stored `topic_status_message_id` when a turn
finalizes:

- create a new topic-status message using the current footer text
- store its id
- attempt to pin it
- continue even if pinning fails

This covers legacy sessions and startup-footer send failures.

### Edit Rejected By Telegram

If Telegram rejects the edit because the stored message no longer exists or is
otherwise unusable:

- create a replacement topic-status message with the latest footer text
- store the replacement id
- pin the replacement message
- do not send an additional footer message for that turn

This keeps the "one durable topic-status message" invariant even when users or
admins delete the pinned message manually.

### Pin Rejected By Telegram

Pin failures should be logged but should not fail the session or the turn.

The durable value is the reusable message id, not the pin API response. Kirbot
should still keep editing the stored topic-status message even if Telegram
refuses to pin it because of permissions or transient errors.

## Testing

### Database

Add coverage in
[db.test.ts](/home/dev/kirbot/packages/kirbot-core/tests/db.test.ts) for:

- schema creation/migration with `topic_status_message_id`
- round-tripping the stored value for topic sessions
- preserving `null` for `general` sessions

### Topic Startup

Add bridge-level tests in
[bridge.test.ts](/home/dev/kirbot/packages/kirbot-core/tests/bridge.test.ts)
for:

- creating a topic from `/thread` stores and pins the startup footer message
- bootstrap of an existing unmapped topic also stores and pins the startup
  footer
- startup continues when pinning fails
- later turns can recover when startup footer send failed

### Turn Finalization

Add lifecycle/finalization coverage in
[turn-lifecycle.test.ts](/home/dev/kirbot/packages/kirbot-core/tests/turn-lifecycle.test.ts)
for:

- topic turns edit the pinned topic-status message instead of sending a new
  footer message
- `General` turns still send a normal completion footer message
- topic command reply markup is applied to the edited pinned message
- deleted/missing pinned message ids cause replacement-message recreation

### Messenger And Harness

Add coverage in:

- [telegram-messenger.test.ts](/home/dev/kirbot/packages/kirbot-core/tests/telegram-messenger.test.ts)
- [harness.test.ts](/home/dev/kirbot/packages/telegram-harness/tests/harness.test.ts)

for:

- `pinChatMessage` wiring
- recording pin operations in the Telegram harness
- replacement-message flows that depend on messenger edit/send behavior

## Risks

### Restart Drift

If the topic-status message id is not persisted, later turns after restart would
not know what to edit. That is why this design requires schema-backed storage.

### Mixed Footer Semantics

The startup footer includes onboarding guidance, while later completion footers
do not. Editing the pinned message after the first turn will replace the
startup guidance with the latest footer. This is acceptable for this change
because the user explicitly wants the pinned status to reflect current state,
not permanent onboarding copy.

### Telegram Permissions

If the bot lacks permission to pin messages, the message can still act as the
durable topic-status record but it will not stay visually pinned. This is a
deployment/configuration issue, not a reason to block the feature.

## Open Assumption

This design intentionally scopes the pinned-status behavior to non-`General`
topic sessions. The existing root/`General` footer behavior remains unchanged.
