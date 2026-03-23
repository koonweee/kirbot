# Kirbot Telegram Compliance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a centralized Telegram delivery scheduler that keeps Kirbot compliant with practical group limits in its single workspace forum supergroup while preserving retries, logging, and responsive high-priority interactions.

**Architecture:** Introduce a `TelegramDeliveryScheduler` behind `TelegramMessenger` so outbound Telegram writes are classified, budgeted, coalesced, and retried centrally. Migrate bridge and request-coordinator write paths onto `TelegramMessenger`, then mark status, queue-preview, and chat-action traffic with explicit coalescing keys and lower-priority delivery classes.

**Tech Stack:** TypeScript, Vitest, Telegram Bot API adapter layer, existing kirbot bridge/runtime architecture

---

## File Structure

- Create: `packages/kirbot-core/src/telegram-delivery-scheduler.ts`
  Owns delivery classes, per-class queues, coalescing keys, retry-after pauses, and dispatch ordering.
- Modify: `packages/kirbot-core/src/telegram-messenger.ts`
  Becomes the single write façade for Telegram operations and the owner of scheduler integration.
- Modify: `packages/kirbot-core/src/bridge.ts`
  Stop using raw `telegram.*` writes for callbacks, topic creation, queue preview edits/deletes, compaction edits, and unsupported-chat redirect sends.
- Modify: `packages/kirbot-core/src/bridge/request-coordinator.ts`
  Stop using raw `telegram.*` writes for callback answers and prompt/summary message edits.
- Modify: `packages/kirbot-core/src/bridge/telegram-turn-surface.ts`
  Replace local pacing assumptions with scheduler hints for status edits and chat actions.
- Modify: `packages/kirbot-core/src/bridge/turn-lifecycle.ts`
  Keep status refresh generation compatible with the new scheduler-backed visible status flow.
- Test: `packages/kirbot-core/tests/telegram-delivery-scheduler.test.ts`
  Covers queueing, priority ordering, coalescing, and 429 pause behavior.
- Test: `packages/kirbot-core/tests/telegram-messenger.test.ts`
  Covers scheduled message/topic/callback/delete behavior and preserves existing request shaping expectations.
- Test: `packages/kirbot-core/tests/telegram-turn-surface.test.ts`
  Covers status supersession, chat-action suppression, and final-message precedence.
- Test: `packages/kirbot-core/tests/bridge.test.ts`
  Covers bridge/request-coordinator behavior after migrating raw Telegram writes.
- Test: `packages/telegram-harness/tests/harness.test.ts`
  Covers end-to-end transcript behavior under the new scheduler-backed delivery flow.

### Task 1: Build the delivery scheduler core with explicit classes, coalescing, and 429 pause behavior

**Files:**
- Create: `packages/kirbot-core/src/telegram-delivery-scheduler.ts`
- Create: `packages/kirbot-core/tests/telegram-delivery-scheduler.test.ts`

- [ ] **Step 1: Write the failing scheduler tests**

Add `packages/kirbot-core/tests/telegram-delivery-scheduler.test.ts` covering:
- `callback_answer` dispatches ahead of queued `visible_edit` work
- a 429 with `retry_after` pauses only the affected delivery class
- replaceable operations with the same coalescing key keep only the newest pending operation
- `chat_action` operations deduplicate by `(chatId, topicId, action)`
- non-coalescible operations such as `visible_send` and `topic_create` preserve FIFO ordering
- superseded replaceable operations resolve to an explicit typed result instead of hanging forever

- [ ] **Step 2: Run the new scheduler test file to verify it fails**

Run: `npm test -- packages/kirbot-core/tests/telegram-delivery-scheduler.test.ts -v`
Expected: FAIL because the scheduler module and its types do not exist yet

- [ ] **Step 3: Implement the scheduler module**

Create `packages/kirbot-core/src/telegram-delivery-scheduler.ts` with:
- a `TelegramDeliveryClass` union containing:
  - `"callback_answer"`
  - `"visible_send"`
  - `"topic_create"`
  - `"visible_edit"`
  - `"delete"`
  - `"chat_action"`
- a `TelegramDeliveryPolicy` value/object that exposes conservative defaults for:
  - visible send/topic-create spacing or window budget
  - visible edit spacing
  - chat-action spacing
  - per-class backoff after 429
- a typed enqueue API such as `enqueue<T>(operation): Promise<T | TelegramDeliverySupersededResult>`
- replaceable-operation support via explicit coalescing keys
- per-class pending queues plus per-class pause-until timestamps derived from `retry_after`
- logging hooks for:
  - queued operations
  - coalesced/superseded operations
  - class pause/resume after 429
  - final non-429 failures

Implementation constraints:
- keep the scheduler in-memory only
- keep dispatch single-process and deterministic
- do not embed bridge-specific concepts in the scheduler API
- prefer one generic scheduler over multiple small throttlers

