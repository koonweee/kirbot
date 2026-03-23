# Status Bubble 10s Cap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap all Telegram status-bubble edits to at most once every 10 seconds while preserving existing coalescing and final assistant publish behavior.

**Architecture:** Implement the throttle in `telegram-turn-surface.ts`, which already owns status-bubble queuing, coalescing, and final-message supersession. This avoids broadening the scheduler's `visible_edit` policy, which would also slow unrelated queue-preview edits.

**Tech Stack:** TypeScript, Vitest, kirbot core turn surface

---

### Task 1: Lock the new status-bubble cadence in tests

**Files:**
- Modify: `packages/kirbot-core/tests/telegram-turn-surface.test.ts`

- [ ] **Step 1: Write failing tests**
  Add coverage that status-bubble updates remain coalesced but do not publish more often than every 10 seconds.

- [ ] **Step 2: Run the focused test**
  Run: `npm test -- packages/kirbot-core/tests/telegram-turn-surface.test.ts`
  Expected: FAIL because status edits still publish before 10 seconds.

### Task 2: Implement the throttle in the owning status surface

**Files:**
- Modify: `packages/kirbot-core/src/bridge/telegram-turn-surface.ts`

- [ ] **Step 1: Add a 10-second minimum interval for status-bubble visible activity**
  Reuse the existing latest-render coalescing behavior and only delay status-bubble sends/edits, not final assistant sends.

- [ ] **Step 2: Preserve current finalization behavior**
  Ensure queued status updates still yield to terminal/final assistant publication.

- [ ] **Step 3: Re-run the focused test**
  Run: `npm test -- packages/kirbot-core/tests/telegram-turn-surface.test.ts`
  Expected: PASS.

### Task 3: Verify the broader status flow

**Files:**
- Modify: `packages/kirbot-core/tests/turn-lifecycle.test.ts`

- [ ] **Step 1: Add or adjust lifecycle coverage only if needed**
  Keep the elapsed timer test aligned with the new 10-second surface cap if any assertion currently depends on more frequent visible updates.

- [ ] **Step 2: Run related tests**
  Run: `npm test -- packages/kirbot-core/tests/telegram-turn-surface.test.ts packages/kirbot-core/tests/turn-lifecycle.test.ts packages/kirbot-core/tests/bridge.test.ts`
  Expected: PASS.
