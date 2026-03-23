# Turn-Starter Mention Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mention the Telegram user who started a specific turn or request by prefixing `@username` on the single primary notification-bearing message for that turn/request, and omit the mention entirely when no username exists.

**Architecture:** Thread the optional Telegram username from bot ingress into `UserTurnMessage`, active turn state, and queued follow-up state. Add a small bridge-level helper that prefixes `@username ` onto `{ text, entities }` payloads while shifting existing Telegram entity offsets. Apply that helper only on the semantically-primary notifying message for turn finalization and on the initial approval / permissions / user-input prompts.

**Tech Stack:** TypeScript, grammy Telegram types, `@kirbot/telegram-format`, Vitest

---

### Task 1: Thread Telegram usernames through ingress and turn ownership state

**Files:**
- Modify: `apps/bot/src/index.ts`
- Modify: `apps/bot/tests/index.test.ts`
- Modify: `packages/kirbot-core/src/domain.ts`
- Modify: `packages/kirbot-core/src/bridge/turn-context.ts`
- Modify: `packages/kirbot-core/src/bridge/turn-lifecycle.ts`
- Modify: `packages/kirbot-core/src/turn-runtime.ts`
- Test: `packages/kirbot-core/tests/turn-lifecycle.test.ts`
- Test: `packages/kirbot-core/tests/bridge.test.ts`

- [ ] **Step 1: Write the failing tests**

Add tests that prove:
- workspace text/photo/document ingress forwards `telegramUsername` when `context.message.from.username` exists
- ingress omits `telegramUsername` when Telegram does not provide one
- activating a turn preserves the starter username in `TurnContext`
- queued follow-ups and promoted queued turns preserve the queued sender's username rather than the previous turn starter's username

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- apps/bot/tests/index.test.ts packages/kirbot-core/tests/turn-lifecycle.test.ts packages/kirbot-core/tests/bridge.test.ts`
Expected: FAIL because `UserTurnMessage` and turn state do not carry `telegramUsername` yet.

- [ ] **Step 3: Write minimal implementation**

Implement:
- an optional `telegramUsername?: string` field on `UserTurnMessage`
- ingress wiring in `apps/bot/src/index.ts` that trims and forwards `context.message.from.username`
- an optional `telegramUsername?: string` field on `TurnContext`
- `TurnLifecycleCoordinator.activateTurn()` copying the starter username into the turn context
- queued/pending message flows continuing to carry the per-message username unchanged so later promoted turns inherit the queued sender identity

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- apps/bot/tests/index.test.ts packages/kirbot-core/tests/turn-lifecycle.test.ts packages/kirbot-core/tests/bridge.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/index.ts \
  apps/bot/tests/index.test.ts \
  packages/kirbot-core/src/domain.ts \
  packages/kirbot-core/src/bridge/turn-context.ts \
  packages/kirbot-core/src/bridge/turn-lifecycle.ts \
  packages/kirbot-core/src/turn-runtime.ts \
  packages/kirbot-core/tests/turn-lifecycle.test.ts \
  packages/kirbot-core/tests/bridge.test.ts
git commit -m "feat: thread telegram usernames through turns"
```

### Task 2: Add a reusable mention-prefix helper for Telegram formatted messages

**Files:**
- Create: `packages/kirbot-core/src/bridge/telegram-mention-prefix.ts`
- Modify: `packages/kirbot-core/tests/presentation.test.ts`

- [ ] **Step 1: Write the failing tests**

Add focused tests that prove the helper:
- returns the original payload unchanged when `telegramUsername` is missing or blank
- prefixes `@jeremy ` to plain text payloads
- shifts existing entity offsets correctly when prefixing messages built by `buildRenderedAssistantMessage()` or approval prompt renderers
- preserves correct offsets when an existing entity begins immediately at the old text start, so the prefix-boundary case is unambiguous

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/kirbot-core/tests/presentation.test.ts`
Expected: FAIL because no bridge helper exists for prefixing text plus entity arrays.

- [ ] **Step 3: Write minimal implementation**

Implement a helper with an explicit shape like:

```ts
type MentionableMessage = { text: string; entities?: MessageEntity[] };

export function prefixTelegramUsernameMention(
  message: MentionableMessage,
  telegramUsername?: string | null
): MentionableMessage
```

Implementation details:
- normalize/trim the username
- return `message` unchanged when absent
- build the prefix as ``@${username} ``
- use `shiftEntity()` from `@kirbot/telegram-format` to move every entity by the prefix length in UTF-16 code units

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/kirbot-core/tests/presentation.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/kirbot-core/src/bridge/telegram-mention-prefix.ts \
  packages/kirbot-core/tests/presentation.test.ts
git commit -m "feat: add telegram mention prefix helper"
```

### Task 3: Apply mentions to turn finalization using semantic precedence

**Files:**
- Modify: `packages/kirbot-core/src/bridge/turn-finalization.ts`
- Modify: `packages/kirbot-core/src/bridge/turn-lifecycle.ts`
- Modify: `packages/kirbot-core/src/bridge/telegram-turn-surface.ts` only if final assistant publishing needs a helper-aware overload
- Modify: `packages/kirbot-core/tests/turn-lifecycle.test.ts`
- Modify: `packages/kirbot-core/tests/bridge.test.ts`