- [ ] **Step 4: Run the scheduler tests to verify they pass**

Run: `npm test -- packages/kirbot-core/tests/telegram-delivery-scheduler.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/kirbot-core/src/telegram-delivery-scheduler.ts \
  packages/kirbot-core/tests/telegram-delivery-scheduler.test.ts
git commit -m "feat: add telegram delivery scheduler"
```

### Task 2: Integrate the scheduler into TelegramMessenger and route all relevant outbound writes through it

**Files:**
- Modify: `packages/kirbot-core/src/telegram-messenger.ts`
- Modify: `packages/kirbot-core/src/bridge.ts`
- Modify: `packages/kirbot-core/src/bridge/request-coordinator.ts`
- Test: `packages/kirbot-core/tests/telegram-messenger.test.ts`
- Test: `packages/kirbot-core/tests/bridge.test.ts`

- [ ] **Step 1: Write the failing messenger and bridge tests**

Extend `packages/kirbot-core/tests/telegram-messenger.test.ts` to cover:
- `createForumTopic` going through the same scheduler/retry path as `sendMessage`
- `answerCallbackQuery` using a callback-priority delivery class
- `deleteMessage` remaining best effort and low priority
- messenger-level logging when a scheduled operation is retried after 429

Extend `packages/kirbot-core/tests/bridge.test.ts` to cover:
- callback-query handling still answers promptly when other lower-priority Telegram work is queued
- topic creation survives a temporary 429 instead of failing the whole update path
- bridge/request-coordinator paths no longer depend on raw `telegram.editMessageText` or `telegram.answerCallbackQuery` behavior for compliance-sensitive writes

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `npm test -- packages/kirbot-core/tests/telegram-messenger.test.ts packages/kirbot-core/tests/bridge.test.ts -v`
Expected: FAIL because the messenger does not yet expose scheduled `createForumTopic`, and bridge/request-coordinator still bypass the messenger for many outbound writes

- [ ] **Step 3: Implement messenger scheduling and migrate raw write paths**

Update `packages/kirbot-core/src/telegram-messenger.ts` to:
- create and own a `TelegramDeliveryScheduler`
- keep `retry_after` parsing available to the scheduler
- add a scheduled `createForumTopic(...)` method
- route `sendMessage`, `editMessageText`, `sendChatAction`, `deleteMessage`, and `answerCallbackQuery` through scheduler enqueue calls
- support optional delivery hints on edits/chat actions, for example:
  - `deliveryClass`
  - `coalesceKey`
  - `replacePending`

Update `packages/kirbot-core/src/bridge.ts` to replace raw outbound write calls with messenger-backed calls for:
- callback answers
- unsupported-chat redirect messages
- topic creation
- queue preview deletes/edits
- compaction-status edits

Update `packages/kirbot-core/src/bridge/request-coordinator.ts` to replace raw outbound write calls with messenger-backed calls for:
- callback answers
- prompt edits
- approval summary edits
- follow-up request prompt refreshes

Migration rule:
- read-only Telegram calls such as `downloadFile` and `getForumTopicIconStickers` stay on the raw Telegram API
- all outbound write operations that consume group rate budget go through `TelegramMessenger`

- [ ] **Step 4: Run the targeted tests to verify they pass**

Run: `npm test -- packages/kirbot-core/tests/telegram-messenger.test.ts packages/kirbot-core/tests/bridge.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/kirbot-core/src/telegram-messenger.ts \
  packages/kirbot-core/src/bridge.ts \
  packages/kirbot-core/src/bridge/request-coordinator.ts \
  packages/kirbot-core/tests/telegram-messenger.test.ts \
  packages/kirbot-core/tests/bridge.test.ts
git commit -m "refactor: route telegram writes through messenger scheduler"
```

### Task 3: Mark low-value traffic for coalescing and remove local pacing assumptions from status/preview flows

**Files:**
- Modify: `packages/kirbot-core/src/bridge/telegram-turn-surface.ts`
- Modify: `packages/kirbot-core/src/bridge/turn-lifecycle.ts`
- Modify: `packages/kirbot-core/src/bridge.ts`
- Test: `packages/kirbot-core/tests/telegram-turn-surface.test.ts`
- Test: `packages/kirbot-core/tests/bridge.test.ts`

- [ ] **Step 1: Write the failing status/preview-flow tests**

Extend `packages/kirbot-core/tests/telegram-turn-surface.test.ts` to cover:
- multiple rapid status updates for one status message collapse to the latest pending edit
- final assistant publish supersedes queued intermediate status edits
- `sendChatAction` is skipped when a visible status message already exists
- chat actions are not emitted repeatedly when only low-value churn is happening

