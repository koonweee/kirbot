# Telegram Inline Image Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish successful Codex-generated images into Telegram immediately as standalone photo messages, without captions, before turn finalization.

**Architecture:** Keep generated-image publication on the existing serialized `item/completed` path. Extend the Telegram transport with a transport-neutral photo-send API, add a small remote-image fetch/validation helper in the bridge, track per-turn handled `imageGeneration` item ids for idempotence, and append explicit structured activity-log entries when post-success image publication fails.

**Tech Stack:** TypeScript, Node.js `fetch`, Grammy bot adapter, Kirbot bridge/runtime, Vitest

---

## File Map

- `packages/kirbot-core/src/telegram-messenger.ts`
  Add outbound photo-send types and messenger scheduling support.
- `apps/bot/src/index.ts`
  Translate core photo-send requests into the corresponding `grammy` API call.
- `packages/kirbot-core/src/bridge/turn-context.ts`
  Add per-turn image-publication idempotence state.
- `packages/kirbot-core/src/bridge/generated-image-publication.ts`
  Own the shared generated-image success predicate plus remote-image URL
  validation, fetch, timeout, content-type, and size-limit checks.
- `packages/kirbot-core/src/bridge/turn-lifecycle.ts`
  Detect successful `imageGeneration` completions, publish images immediately,
  and append publication failures to the activity log.
- `packages/kirbot-core/src/bridge/presentation.ts`
  Add rendering helpers for image-publication failure activity-log entries.
- `packages/kirbot-core/src/turn-runtime.ts`
  Support appending the new structured activity-log entry shape if a dedicated
  helper keeps lifecycle code small.
- `packages/kirbot-core/tests/telegram-messenger.test.ts`
  Lock the new outbound photo transport contract in tests.
- `packages/kirbot-core/tests/turn-lifecycle.test.ts`
  Lock immediate image publication, failure logging, and idempotence behavior.
- `packages/kirbot-core/tests/bridge.test.ts`
  Update fake Telegram implementations and any bridge-level expectations touched
  by the new `TelegramApi` surface.
- `packages/kirbot-core/tests/telegram-turn-surface.test.ts`
  Update the fake Telegram implementation for the expanded transport interface.
- `apps/bot/tests/index.test.ts`
  Lock the bot adapter wiring for the new `sendPhoto` API path.

### Task 1: Lock the transport and lifecycle behavior in tests

**Files:**
- Modify: `packages/kirbot-core/tests/telegram-messenger.test.ts`
- Modify: `packages/kirbot-core/tests/turn-lifecycle.test.ts`
- Modify: `packages/kirbot-core/tests/bridge.test.ts`
- Modify: `apps/bot/tests/index.test.ts`

- [ ] **Step 1: Write the failing messenger transport test**
  Add a `TelegramMessenger.sendPhoto` test that expects a standalone photo send
  to include the right topic routing and muted notification behavior.

- [ ] **Step 2: Write the failing lifecycle success test**
  Add a `handleItemCompleted("imageGeneration")` test that expects a successful
  generated image to send a standalone Telegram photo immediately, before turn
  completion.

- [ ] **Step 3: Write the failing lifecycle failure/idempotence tests**
  Add one test for `invalid_url`, one test for download timeout/failure, one
  test for non-image validation rejection, one test for Telegram send failure,
  one test proving a duplicate/replayed `imageGeneration` item id only
  publishes once, and one test proving multiple generated images publish in
  arrival order without breaking later finalization.

- [ ] **Step 4: Write the failing bot adapter test**
  Extend the bot entrypoint tests to expect the new core-facing `sendPhoto`
  transport method to call the correct `grammy` API.

- [ ] **Step 5: Write the failing bridge-level ordering regression test**
  Add one `bridge.test.ts` case that exercises the serialized `item/completed`
  notification chain so immediate image publication still preserves turn event
  ordering, and one bridge-level regression that proves `turn/completed`
  finalization still publishes the final assistant text correctly after the
  earlier inline image send.

- [ ] **Step 6: Run the targeted tests to verify they fail**
  Run: `npm test -- packages/kirbot-core/tests/telegram-messenger.test.ts packages/kirbot-core/tests/turn-lifecycle.test.ts packages/kirbot-core/tests/bridge.test.ts apps/bot/tests/index.test.ts`
  Expected: FAIL because `sendPhoto` and immediate image-publication behavior do
  not exist yet.

### Task 2: Add outbound Telegram photo transport support

**Files:**
- Modify: `packages/kirbot-core/src/telegram-messenger.ts`
- Modify: `packages/kirbot-core/tests/telegram-messenger.test.ts`
- Modify: `apps/bot/src/index.ts`
- Modify: `apps/bot/tests/index.test.ts`
- Modify: `packages/kirbot-core/tests/bridge.test.ts`
- Modify: `packages/kirbot-core/tests/telegram-turn-surface.test.ts`
- Modify: `packages/kirbot-core/tests/turn-lifecycle.test.ts`

- [ ] **Step 1: Extend the core Telegram transport types**
  Add a transport-neutral photo-send input type to `TelegramApi` and
  `TelegramMessenger`, using raw bytes plus filename/mime-type hints and the
  existing topic/notification options.

- [ ] **Step 2: Schedule photo sends like other visible sends**
  Implement `TelegramMessenger.sendPhoto` so it uses the same delivery scheduler
  discipline as visible sends rather than bypassing the messenger.

- [ ] **Step 3: Wire the bot adapter to `grammy`**
  Translate the new core-facing photo-send call into the appropriate `bot.api`
  photo upload in `apps/bot/src/index.ts`.

