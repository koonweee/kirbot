# Restart Command And Keyboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show all visible built-in slash commands in the `/commands` keyboard and make root `/restart` run a reported, deterministic deployment pipeline.

**Architecture:** The bridge remains the owner of Telegram-visible behavior, while the bot runtime owns the actual shell command execution for restarts. The keyboard change stays in the existing slash-command and presentation path, and the restart change expands the injected restart hook so the bridge can announce each step without owning process execution details.

**Tech Stack:** TypeScript, Vitest, Grammy-compatible Telegram message entities, Node child-process spawning

---

### Task 1: Document The Approved Behavior

**Files:**
- Create: `docs/superpowers/specs/2026-03-21-restart-command-and-keyboard-design.md`
- Create: `docs/superpowers/plans/2026-03-21-restart-command-and-keyboard.md`

- [ ] **Step 1: Write the approved spec**

Capture the global keyboard behavior, root-only `/restart` scope, exact shell-step order, and failure/success rules.

- [ ] **Step 2: Save the implementation plan**

Describe the file ownership, TDD sequence, and verification commands for the implementation.

### Task 2: Write The Failing Keyboard Tests

**Files:**
- Modify: `packages/kirbot-core/tests/bridge.test.ts`
- Modify: `packages/kirbot-core/tests/presentation.test.ts`

- [ ] **Step 1: Update the `/commands` bridge expectation**

Expect the reply keyboard to include all visible built-in commands in definition order:

```ts
[
  ["/stop", "/plan"],
  ["/thread", "/restart"],
  ["/implement", "/cmd"],
  ["/model", "/fast"],
  ["/compact", "/clear"],
  ["/permissions", "/commands"],
  ["/standup"]
]
```

- [ ] **Step 2: Update the presentation expectation**

Add the same built-in order ahead of appended custom commands in `presentation.test.ts`.

- [ ] **Step 3: Run the narrow keyboard tests and confirm failure**

Run: `npm test -- packages/kirbot-core/tests/presentation.test.ts packages/kirbot-core/tests/bridge.test.ts`

Expected: FAIL because the implementation still filters to topic-scoped built-ins.

### Task 3: Write The Failing Restart Tests

**Files:**
- Modify: `packages/kirbot-core/tests/bridge.test.ts`
- Create: `apps/bot/src/restart-kirbot.test.ts`

- [ ] **Step 1: Update the bridge `/restart` success test**

Make the mocked restart hook accept a step callback and call it with the five required commands. Assert Telegram receives one `Running:` message per step plus a final success message.

- [ ] **Step 2: Update the bridge `/restart` failure test**

Make the mocked restart hook reject after reporting the failing step. Assert kirbot stops after the failure and sends the failure text.

- [ ] **Step 3: Add bot-side restart executor tests**

Mock `node:child_process` and assert:
- commands run in the exact required order
- every command uses the repo root as `cwd`
- a failure aborts the remaining commands
- error text preserves the failing command and output tail

- [ ] **Step 4: Run the restart tests and confirm failure**

Run: `npm test -- packages/kirbot-core/tests/bridge.test.ts apps/bot/src/restart-kirbot.test.ts`

Expected: FAIL because the current restart hook has no step callback and only runs two npm scripts.

### Task 4: Implement The Keyboard Change

**Files:**
- Modify: `packages/kirbot-core/src/bridge.ts`
- Modify: `packages/kirbot-core/src/bridge/slash-commands.ts`

- [ ] **Step 1: Switch the keyboard source to all visible built-in commands**

Use `getVisibleSlashCommands()` instead of the topic-only helper when building the `/commands` reply keyboard.

- [ ] **Step 2: Keep scope validation unchanged**

Do not alter command parsing or scope checks; the keyboard becomes broader, but routing rules stay as they are.

- [ ] **Step 3: Run the keyboard tests and confirm they pass**

Run: `npm test -- packages/kirbot-core/tests/presentation.test.ts packages/kirbot-core/tests/bridge.test.ts`

Expected: PASS for the keyboard expectations.

### Task 5: Implement The Restart Pipeline

**Files:**
- Modify: `packages/kirbot-core/src/bridge.ts`
- Modify: `packages/kirbot-core/src/runtime.ts`
- Modify: `apps/bot/src/index.ts`
- Modify: `apps/bot/src/restart-kirbot.ts`
- Create: `apps/bot/src/restart-kirbot.test.ts`

- [ ] **Step 1: Expand the restart hook signature**

Change the injected restart hook type from `() => Promise<void>` to `(reportStep: (command: string) => Promise<void>) => Promise<void>`.

- [ ] **Step 2: Add bridge step-report messaging**

Before each reported step, send `Running: <code>command</code>` using Telegram entities instead of raw HTML.

- [ ] **Step 3: Replace the bot restart helper with an explicit command runner**

Run these exact commands in order from the repo root:

```text
git checkout master
git fetch origin
git reset --hard origin/master
npm run build
npm run start:tmux:restart
```

- [ ] **Step 4: Stop on first failure and preserve error details**

If any step exits non-zero or terminates by signal, throw an error that includes the exact command and the captured output tail.

- [ ] **Step 5: Send the final success message**

After the restart hook resolves, send a concise completion message from the bridge.

- [ ] **Step 6: Run the restart-focused tests and confirm they pass**

Run: `npm test -- packages/kirbot-core/tests/bridge.test.ts apps/bot/src/restart-kirbot.test.ts`

Expected: PASS

### Task 6: Final Verification

**Files:**
- Modify: `docs/user-flows.md`

- [ ] **Step 1: Update the owning user-flow doc**

Document that `/commands` now shows the full visible slash-command set and that root `/restart` reports each deployment step before execution.

- [ ] **Step 2: Run the full affected suite**

Run:

```bash
npm test -- packages/kirbot-core/tests/presentation.test.ts packages/kirbot-core/tests/bridge.test.ts apps/bot/src/restart-kirbot.test.ts
```

Expected: PASS

- [ ] **Step 3: Build the repo**

Run: `npm run build`

Expected: PASS
