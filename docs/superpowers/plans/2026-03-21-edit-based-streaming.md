# Edit-Based Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace draft-based assistant streaming with one editable Telegram message per turn, using semantic buffering plus a 1 second edit cooldown.

**Architecture:** Add one centralized streaming coordinator under `packages/kirbot-core/src/bridge/` that owns buffering, flush-boundary detection, and edit throttling. Keep `telegram-messenger.ts` as a thin transport wrapper around `sendMessage` and `editMessageText`, and keep `turn-lifecycle.ts` responsible for orchestration and finalization only. The visible turn message starts as status text, then is edited in place until completion.

**Tech Stack:** TypeScript, Vitest, grammy, existing kirbot bridge modules

---

### Task 1: Add semantic flush-boundary tests and detector

**Files:**
- Create: `packages/kirbot-core/src/bridge/stream-boundaries.ts`
- Create: `packages/kirbot-core/tests/stream-boundaries.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { hasFlushBoundary, splitFlushablePrefix } from "../src/bridge/stream-boundaries";

describe("stream boundaries", () => {
  it("flushes on sentence endings", () => {
    expect(hasFlushBoundary("Hello world.")).toBe(true);
    expect(splitFlushablePrefix("Hello world. More text")).toEqual(["Hello world.", " More text"]);
  });

  it("flushes on paragraph breaks and structured lines", () => {
    expect(splitFlushablePrefix("First line\n\nSecond line")).toEqual(["First line\n\n", "Second line"]);
    expect(splitFlushablePrefix("- item one\n- item two")).toEqual(["- item one\n", "- item two"]);
  });

  it("does not flush mid code fence content", () => {
    expect(splitFlushablePrefix("```ts\nconst x = 1;\n```")).toEqual(["", "```ts\nconst x = 1;\n```"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/kirbot-core/tests/stream-boundaries.test.ts -v`
Expected: fail because `@kirbot/core/bridge/stream-boundaries` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Implement a small pure helper that:

- recognizes `.`, `?`, `!` followed by whitespace or end of text
- recognizes `\n\n`
- recognizes intentional single newlines for list-like text
- ignores mid-code-block text
- returns the longest flushable prefix plus the remaining suffix

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/kirbot-core/tests/stream-boundaries.test.ts -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kirbot-core/src/bridge/stream-boundaries.ts packages/kirbot-core/tests/stream-boundaries.test.ts
git commit -m "test: add stream boundary detection coverage"
```

### Task 2: Add a centralized editable-message streaming coordinator

**Files:**
- Create: `packages/kirbot-core/src/bridge/telegram-streaming.ts`
- Modify: `packages/kirbot-core/src/bridge/turn-context.ts`
- Modify: `packages/kirbot-core/src/telegram-messenger.ts`
- Create: `packages/kirbot-core/tests/telegram-streaming.test.ts`
- Modify: `packages/kirbot-core/tests/telegram-messenger.test.ts`

- [ ] **Step 1: Write the failing test**

Write tests that prove:

- a turn starts by sending one normal Telegram message
- subsequent visible updates use `editMessageText`
- edits are not emitted more often than once per second
- sentence and newline boundaries can trigger an early flush only when cooldown allows it
- the same message is edited into the final answer on completion

Example command:

```bash
npm test -- packages/kirbot-core/tests/telegram-streaming.test.ts -v
```

Expected: fail because the new coordinator and message-edit flow do not exist yet.

- [ ] **Step 2: Run test to verify it fails**

Run the command above and confirm the failures are about missing coordinator behavior, not flaky timing.

- [ ] **Step 3: Write minimal implementation**

Add a coordinator that:

- owns one visible message per turn
- stores `messageId`, `pendingText`, `lastEditAt`, and retry state
- asks `telegram-messenger.ts` to send the initial status message with `sendMessage`
- edits the same message with `editMessageText`
- accumulates assistant deltas and flushes only when a boundary detector says the buffer is ready
- enforces a minimum 1 second edit interval
- lets `telegram-messenger.ts` own `429` retry/backoff handling for message edits
- retries non-retryable failures only when the caller explicitly re-issues the update

Update `turn-context.ts` so the visible-message handle is no longer draft-specific.

Refactor `telegram-messenger.ts` so it exposes thin message and edit helpers, with no draft-streaming policy.

Add tests that cover:

- non-retryable edit failures do not reintroduce a separate final bubble
- finalization still edits the same message into the final answer even if an intermediate edit failed
- fake timers drive the 1 second cooldown deterministically

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm test -- packages/kirbot-core/tests/telegram-streaming.test.ts -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kirbot-core/src/bridge/telegram-streaming.ts packages/kirbot-core/src/bridge/turn-context.ts packages/kirbot-core/src/telegram-messenger.ts packages/kirbot-core/tests/telegram-streaming.test.ts packages/kirbot-core/tests/telegram-messenger.test.ts
git commit -m "feat: add edit-based telegram streaming coordinator"
```

