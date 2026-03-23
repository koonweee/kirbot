# Supergroup Artifact URL Buttons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Kirbot artifact links usable in supergroup chats by replacing unsupported Telegram `web_app` inline buttons with supported inline `url` buttons.

**Architecture:** Restrict the change to the Telegram artifact presentation path. Artifact encoding and finalization stay the same; only the inline button payload changes from `web_app` to `url`, so final assistant messages and plan/commentary stubs remain one-tap links in supergroups.

**Tech Stack:** TypeScript, Vitest, Telegram harness, kirbot core presentation/finalization helpers

---

### Task 1: Lock the new button contract in tests

**Files:**
- Modify: `packages/kirbot-core/tests/presentation.test.ts`
- Modify: `packages/kirbot-core/tests/turn-lifecycle.test.ts`
- Modify: `packages/kirbot-core/tests/bridge.test.ts`
- Modify: `packages/telegram-harness/tests/harness.test.ts`

- [ ] **Step 1: Write the failing tests**
  Update artifact-button expectations to look for inline `url` buttons instead of `web_app` buttons while keeping the encoded Mini App fragment assertions.

- [ ] **Step 2: Run tests to verify they fail**
  Run: `npm test -- packages/kirbot-core/tests/presentation.test.ts packages/kirbot-core/tests/turn-lifecycle.test.ts packages/kirbot-core/tests/bridge.test.ts packages/telegram-harness/tests/harness.test.ts`
  Expected: FAIL where tests still expect `web_app`.

### Task 2: Implement the minimal button payload change

**Files:**
- Modify: `packages/kirbot-core/src/telegram-messenger.ts`
- Modify: `packages/kirbot-core/src/bridge/presentation.ts`

- [ ] **Step 1: Update inline keyboard button typing**
  Extend the shared Telegram inline button union to represent `url` buttons.

- [ ] **Step 2: Swap artifact buttons to URL buttons**
  Keep artifact URL generation as-is, but emit `{ text, url }` for plan/response/commentary artifact buttons.

- [ ] **Step 3: Re-run the targeted tests**
  Run: `npm test -- packages/kirbot-core/tests/presentation.test.ts packages/kirbot-core/tests/turn-lifecycle.test.ts packages/kirbot-core/tests/bridge.test.ts packages/telegram-harness/tests/harness.test.ts`
  Expected: PASS.

### Task 3: Verify the production symptom is gone

**Files:**
- No code changes expected

- [ ] **Step 1: Build the bot**
  Run: `npm run build`

- [ ] **Step 2: Restart the detached production session**
  Run: `npm run start:tmux:restart`

- [ ] **Step 3: Inspect fresh tmux logs**
  Run: `tmux capture-pane -p -t kirbot-prod:0.0 -S -120`
  Expected: startup completes without new `BUTTON_TYPE_INVALID` errors when artifact messages are sent.
