# Status Bubble Final Message Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Telegram status updates live in their own editable bubble, stop visibly streaming assistant output, and send one final assistant bubble before deleting the status bubble, while keeping the current edit-streaming path available internally.

**Architecture:** Introduce an explicit Telegram turn-surface abstraction with two implementations: the current edit-streaming surface and a new status-then-final-message surface. `TurnLifecycleCoordinator` and `TurnFinalizer` will delegate visible-message behavior to the selected surface, while `BridgeTurnRuntime` remains the source of truth for assistant text, artifacts, and final snapshots.

**Tech Stack:** TypeScript, Vitest, Telegram Bot API adapter layer, existing kirbot bridge/runtime architecture

---

### Task 1: Define the turn-surface abstraction and cover it with focused tests

**Files:**
- Create: `packages/kirbot-core/src/bridge/telegram-turn-surface.ts`
- Create: `packages/kirbot-core/tests/telegram-turn-surface.test.ts`
- Modify: `packages/kirbot-core/src/bridge/telegram-streaming.ts`
- Modify: `packages/kirbot-core/src/bridge/turn-context.ts`
- Modify: `packages/kirbot-core/src/bridge/turn-finalization.ts`

- [ ] **Step 1: Write the failing surface tests**

Add `packages/kirbot-core/tests/telegram-turn-surface.test.ts` covering:
- first status update sends one status message
- subsequent status updates edit the same status message
- assistant render updates are ignored by the new default surface
- successful final assistant publish sends a new assistant message and then deletes the status message
- completed-without-publishable-assistant-output keeps and edits the status message instead of deleting it
- interrupted/failed terminal publish edits and keeps the status message
- final assistant send failure preserves the status message
- final assistant send success plus status delete failure still keeps the assistant message and treats delete as best-effort

- [ ] **Step 2: Run the new test file to verify it fails**

Run: `npm test -- packages/kirbot-core/tests/telegram-turn-surface.test.ts -v`
Expected: FAIL because the surface abstraction and new default implementation do not exist yet

- [ ] **Step 3: Implement the abstraction and the two surface implementations**

Create `packages/kirbot-core/src/bridge/telegram-turn-surface.ts` with:
- `TelegramTurnSurface` interface
- a factory/helper for selecting the surface mode through one deterministic internal selector
- a small internal mode type such as `TelegramTurnSurfaceMode = "status_then_final_message" | "edit_streaming"`
- a single dependency-injected selector input on the lifecycle/finalizer boundary, so production uses the default mode while tests and harness code can opt into `edit_streaming` through the same constructor path
- `StatusThenFinalMessageTurnSurface` as the default implementation

Refactor `packages/kirbot-core/src/bridge/telegram-streaming.ts` so the existing behavior is preserved as the alternate edit-streaming implementation behind the new interface.

Update `packages/kirbot-core/src/bridge/turn-context.ts` so turn context depends on the interface rather than a concrete stream-only class.

Thread the selector through the bridge coordinator dependencies, not through ad hoc conditionals in tests.

- [ ] **Step 4: Run the new surface tests to verify they pass**

Run: `npm test -- packages/kirbot-core/tests/telegram-turn-surface.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/kirbot-core/src/bridge/telegram-turn-surface.ts \
  packages/kirbot-core/src/bridge/telegram-streaming.ts \
  packages/kirbot-core/src/bridge/turn-context.ts \
  packages/kirbot-core/src/bridge/turn-finalization.ts \
  packages/kirbot-core/tests/telegram-turn-surface.test.ts
git commit -m "refactor: add telegram turn surface abstraction"
```

### Task 2: Wire lifecycle and finalization to the new default surface

**Files:**
- Modify: `packages/kirbot-core/src/bridge/turn-lifecycle.ts`
- Modify: `packages/kirbot-core/src/bridge/turn-finalization.ts`
- Modify: `packages/kirbot-core/src/bridge/presentation.ts`
- Test: `packages/kirbot-core/tests/turn-lifecycle.test.ts`
- Test: `packages/kirbot-core/tests/bridge.test.ts`

- [ ] **Step 1: Write failing lifecycle/finalization tests**

