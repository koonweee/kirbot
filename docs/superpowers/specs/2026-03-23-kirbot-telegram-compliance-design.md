# Kirbot Telegram Compliance Design

## Summary

Kirbot should move from reactive Telegram 429 handling to a centralized outbound
delivery policy for its single workspace forum supergroup. All outbound Telegram
operations that matter for group compliance should flow through one scheduler
that classifies operations, enforces conservative group-safe budgets, coalesces
low-value updates, and retries 429 responses using `retry_after`.

This design keeps the current product behavior where it matters most:

- final assistant answers still publish reliably
- callback buttons still feel immediate
- queue previews still reflect current state

But it stops treating every status edit, typing action, and topic-creation
request as an equally urgent Telegram call.

## Goals

- Keep Kirbot under Telegram's practical group limits in the dedicated workspace
  supergroup.
- Prevent known production 429s for `sendMessage`, `editMessageText`, and
  `createForumTopic`.
- Centralize Telegram delivery policy so rate behavior is not scattered across
  bridge code.
- Preserve user-visible responsiveness for important events while aggressively
  coalescing or dropping low-value traffic.
- Make topic creation and other non-message operations use the same compliance
  path as visible message sends.

## Non-Goals

- Supporting multiple workspace chats in this pass.
- Introducing a persisted cross-process job queue.
- Changing Kirbot's session model, topic model, or command model.
- Reworking Mini App artifact publication beyond fitting it into the new
  delivery path.
- Eliminating all Telegram retries. Retries remain necessary; they should just
  be governed centrally.

## Current Problems

Kirbot's current Telegram behavior is split across multiple call sites:

- [telegram-messenger.ts](/home/dev/kirbot/packages/kirbot-core/src/telegram-messenger.ts)
  retries 429s for `sendMessage` and `editMessageText`.
- [telegram-turn-surface.ts](/home/dev/kirbot/packages/kirbot-core/src/bridge/telegram-turn-surface.ts)
  allows status edits every 500 ms and typing actions every 3 seconds.
