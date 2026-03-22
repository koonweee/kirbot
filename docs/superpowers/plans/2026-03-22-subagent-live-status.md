# Subagent Live Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a live subagent snapshot block inside Kirbot's existing in-progress Telegram status bubble.

**Architecture:** Extend turn-local bridge state with a presentation-oriented subagent snapshot, update it from `collabAgentToolCall` lifecycle events, and render it through the existing status-bubble surface. Keep final commentary and finalization behavior unchanged.

**Tech Stack:** TypeScript, Vitest, Kirbot bridge/runtime, Telegram Bot API adapter

---

### Task 1: Add failing presentation tests for subagent status rendering

**Files:**
- Modify: `packages/kirbot-core/tests/presentation.test.ts`
- Modify: `packages/kirbot-core/src/bridge/presentation.ts`

- [ ] **Step 1: Write failing tests for status rendering**

Add tests covering:
- plain status renders unchanged without a subagent snapshot
- status plus one subagent snapshot renders header and agent lines
- more than 3 agents renders an overflow line
- failure lines include a brief detail

- [ ] **Step 2: Run the presentation tests to verify they fail**

Run: `npm test -- packages/kirbot-core/tests/presentation.test.ts -v`
Expected: FAIL because status rendering does not yet support subagent snapshots

- [ ] **Step 3: Implement minimal presentation support**

Add:
- `LiveSubagentSnapshot` type
- helpers to render the snapshot block
- support in `TurnStatusDraft` / `renderTelegramStatusDraft(...)`

- [ ] **Step 4: Run the presentation tests to verify they pass**

Run: `npm test -- packages/kirbot-core/tests/presentation.test.ts -v`
Expected: PASS

### Task 2: Add failing lifecycle tests for collab snapshot updates

**Files:**
- Modify: `packages/kirbot-core/tests/turn-lifecycle.test.ts`
- Modify: `packages/kirbot-core/src/bridge/turn-context.ts`
- Modify: `packages/kirbot-core/src/bridge/turn-lifecycle.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Add tests covering:
- `spawnAgent` updates the live bubble to `spawning agent` with fallback agent labels
- `wait` in progress renders `waiting for N agents`
- completed/failed collab items refresh the snapshot from `agentsStates`
- the snapshot clears when collab work is no longer active
- no redundant Telegram edit occurs when visible status text does not change

- [ ] **Step 2: Run the lifecycle tests to verify they fail**

Run: `npm test -- packages/kirbot-core/tests/turn-lifecycle.test.ts -v`
Expected: FAIL because lifecycle does not yet maintain a subagent snapshot

- [ ] **Step 3: Implement minimal lifecycle support**

Add turn-local snapshot state and update it from `collabAgentToolCall` start/completion events. Keep using the existing visible status bubble and keep activity-log/commentary behavior unchanged.

- [ ] **Step 4: Run the lifecycle tests to verify they pass**

Run: `npm test -- packages/kirbot-core/tests/turn-lifecycle.test.ts -v`
Expected: PASS

### Task 3: Run targeted verification and typecheck

**Files:**
- Test: `packages/kirbot-core/tests/presentation.test.ts`
- Test: `packages/kirbot-core/tests/turn-lifecycle.test.ts`

- [ ] **Step 1: Run targeted tests**

Run: `npm test -- packages/kirbot-core/tests/presentation.test.ts packages/kirbot-core/tests/turn-lifecycle.test.ts -v`
Expected: PASS

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/kirbot-core/src/bridge/presentation.ts \
  packages/kirbot-core/src/bridge/turn-context.ts \
  packages/kirbot-core/src/bridge/turn-lifecycle.ts \
  packages/kirbot-core/tests/presentation.test.ts \
  packages/kirbot-core/tests/turn-lifecycle.test.ts \
  docs/superpowers/plans/2026-03-22-subagent-live-status.md
git commit -m "feat: show live subagent status in telegram bubble"
```