- [ ] **Step 4: Update all fake Telegram implementations**
  Add the new `sendPhoto` method to test fakes so the expanded `TelegramApi`
  interface compiles cleanly across messenger, bridge, lifecycle, and turn
  surface tests.

- [ ] **Step 5: Re-run the transport-focused tests**
  Run: `npm test -- packages/kirbot-core/tests/telegram-messenger.test.ts apps/bot/tests/index.test.ts`
  Expected: PASS.

- [ ] **Step 6: Commit the transport slice**
  Run:
  ```bash
  git add packages/kirbot-core/src/telegram-messenger.ts packages/kirbot-core/tests/telegram-messenger.test.ts apps/bot/src/index.ts apps/bot/tests/index.test.ts packages/kirbot-core/tests/bridge.test.ts packages/kirbot-core/tests/telegram-turn-surface.test.ts packages/kirbot-core/tests/turn-lifecycle.test.ts
  git commit -m "feat: add telegram photo transport support"
  ```

### Task 3: Publish successful generated images immediately on item completion

**Files:**
- Create: `packages/kirbot-core/src/bridge/generated-image-publication.ts`
- Modify: `packages/kirbot-core/src/bridge/turn-context.ts`
- Modify: `packages/kirbot-core/src/bridge/turn-lifecycle.ts`
- Modify: `packages/kirbot-core/src/bridge/presentation.ts`
- Modify: `packages/kirbot-core/tests/turn-lifecycle.test.ts`
- Modify: `packages/kirbot-core/tests/bridge.test.ts`

- [ ] **Step 1: Extend active turn state for idempotence**
  Add a per-turn in-memory set that records handled `imageGeneration` item ids.

- [ ] **Step 2: Extract and share the success predicate**
  Move the current `imageGeneration` success rule out of presentation ownership
  into the new bridge helper so lifecycle and presentation use the same logic.

- [ ] **Step 3: Implement remote-image fetch and validation**
  In the new bridge helper, add URL validation plus bounded fetch, timeout,
  content-type, and size-limit checks that return upload-ready bytes.

- [ ] **Step 4: Add immediate image-publication handling**
  On successful `imageGeneration` completion, check idempotence, call the shared
  helper, then send the validated bytes via `messenger.sendPhoto` on the same
  chat/topic.

- [ ] **Step 5: Keep the existing serialized notification contract**
  Await publication inline on the `item/completed` path so no off-chain task or
  post-finalization bookkeeping is introduced in the first pass.

- [ ] **Step 6: Re-run the lifecycle and bridge success tests**
  Run: `npm test -- packages/kirbot-core/tests/turn-lifecycle.test.ts packages/kirbot-core/tests/bridge.test.ts`
  Expected: immediate publication, ordering, duplicate-suppression, and
  finalization-regression tests PASS.

- [ ] **Step 7: Commit the lifecycle success slice**
  Run:
  ```bash
  git add packages/kirbot-core/src/bridge/generated-image-publication.ts packages/kirbot-core/src/bridge/turn-context.ts packages/kirbot-core/src/bridge/turn-lifecycle.ts packages/kirbot-core/src/bridge/presentation.ts packages/kirbot-core/tests/turn-lifecycle.test.ts packages/kirbot-core/tests/bridge.test.ts
  git commit -m "feat: publish generated images immediately"
  ```

### Task 4: Add explicit publication-failure activity-log support

**Files:**
- Modify: `packages/kirbot-core/src/bridge/presentation.ts`
- Modify: `packages/kirbot-core/src/turn-runtime.ts`
- Modify: `packages/kirbot-core/src/bridge/turn-lifecycle.ts`
- Modify: `packages/kirbot-core/tests/turn-lifecycle.test.ts`

- [ ] **Step 1: Define the new publication-failure activity-log shape**
  Add a dedicated structured failure entry path for
  `invalid_url`/`download`/`validation`/`telegram_send` failures that happen
  after Codex already reported `imageGeneration` success.

- [ ] **Step 2: Append publication failures from lifecycle code**
  When immediate image publication fails, log the stage and append the new
  activity-log entry before returning control to the normal turn flow. Log with
  structured fields `{ turnId, itemId, url, stage }`.

- [ ] **Step 3: Render the new activity-log entry in commentary**
  Reuse the existing structured-failure rendering style so commentary shows a
  compact generated-image publication failure.

- [ ] **Step 4: Re-run the failure-path tests**
  Run: `npm test -- packages/kirbot-core/tests/turn-lifecycle.test.ts packages/kirbot-core/tests/bridge.test.ts`
  Expected: publication failure tests PASS and existing finalization behavior
  stays green.

- [ ] **Step 5: Commit the failure-path slice**
  Run:
  ```bash
  git add packages/kirbot-core/src/bridge/presentation.ts packages/kirbot-core/src/turn-runtime.ts packages/kirbot-core/src/bridge/turn-lifecycle.ts packages/kirbot-core/tests/turn-lifecycle.test.ts
  git commit -m "feat: log generated image publication failures"
  ```

### Task 5: Run the full targeted regression set

**Files:**
- No code changes expected

- [ ] **Step 1: Run the focused Kirbot test suite**
  Run: `npm test -- packages/kirbot-core/tests/telegram-messenger.test.ts packages/kirbot-core/tests/turn-lifecycle.test.ts packages/kirbot-core/tests/bridge.test.ts packages/kirbot-core/tests/telegram-turn-surface.test.ts apps/bot/tests/index.test.ts`
  Expected: PASS.

- [ ] **Step 2: Run the package build**
  Run: `npm run build`
  Expected: PASS.

- [ ] **Step 3: Inspect the final diff for scope drift**
  Run: `git diff --stat HEAD~3..HEAD`
  Expected: only the transport, lifecycle, activity-log, and related test files
  changed.