### Task 3: Wire turn lifecycle and bridge notifications into the new coordinator

**Files:**
- Modify: `packages/kirbot-core/src/bridge/turn-lifecycle.ts`
- Modify: `packages/kirbot-core/src/bridge/turn-finalization.ts`
- Modify: `packages/kirbot-core/src/bridge.ts`
- Modify: `packages/kirbot-core/src/bridge/presentation.ts`
- Modify: `packages/kirbot-core/tests/bridge.test.ts`
- Modify: `packages/kirbot-core/tests/turn-lifecycle.test.ts`

- [ ] **Step 1: Write the failing test**

Update the bridge tests that currently assert draft events so they assert:

- a single initial `sendMessage`
- follow-up `editMessageText` updates
- no draft events in the normal turn path
- final assistant text is the same message edited in place, not a separate bubble

Run:

```bash
npm test -- packages/kirbot-core/tests/bridge.test.ts -v
```

Expected: existing draft-based assertions fail.

- [ ] **Step 2: Run test to verify it fails**

Confirm the failures are because draft events are still present and the new edit path is absent.

- [ ] **Step 3: Write minimal implementation**

Update the bridge and lifecycle wiring so:

- turn activation sends the initial visible message
- `item/agentMessage/delta` goes through the coordinator buffer
- status changes still update the same visible message
- turn completion edits the same message into the final answer
- interrupt/failure paths force the latest visible text before terminal cleanup

Keep `turn-lifecycle.ts` responsible for phase changes, finalization orchestration, and footer/approval behavior, but not for buffering policy.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm test -- packages/kirbot-core/tests/bridge.test.ts packages/kirbot-core/tests/turn-lifecycle.test.ts -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kirbot-core/src/bridge/turn-lifecycle.ts packages/kirbot-core/src/bridge/turn-finalization.ts packages/kirbot-core/src/bridge.ts packages/kirbot-core/src/bridge/presentation.ts packages/kirbot-core/tests/bridge.test.ts packages/kirbot-core/tests/turn-lifecycle.test.ts
git commit -m "feat: route turn streaming through editable messages"
```

### Task 4: Remove draft-stream assumptions from harness coverage and docs

**Files:**
- Modify: `packages/telegram-harness/src/recording-telegram.ts`
- Modify: `packages/telegram-harness/tests/harness.test.ts`
- Modify: `docs/architecture.md`
- Modify: `docs/user-flows.md`
- Modify: `docs/engineering-guide.md`

- [ ] **Step 1: Write the failing test**

Update harness assertions so a streamed turn is represented as a single edited message rather than a draft transcript plus a separate final assistant message.

Run:

```bash
npm test -- packages/telegram-harness/tests/harness.test.ts -v
```

Expected: the current draft-centric transcript expectations fail.

- [ ] **Step 2: Run test to verify it fails**

Confirm the only expected failures are transcript/event mismatches around draft usage.

- [ ] **Step 3: Write minimal implementation**

Update the recording transport and harness expectations so they record:

- the initial visible message
- subsequent edits to that same message
- no draft entries for the normal turn path

Update the docs so they describe the new one-message-per-turn model and stop calling draft streaming the default behavior.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm test -- packages/telegram-harness/tests/harness.test.ts -v
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/telegram-harness/src/recording-telegram.ts packages/telegram-harness/tests/harness.test.ts docs/architecture.md docs/user-flows.md docs/engineering-guide.md
git commit -m "docs: document edit-based streaming and update harness"
```