- [ ] **Step 1: Write the failing tests**

Add/update tests that prove:
- normal final assistant replies mention the turn starter even though commentary may publish earlier in transport order
- commentary-only output mentions on the first standalone commentary publication
- response-only output mentions on the first standalone response publication
- plan-only output mentions on the first standalone plan publication or oversize fallback
- later artifact chunks and completion footer messages remain unmentioned
- silent status bubble text and queue preview text remain unchanged after mention support lands
- turns without `telegramUsername` keep current text exactly

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/kirbot-core/tests/turn-lifecycle.test.ts packages/kirbot-core/tests/bridge.test.ts`
Expected: FAIL because finalization currently notifies based only on send-site flags and never prefixes mentions.

- [ ] **Step 3: Write minimal implementation**

Implement:
- helper-aware publishing in `turn-finalization.ts` so the mention target is selected by semantic precedence:
  1. final assistant reply when present
  2. otherwise first standalone commentary publication
  3. otherwise first standalone response publication
  4. otherwise first standalone plan publication
  5. otherwise first oversize fallback on that path
- make `TurnFinalizer` the owner of the precedence decision for completion-time notifications, including the branch that must publish `responsePublication.standaloneMessages` when there is no final assistant reply to attach them to
- application of `prefixTelegramUsernameMention()` only to that one primary notifying message
- plan publication wiring in `turn-lifecycle.ts` so the first notification-bearing plan message can receive the username when no higher-precedence completion message exists
- no mention changes to silent status bubble updates, queue preview updates, terminal-only status fallback sends, completion footers, startup footers, or initial prompt mirror messages

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/kirbot-core/tests/turn-lifecycle.test.ts packages/kirbot-core/tests/bridge.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/kirbot-core/src/bridge/turn-finalization.ts \
  packages/kirbot-core/src/bridge/turn-lifecycle.ts \
  packages/kirbot-core/src/bridge/telegram-turn-surface.ts \
  packages/kirbot-core/tests/turn-lifecycle.test.ts \
  packages/kirbot-core/tests/bridge.test.ts
git commit -m "feat: mention turn starters on final notifications"
```

### Task 4: Mention users on approval, permissions, and user-input prompts

**Files:**
- Modify: `packages/kirbot-core/src/bridge.ts`
- Modify: `packages/kirbot-core/src/bridge/request-coordinator.ts`
- Modify: `packages/kirbot-core/tests/bridge.test.ts`

- [ ] **Step 1: Write the failing tests**

Add bridge-level tests that prove:
- command approval prompts prefix `@username` on the initial notifying `sendMessage`
- file approval prompts do the same
- permissions approval prompts do the same
- initial user-input prompts do the same
- later `editMessageText` updates for the same request do not preserve or re-add the mention
- request prompts fall back to unmentioned text when the active turn cannot be resolved or has no username
- provisioning and other generic topic-scoped bridge messages remain unmentioned

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/kirbot-core/tests/bridge.test.ts`
Expected: FAIL because `BridgeRequestCoordinator` has no turn lookup and prompt sends are still raw rendered text.

- [ ] **Step 3: Write minimal implementation**

Implement:
- a narrow turn lookup dependency from `bridge.ts` into `BridgeRequestCoordinator`, for example `getTurnContext(turnId): TurnContext | undefined`
- initial prompt send paths in `request-coordinator.ts` that resolve the active turn starter username, call `prefixTelegramUsernameMention()`, and use the prefixed payload only on the initial notification-bearing `sendMessage`
- unchanged edit/update flows for already-posted request messages
- explicit fallback to unmentioned prompt text when the turn context is unavailable

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/kirbot-core/tests/bridge.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/kirbot-core/src/bridge.ts \
  packages/kirbot-core/src/bridge/request-coordinator.ts \
  packages/kirbot-core/tests/bridge.test.ts
git commit -m "feat: mention users on request prompts"
```

### Task 5: Run targeted verification and repository build

**Files:**
- No source changes expected

- [ ] **Step 1: Run the targeted test suite**

Run: `npm test -- apps/bot/tests/index.test.ts packages/kirbot-core/tests/presentation.test.ts packages/kirbot-core/tests/turn-lifecycle.test.ts packages/kirbot-core/tests/bridge.test.ts`
Expected: PASS

- [ ] **Step 2: Run the full repository build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 3: Manual Telegram verification**

Run:
- `npm run start:tmux:restart`
- send a normal workspace message from a Telegram account with a username
- trigger a completion with a final assistant reply
- trigger a permissions or approval prompt
- repeat with an account that has no username

Expected:
- the relevant primary notifying message starts with `@username `
- silent status bubbles and queue preview messages remain unchanged
- request prompt edits do not keep or re-add the mention prefix
- users without usernames receive the current unmentioned behavior

- [ ] **Step 4: Commit final integration changes if needed**

```bash
git status --short
```

Expected: only intended mention-notification changes remain staged or committed.