- [bridge.ts](/home/dev/kirbot/packages/kirbot-core/src/bridge.ts#L1804) and
  [bridge.ts](/home/dev/kirbot/packages/kirbot-core/src/bridge.ts#L1832) call
  `createForumTopic` directly with no retry or scheduling.
- queue preview edits in
  [bridge.ts](/home/dev/kirbot/packages/kirbot-core/src/bridge.ts#L2658) are
  retried only after Telegram rejects them.

This creates two failures:

1. Kirbot sends too much low-value Telegram traffic before it knows Telegram is
   unhappy.
2. Some operations are protected by retry logic while others fail directly.

## Proposed Approaches

### 1. Localized throttles

Patch status cadence, add topic-creation retries, and tune a few hot spots.

Pros:
- smallest code diff
- quickest short-term reduction in 429s

Cons:
- leaves Telegram policy split across several files
- easy to regress when new Telegram call paths are added
- hard to reason about the total budget consumed by one turn

### 2. Central outbound Telegram scheduler

Add one delivery layer that all outbound Telegram operations use.

Pros:
- one place to enforce compliance
- one place to classify priorities and coalescing rules
- extends naturally to future Telegram operations
- lets 429 responses slow the right class of work instead of just one request

Cons:
- moderate refactor
- requires updating tests around ordering and coalescing

### 3. Persisted delivery bus

Store pending outbound Telegram work in durable state and process it from a
worker-like dispatcher.

Pros:
- strongest crash resilience
- strongest future scaling story

Cons:
- too heavy for Kirbot's current single-workspace scope
- adds more operational and testing complexity than needed for compliance

## Recommendation

Use the central outbound Telegram scheduler.

Kirbot's current issue is not one isolated hot path. It is that Telegram
delivery policy is fragmented. A centralized scheduler solves the real problem:
it gives Kirbot one authoritative place to budget visible sends, edits, topic
creation, callback answers, deletes, and chat actions for the workspace group.

## Architecture

### Delivery Layer

Add a new core module, for example:

- `packages/kirbot-core/src/telegram-delivery-scheduler.ts`

This module owns:

- outbound operation classification
- per-class queueing
- group-safe rate budgets
- coalescing and deduplication
- 429 backoff state
- priority-based dispatch ordering

`TelegramMessenger` becomes the single public façade for Telegram writes, but it
should stop directly calling the raw Telegram API for most write operations.
Instead, it submits typed delivery operations to the scheduler and awaits their
result.

### Operation Classes

The scheduler should classify operations into explicit policy classes:

- `callback_answer`
  - highest priority
  - never coalesced
  - separate fast lane because Telegram clients wait on it
- `visible_send`
  - user-visible messages such as final assistant answers, failures, footers,
    and normal bridge responses
- `topic_create`
  - forum topic creation
  - treated as expensive and rate-limited at least as strictly as
    `visible_send`
- `visible_edit`
  - message edits for status bubbles and queue previews
- `delete`
  - best-effort cleanup operations
- `chat_action`
  - lowest priority
  - heavily deduplicated and often dropped

These classes should not just be labels for logging. They should control queue
position, budget consumption, coalescing rules, and 429 pause behavior.

### Coalescing Keys

Coalescing should be explicit and identity-based, not "best effort" string
replacement.

Recommended keys:

- status edits: by `(chatId, messageId)` for the status bubble
- queue preview edits: by `(chatId, messageId)` for the preview message
- chat actions: by `(chatId, topicId, action)`

Visible sends, topic creation, deletes, and callback answers should not be
coalesced by default.

### Single-Workspace Scope

This scheduler is scoped to one dedicated workspace supergroup. It does not need
cross-chat fairness logic in this pass. Internally, it can still keep `chatId`
on operations so the boundary remains clean, but the compliance policy is tuned
for one workspace group and its topics.

## Delivery Policy

### Group-Safe Budgets

Kirbot should adopt conservative defaults rather than trying to ride Telegram's
documented limits exactly.

The scheduler should expose explicit policy values for:

- max visible sends/topic creates per minute in the workspace group
- minimum spacing between status/preview edits
- minimum spacing between chat actions
- temporary class-specific pauses after 429s

The important design point is not the exact numeric defaults in this document.
It is that those defaults become configurable policy rather than hidden timing
constants spread across unrelated files.

### 429 Handling

Current `retry_after` parsing in
[telegram-messenger.ts](/home/dev/kirbot/packages/kirbot-core/src/telegram-messenger.ts#L198)
should be preserved, but the retry should move under scheduler control.

When Telegram returns 429:

- parse `retry_after`
- pause dispatch for the relevant operation class
- keep queued work pending instead of failing it immediately
- allow unrelated higher-priority lanes to keep flowing if their policy permits

This matters most for topic creation and visible edits, which currently either
fail directly or repeatedly collide with the same limit.

## Coalescing And Dropping Rules

### Status Bubble Updates

Status behavior in
[telegram-turn-surface.ts](/home/dev/kirbot/packages/kirbot-core/src/bridge/telegram-turn-surface.ts)
should be simplified around the scheduler.

Instead of trying to publish every intermediate render:

- keep at most one pending status edit per status message
- replace older pending status edits with the latest rendered state
- enforce a much longer edit interval than the current 500 ms cadence
- drop pending status edits entirely if a final assistant message is about to
  publish

The user should still see that Kirbot is active, but not every transient change
needs to reach Telegram.

### Queue Preview Edits

Queue preview updates in
[bridge.ts](/home/dev/kirbot/packages/kirbot-core/src/bridge.ts#L2658) should
use the same edit coalescing rule:

- only the latest preview body for a given preview message is worth sending
- repeated intermediate queue states should collapse to the newest state

### Chat Actions

Typing indicators should become sparse hints, not a parallel live stream.

Rules:

- allow at most one pending chat action per topic
- skip chat action if a visible status bubble already exists
- skip chat action if a visible send or edit happened recently
- drop chat actions freely under load before delaying visible content

### Deletes

Delete operations should remain best effort. They should use the scheduler so
they do not unexpectedly compete with final answer sends, but they should never
block user-visible completion.

## Call-Site Changes

### TelegramMessenger

[telegram-messenger.ts](/home/dev/kirbot/packages/kirbot-core/src/telegram-messenger.ts)
should become the owner of scheduling for:

- `sendMessage`
- `editMessageText`
- `createForumTopic`
- `sendChatAction`
- `deleteMessage`
- `answerCallbackQuery`

`downloadFile` stays outside the scheduler because it is not subject to the same
outbound message limits.

### Turn Surface

[telegram-turn-surface.ts](/home/dev/kirbot/packages/kirbot-core/src/bridge/telegram-turn-surface.ts)
should stop implementing its own effective Telegram pacing through short
cooldowns. It should decide what the latest desired visible status is and let
the scheduler decide when that becomes a Telegram edit.

### Topic Creation

Topic creation in
[bridge.ts](/home/dev/kirbot/packages/kirbot-core/src/bridge.ts#L1804) and
[bridge.ts](/home/dev/kirbot/packages/kirbot-core/src/bridge.ts#L1832) must go
through the same scheduled, retried path as visible sends. Today, a 429 from
`createForumTopic` can fail the update handler outright. After this change, it
should wait, retry, and either succeed or fail through the same centralized
delivery policy.

### Callback Answers

Callback-query handling in
[bridge.ts](/home/dev/kirbot/packages/kirbot-core/src/bridge.ts#L299) should
benefit from a dedicated fast lane. Users should never have callback answers
stuck behind a backlog of status edits or preview churn.

## Error Handling

### Scheduler-Level Failures

If a request fails with a non-429 Telegram error:

- return the failure to the caller
- do not poison the whole queue
- log the operation class and target metadata for debugging

### Operation Supersession

If a coalescible operation is replaced by a newer one before dispatch:

- resolve or reject the old waiter in a controlled way
- do not leave callers hanging on abandoned promises

The exact promise contract can be implementation-specific, but it must be
intentional and test-covered. The preferred contract is an explicit typed
"superseded" result rather than pretending the old operation was sent.

### Shutdown Behavior

On runtime shutdown:

- stop accepting new low-priority work
- allow in-flight callback answers and visible sends to finish when practical
- do not require durable persistence for pending work in this pass

## Testing

### Scheduler Unit Tests

Add focused coverage for:

- class-based priority ordering
- class-specific backoff after 429
- replacement of pending coalescible edits with the newest version
- deduplication and dropping of chat actions
- non-coalescing behavior for callback answers

### Messenger Tests

Update messenger coverage so it verifies:

- `createForumTopic` uses the same scheduling and 429 handling path as sends
- `answerCallbackQuery` is prioritized correctly
- `deleteMessage` remains best effort and low priority

### Turn Surface Tests

Update turn-surface tests to assert:

- multiple rapid status updates collapse to the latest scheduled edit
- final assistant publish supersedes queued intermediate status edits
- typing actions are skipped when they are no longer useful

### Bridge / Integration Tests

Add or update integration-style tests for:

- repeated queue preview churn collapsing to one final visible state
- topic creation surviving temporary Telegram 429s
- callback answers remaining immediate during edit backlog
- final answer delivery continuing under constrained Telegram budgets

## Rollout

### Phase 1

- introduce the scheduler behind `TelegramMessenger`
- route existing write methods through it
- keep conservative defaults hard-coded or lightly configurable

### Phase 2

- tune status and chat-action call sites to rely on coalescing instead of local
  cooldowns
- add logging/metrics that make it easy to see when work is being dropped,
  coalesced, delayed, or retried

### Verification Target

Success means Kirbot no longer shows the current production pattern of repeated
429s for status edits, visible sends, and topic creation during normal use in
the dedicated workspace supergroup.

## Open Questions

- What exact default budget should Kirbot use for visible sends and topic
  creates in the workspace group?
- Should status edits and queue preview edits share one edit lane or use
  separate budgets under the same class?
- Should superseded coalesced operations resolve as success-without-send or as a
  typed cancellation result?