Extend `packages/kirbot-core/tests/bridge.test.ts` to cover:
- repeated queue-preview churn collapses to the latest visible preview text for the same preview message
- queue-preview cleanup deletes remain best effort without blocking final visible sends

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `npm test -- packages/kirbot-core/tests/telegram-turn-surface.test.ts packages/kirbot-core/tests/bridge.test.ts -v`
Expected: FAIL because the turn surface still relies on local 500 ms edit cooldown and 3 s chat-action gating instead of scheduler hints and explicit coalescing keys

- [ ] **Step 3: Implement coalescing-aware status and preview behavior**

Update `packages/kirbot-core/src/bridge/telegram-turn-surface.ts` to:
- stop using the current 500 ms local edit cooldown as the main compliance mechanism
- call `messenger.editMessageText(...)` with a status-specific coalescing key based on `(chatId, messageId)`
- call `messenger.sendChatAction(...)` with a chat-action coalescing key based on `(chatId, topicId, action)`
- skip typing actions when a visible status bubble already exists or when a recent visible send/edit makes the chat action redundant
- prefer dropping stale status work over preserving every intermediate render

Update `packages/kirbot-core/src/bridge.ts` queue-preview handling to:
- assign queue-preview edit coalescing keys based on `(chatId, messageId)`
- keep only the latest preview body pending for the preview message

Update `packages/kirbot-core/src/bridge/turn-lifecycle.ts` only as needed to keep periodic status refresh generation compatible with the new scheduler-backed visible status flow; do not add a second pacing layer here.

- [ ] **Step 4: Run the targeted tests to verify they pass**

Run: `npm test -- packages/kirbot-core/tests/telegram-turn-surface.test.ts packages/kirbot-core/tests/bridge.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/kirbot-core/src/bridge/telegram-turn-surface.ts \
  packages/kirbot-core/src/bridge/turn-lifecycle.ts \
  packages/kirbot-core/src/bridge.ts \
  packages/kirbot-core/tests/telegram-turn-surface.test.ts \
  packages/kirbot-core/tests/bridge.test.ts
git commit -m "feat: coalesce low-value telegram status traffic"
```

### Task 4: Verify transcript-level behavior, preserve observability, and run full validation

**Files:**
- Modify: `packages/telegram-harness/tests/harness.test.ts`
- Modify: `packages/kirbot-core/tests/telegram-messenger.test.ts`
- Test: `packages/kirbot-core/tests/telegram-delivery-scheduler.test.ts`
- Test: `packages/kirbot-core/tests/telegram-turn-surface.test.ts`
- Test: `packages/kirbot-core/tests/bridge.test.ts`
- Test: `packages/telegram-harness/tests/harness.test.ts`

- [ ] **Step 1: Write the failing transcript and observability checks**

Update `packages/telegram-harness/tests/harness.test.ts` to assert:
- final assistant content still arrives correctly when visible edits are being coalesced
- callback answers still appear immediately during scheduler backlog
- topic creation and visible completion flows survive temporary 429 responses

If necessary, extend `packages/kirbot-core/tests/telegram-messenger.test.ts` to assert log messages or captured logger calls for:
- scheduled retry after 429
- coalesced/superseded low-value operations
- non-429 terminal failures

- [ ] **Step 2: Run the affected tests to verify they fail**

Run: `npm test -- packages/telegram-harness/tests/harness.test.ts packages/kirbot-core/tests/telegram-messenger.test.ts -v`
Expected: FAIL because the harness and logger expectations do not yet reflect the scheduler-backed delivery flow

- [ ] **Step 3: Implement the minimal compatibility and logging updates**

Adjust the harness-facing fake/recording behavior and logger expectations so they reflect:
- centralized scheduling
- retries that remain visible in logs
- coalescing/dropping of low-value operations without breaking final-visible behavior

Keep observability focused and structured:
- log operation class
- log target identifiers that are safe to log (`chatId`, `messageId`, `topicId`, callback id only if already treated as non-secret in current logs)
- log retry-after duration and whether an operation was retried, delayed, or superseded

- [ ] **Step 4: Run full verification**

Run:
- `npm test -- packages/kirbot-core/tests/telegram-delivery-scheduler.test.ts -v`
- `npm test -- packages/kirbot-core/tests/telegram-messenger.test.ts packages/kirbot-core/tests/telegram-turn-surface.test.ts packages/kirbot-core/tests/bridge.test.ts -v`
- `npm test -- packages/telegram-harness/tests/harness.test.ts -v`
- `npm run typecheck`

Expected:
- all targeted tests PASS
- typecheck PASS

- [ ] **Step 5: Commit**

```bash
git add packages/telegram-harness/tests/harness.test.ts \
  packages/kirbot-core/tests/telegram-messenger.test.ts
git commit -m "test: verify telegram scheduler compliance flow"
```