Extend `packages/kirbot-core/tests/turn-lifecycle.test.ts` and `packages/kirbot-core/tests/bridge.test.ts` to assert:
- status remains its own bubble in the new default path
- assistant deltas still accumulate in runtime but do not visibly stream
- completion sends a final assistant message with reply markup and then deletes the status message
- failure/interruption keeps the status message and does not send a separate completion ping

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `npm test -- packages/kirbot-core/tests/turn-lifecycle.test.ts packages/kirbot-core/tests/bridge.test.ts -v`
Expected: FAIL because lifecycle/finalization still assume the one-message edit-streaming path

- [ ] **Step 3: Implement the lifecycle/finalization wiring**

Update `packages/kirbot-core/src/bridge/turn-lifecycle.ts` to:
- create the default status-then-final surface in `activateTurn()`
- keep assistant runtime accumulation unchanged
- stop switching visible rendering into assistant mode in the new default path
- route alternate-mode selection through the dependency-injected selector used by production, tests, and harness code so the fallback path remains intentionally executable

Update `packages/kirbot-core/src/bridge/turn-finalization.ts` to:
- delegate final assistant publication and terminal status handling to the surface
- remove the separate `> done` notification from the new default path
- keep artifact reply-markup resolution attached to the final assistant message

Update `packages/kirbot-core/src/bridge/presentation.ts` only if helper behavior needs a small adjustment to support the new visible flow; do not add new user-facing features beyond the approved design.

- [ ] **Step 4: Run the targeted tests to verify they pass**

Run: `npm test -- packages/kirbot-core/tests/turn-lifecycle.test.ts packages/kirbot-core/tests/bridge.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/kirbot-core/src/bridge/turn-lifecycle.ts \
  packages/kirbot-core/src/bridge/turn-finalization.ts \
  packages/kirbot-core/src/bridge/presentation.ts \
  packages/kirbot-core/tests/turn-lifecycle.test.ts \
  packages/kirbot-core/tests/bridge.test.ts
git commit -m "feat: send final telegram message after status bubble"
```

### Task 3: Update harness expectations and run full verification

**Files:**
- Modify: `packages/telegram-harness/tests/harness.test.ts`
- Modify: `packages/kirbot-core/tests/telegram-messenger.test.ts`
- Test: `packages/kirbot-core/tests/telegram-turn-surface.test.ts`
- Test: `packages/kirbot-core/tests/turn-lifecycle.test.ts`
- Test: `packages/kirbot-core/tests/bridge.test.ts`
- Test: `packages/telegram-harness/tests/harness.test.ts`

- [ ] **Step 1: Write the failing harness expectation updates**

Update `packages/telegram-harness/tests/harness.test.ts` to expect the new default transcript shape:
- status message sent
- status message edited over time
- final assistant message sent
- status message deleted
- footer sent

If `packages/kirbot-core/tests/telegram-messenger.test.ts` needs coverage for delete-order or final-send behavior, add a focused assertion there.

Keep one deterministic test path that explicitly selects the alternate `EditStreamingTurnSurface` and verifies the previous edit-streaming behavior still works.

- [ ] **Step 2: Run the affected integration tests to verify they fail**

Run: `npm test -- packages/telegram-harness/tests/harness.test.ts packages/kirbot-core/tests/telegram-messenger.test.ts -v`
Expected: FAIL because the harness still reflects the previous edit-streaming default

- [ ] **Step 3: Implement the minimal compatibility changes**

Adjust the harness-facing expectations and any supporting fake behavior so the tests match the new default surface while preserving one alternate-path test for edit-streaming mode where practical.

- [ ] **Step 4: Run full verification**

Run:
- `npm test -- packages/kirbot-core/tests/telegram-turn-surface.test.ts -v`
- `npm test -- packages/kirbot-core/tests/turn-lifecycle.test.ts packages/kirbot-core/tests/bridge.test.ts -v`
- `npm test -- packages/telegram-harness/tests/harness.test.ts packages/kirbot-core/tests/telegram-messenger.test.ts -v`
- `npm run typecheck`

Expected:
- all targeted tests PASS
- typecheck PASS

- [ ] **Step 5: Commit**

```bash
git add packages/telegram-harness/tests/harness.test.ts \
  packages/kirbot-core/tests/telegram-messenger.test.ts
git commit -m "test: update telegram harness for status bubble flow"
```
