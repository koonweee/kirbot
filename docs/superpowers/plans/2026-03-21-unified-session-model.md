# Unified Session Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace kirbot's topic-centric session model with a unified root/topic session model where root is a persistent Codex thread, `/thread <prompt>` spawns topic sessions, root settings split into live-root vs spawn-default scopes, and custom commands work in both root and topics.

**Architecture:** Introduce a generic persisted `sessions` model plus chat-scoped root/spawn defaults, then make runtime, bridge routing, and request handling operate on a session surface instead of assuming every active thread lives in a Telegram topic. Keep `preferredMode` persisted in kirbot until the Codex app-server protocol exposes durable collaboration-mode state strongly enough to trust on resume.

**Tech Stack:** TypeScript, Node 22, Vitest, Kysely, better-sqlite3, Grammy Telegram bot APIs, pinned `@openai/codex` app-server integration.

---

## File Structure

### Core persistence and domain

- Modify: `packages/kirbot-core/src/domain.ts`
  Responsibility: generic session, session-surface, and chat-defaults domain types.
- Modify: `packages/kirbot-core/src/db.ts`
  Responsibility: non-destructive schema migration, `sessions` storage, chat-default storage, nullable root-surface request routing.
- Test: `packages/kirbot-core/tests/db.test.ts`
  Responsibility: persistence contract for sessions, defaults, migrations, and nullable root request ownership.

### Session surface helpers

- Create: `packages/kirbot-core/src/bridge/session-surface.ts`
  Responsibility: shared root/topic surface identifiers, keys, and helper predicates so bridge/runtime code stops hand-rolling `topicId` assumptions.

### Runtime and Telegram delivery

- Modify: `packages/kirbot-core/src/telegram-messenger.ts`
  Responsibility: nullable topic delivery and draft handles for root-surface streaming/status.
- Modify: `packages/kirbot-core/src/turn-runtime.ts`
  Responsibility: in-memory active-turn and queue state keyed by session surface, not required topic ids.
- Modify: `packages/kirbot-core/src/bridge/turn-context.ts`
  Responsibility: surface-aware turn context.
- Modify: `packages/kirbot-core/src/bridge/turn-lifecycle.ts`
  Responsibility: activate/finalize turns for root and topic surfaces.
- Modify: `packages/kirbot-core/src/bridge/turn-finalization.ts`
  Responsibility: follow-up submission and queue drain APIs using session surfaces.
- Test: `packages/kirbot-core/tests/telegram-messenger.test.ts`
- Test: `packages/kirbot-core/tests/turn-lifecycle.test.ts`

### Bridge routing and commands

- Modify: `packages/kirbot-core/src/bridge.ts`
  Responsibility: root persistent session routing, `/thread`, generic session creation, custom command invocation in root/topics, root-vs-spawn settings flows.
- Modify: `packages/kirbot-core/src/bridge/slash-commands.ts`
  Responsibility: `/thread` definition, `/start` removal, updated descriptions/scopes.
- Modify: `packages/kirbot-core/src/bridge/custom-commands.ts`
  Responsibility: help/copy updates now that commands are shared across root and topics.
- Modify: `packages/kirbot-core/src/bridge/request-coordinator.ts`
  Responsibility: route approvals and request-user-input back to root or topic surfaces.
- Modify: `packages/kirbot-core/src/bridge/presentation.ts`
  Responsibility: root-safe startup/footer copy and root-vs-spawn settings picker text.
- Modify: `packages/kirbot-core/src/telegram-commands.ts`
  Responsibility: exported command list follows the new slash-command surface.
- Modify: `packages/kirbot-core/src/telegram-command-sync.ts`
  Responsibility: visible command menu remains aligned with root/topic command changes.
- Test: `packages/kirbot-core/tests/bridge.test.ts`
- Test: `packages/kirbot-core/tests/telegram-command-sync.test.ts`
- Test: `packages/telegram-harness/tests/harness.test.ts`

### Docs

- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/user-flows.md`

## Task 1: Replace destructive DB migration with unified session persistence

**Files:**
- Create: `packages/kirbot-core/src/bridge/session-surface.ts`
- Modify: `packages/kirbot-core/src/domain.ts`
- Modify: `packages/kirbot-core/src/db.ts`
- Test: `packages/kirbot-core/tests/db.test.ts`

- [ ] **Step 1: Write failing DB tests for unified sessions and defaults**

```ts
it("creates and looks up a root session separately from a topic session", async () => {
  const root = await database.createProvisioningSession({
    telegramChatId: "-1001",
    surface: { kind: "root" }
  });

  const topic = await database.createProvisioningSession({
    telegramChatId: "-1001",
    surface: { kind: "topic", topicId: 22 }
  });

  expect(root.surface.kind).toBe("root");
  expect(topic.surface.kind).toBe("topic");
});

it("stores separate root and spawn defaults", async () => {
  await database.upsertChatThreadDefaults("-1001", {
    root: { model: "gpt-5.4-mini" },
    spawn: { model: "gpt-5-codex" }
  });

  const defaults = await database.getChatThreadDefaults("-1001");
  expect(defaults?.root.model).toBe("gpt-5.4-mini");
  expect(defaults?.spawn.model).toBe("gpt-5-codex");
});
```

- [ ] **Step 2: Run the DB tests and verify they fail on missing APIs/schema**

Run: `npm test -- packages/kirbot-core/tests/db.test.ts`
Expected: FAIL with missing `sessions`/chat-default APIs or incorrect topic-only assumptions.

- [ ] **Step 3: Implement generic session/domain types and non-destructive schema migration**

```ts
export type SessionSurface =
  | { kind: "root" }
  | { kind: "topic"; topicId: number };

export type BridgeSession = {
  id: number;
  telegramChatId: string;
  surface: SessionSurface;
  codexThreadId: string | null;
  status: SessionStatus;
  preferredMode: SessionMode;
};

export type ChatThreadDefaults = {
  root: CodexThreadSettingsOverride;
  spawn: CodexThreadSettingsOverride;
};
```

Implementation notes:
- Bump schema version and replace `#dropAllTables()` migration behavior with explicit migration steps.
- Create `sessions` and `chat_thread_defaults` tables.
- Rebuild `server_requests` so `telegram_topic_id` becomes nullable.
- Backfill existing `topic_sessions` rows into `sessions` with `surface_kind = "topic"`.
- Keep compatibility wrappers like `getSessionByTopic()` temporarily if that reduces bridge churn during intermediate commits.

- [ ] **Step 4: Run DB tests again and verify the new persistence contract passes**

Run: `npm test -- packages/kirbot-core/tests/db.test.ts`
Expected: PASS

- [ ] **Step 5: Commit the persistence foundation**

```bash
git add packages/kirbot-core/src/bridge/session-surface.ts \
  packages/kirbot-core/src/domain.ts \
  packages/kirbot-core/src/db.ts \
  packages/kirbot-core/tests/db.test.ts
git commit -m "refactor: add unified session persistence"
```

## Task 2: Make runtime and Telegram delivery surface-aware

**Files:**
- Modify: `packages/kirbot-core/src/telegram-messenger.ts`
- Modify: `packages/kirbot-core/src/turn-runtime.ts`
- Modify: `packages/kirbot-core/src/bridge/turn-context.ts`
- Modify: `packages/kirbot-core/src/bridge/turn-lifecycle.ts`
- Modify: `packages/kirbot-core/src/bridge/turn-finalization.ts`
- Test: `packages/kirbot-core/tests/telegram-messenger.test.ts`
- Test: `packages/kirbot-core/tests/turn-lifecycle.test.ts`

- [ ] **Step 1: Write failing tests for root-surface drafts and queue state**

```ts
it("sends root-surface messages without message_thread_id", async () => {
  await messenger.sendMessage({ chatId: -1001, topicId: null, text: "Root response" });
  expect(telegram.sendMessageCalls.at(-1)?.options?.message_thread_id).toBeUndefined();
});

it("tracks an active turn for a root surface", async () => {
  const turn = runtime.registerTurn({
    chatId: -1001,
    topicId: null,
    threadId: "thread-root",
    turnId: "turn-1"
  });
  expect(runtime.getActiveTurnBySurface(-1001, { kind: "root" })?.turnId).toBe(turn.turnId);
});
```

- [ ] **Step 2: Run targeted runtime and messenger tests to confirm topic-only assumptions fail**

Run: `npm test -- packages/kirbot-core/tests/telegram-messenger.test.ts packages/kirbot-core/tests/turn-lifecycle.test.ts`
Expected: FAIL with `topicId` type/assertion errors or missing root-surface APIs.

- [ ] **Step 3: Implement nullable-root support in messenger and runtime types**

```ts
export type TurnContext = {
  chatId: number;
  topicId: number | null;
  threadId: string;
  turnId: string;
  // ...
};

type SurfaceStateKey = string;

function surfaceKey(chatId: number, surface: SessionSurface): SurfaceStateKey {
  return surface.kind === "root" ? `${chatId}:root` : `${chatId}:topic:${surface.topicId}`;
}
```

Implementation notes:
- Allow `topicId: null` through `TelegramMessenger.sendMessage()`, draft handles, and chat actions.
- Rename internal queue helpers from topic-specific naming to surface-aware naming where practical.
- Remove hard throws in `TurnLifecycleCoordinator.activateTurn()` for `topicId === null`.
- Keep Telegram option building centralized so root messages simply omit `message_thread_id`.

- [ ] **Step 4: Re-run targeted tests for runtime and messenger**

Run: `npm test -- packages/kirbot-core/tests/telegram-messenger.test.ts packages/kirbot-core/tests/turn-lifecycle.test.ts`
Expected: PASS

- [ ] **Step 5: Commit the runtime surface generalization**

```bash
git add packages/kirbot-core/src/telegram-messenger.ts \
  packages/kirbot-core/src/turn-runtime.ts \
  packages/kirbot-core/src/bridge/turn-context.ts \
  packages/kirbot-core/src/bridge/turn-lifecycle.ts \
  packages/kirbot-core/src/bridge/turn-finalization.ts \
  packages/kirbot-core/tests/telegram-messenger.test.ts \
  packages/kirbot-core/tests/turn-lifecycle.test.ts
git commit -m "refactor: support root and topic turn surfaces"
```

## Task 3: Route root messages to a persistent session and add `/thread`

**Files:**
- Modify: `packages/kirbot-core/src/bridge.ts`
- Modify: `packages/kirbot-core/src/bridge/slash-commands.ts`
- Modify: `packages/kirbot-core/src/bridge/presentation.ts`
- Modify: `packages/kirbot-core/src/telegram-commands.ts`
- Test: `packages/kirbot-core/tests/bridge.test.ts`
- Test: `packages/kirbot-core/tests/telegram-command-sync.test.ts`
- Test: `packages/telegram-harness/tests/harness.test.ts`

- [ ] **Step 1: Write failing bridge tests for persistent root sessions and `/thread`**

```ts
it("reuses the same root Codex thread for multiple plain root messages", async () => {
  await bridge.handleUserTextMessage(rootMessage("Inspect repo", 20));
  await bridge.handleUserTextMessage(rootMessage("Continue", 21));

  expect(codex.createdThreads).toEqual(["Root Chat"]);
  expect(codex.turns.map((turn) => turn.threadId)).toEqual(["thread-root", "thread-root"]);
  expect(telegram.createdTopics).toHaveLength(0);
});

it("creates a topic session from /thread using spawn defaults", async () => {
  await bridge.handleUserTextMessage(rootMessage("/thread Draft the rollout", 22));
  expect(telegram.createdTopics).toHaveLength(1);
  expect(codex.turns.at(-1)?.text).toBe("Draft the rollout");
});
```

- [ ] **Step 2: Run focused bridge tests and confirm current root-lobby behavior fails**

Run: `npm test -- packages/kirbot-core/tests/bridge.test.ts`
Expected: FAIL because root messages still create topics and `/thread` is undefined.

- [ ] **Step 3: Implement generic session resolution and shared session creation helpers**

```ts
private async resolveOrCreateRootSession(chatId: number): Promise<BridgeSession> { /* ... */ }

private async startSessionForSurface(
  message: UserTurnMessage,
  target: { kind: "root" } | { kind: "topic"; topicId: number; title: string },
  options?: { initialPreferredMode?: SessionMode; initialPromptText?: string; startInitialTurn?: boolean }
): Promise<void> { /* ... */ }
```

Implementation notes:
- Plain root messages should resolve/create the root session and submit on that thread.
- `/thread <prompt>` should create a topic and then call the shared topic-session bootstrap.
- Root `/plan` should keep spawning a topic session, but go through the same shared topic-session bootstrap with `initialPreferredMode = "plan"`.
- Remove `/start` parsing, validation, usage text, command definitions, and menu exposure.
- Update command descriptions so root-capable commands are no longer phrased as topic-only.

- [ ] **Step 4: Re-run bridge, command-sync, and harness tests for session routing**

Run: `npm test -- packages/kirbot-core/tests/bridge.test.ts packages/kirbot-core/tests/telegram-command-sync.test.ts packages/telegram-harness/tests/harness.test.ts`
Expected: PASS for root persistence, `/thread`, and `/start` removal scenarios.

- [ ] **Step 5: Commit the routing cutover**

```bash
git add packages/kirbot-core/src/bridge.ts \
  packages/kirbot-core/src/bridge/slash-commands.ts \
  packages/kirbot-core/src/bridge/presentation.ts \
  packages/kirbot-core/src/telegram-commands.ts \
  packages/kirbot-core/tests/bridge.test.ts \
  packages/kirbot-core/tests/telegram-command-sync.test.ts \
  packages/telegram-harness/tests/harness.test.ts
git commit -m "refactor: route root chat through a persistent session"
```

## Task 4: Split root-session settings from spawn defaults

**Files:**
- Modify: `packages/kirbot-core/src/bridge.ts`
- Modify: `packages/kirbot-core/src/bridge/presentation.ts`
- Modify: `packages/kirbot-core/tests/bridge.test.ts`

- [ ] **Step 1: Write failing tests for root-vs-spawn settings scope**

```ts
it("lets root /model update the live root session without changing spawn defaults", async () => {
  await bridge.handleUserTextMessage(rootMessage("/model", 30));
  await bridge.handleCallbackQuery(scopeCallback("slash:model:scope:root-session"));
  await bridge.handleCallbackQuery(pickModelCallback("gpt-5.4-mini", "medium"));

  expect(codex.threadSettingsUpdates.at(-1)?.threadId).toBe("thread-root");
  expect(codex.globalSettingsUpdates).toEqual([]);
});

it("uses spawn defaults when creating a /thread topic", async () => {
  // after spawn-default updates
  await bridge.handleUserTextMessage(rootMessage("/thread Draft release notes", 31));
  expect(codex.createThreadCalls.at(-1)?.settings?.model).toBe("gpt-5-codex");
});
```

- [ ] **Step 2: Run the bridge tests and verify the current single-scope root flows fail**

Run: `npm test -- packages/kirbot-core/tests/bridge.test.ts`
Expected: FAIL because root `/model`, `/fast`, and `/permissions` currently only target one global scope.

- [ ] **Step 3: Implement explicit scope selection for root settings commands**

```ts
type RootSettingsScope = "root-session" | "spawn-defaults";

type CodexSettingsTarget =
  | { scope: "thread"; session: BridgeSession; settings: ThreadStartSettings }
  | { scope: "spawn-defaults"; defaults: ChatThreadDefaults["spawn"] }
  | { scope: "root-session"; session: BridgeSession; settings: ThreadStartSettings };
```

Implementation notes:
- Root `/model`, `/fast`, and `/permissions` should first prompt for target scope.
- Root-session changes should call `updateThreadSettings()` on the root thread.
- Spawn-default changes should persist to `chat_thread_defaults`.
- Topic creation paths (`/thread`, root `/plan`) must read spawn defaults, not the live root thread settings.
- Keep active-turn guards for root-session updates just as topic-session updates are guarded today.

- [ ] **Step 4: Re-run targeted bridge tests for settings scope split**

Run: `npm test -- packages/kirbot-core/tests/bridge.test.ts`
Expected: PASS for root-session vs spawn-default selection and `/thread` defaulting behavior.

- [ ] **Step 5: Commit the root settings split**

```bash
git add packages/kirbot-core/src/bridge.ts \
  packages/kirbot-core/src/bridge/presentation.ts \
  packages/kirbot-core/tests/bridge.test.ts
git commit -m "feat: split root settings from topic spawn defaults"
```

## Task 5: Expand custom commands to root and fix request routing by session surface

**Files:**
- Modify: `packages/kirbot-core/src/bridge.ts`
- Modify: `packages/kirbot-core/src/bridge/custom-commands.ts`
- Modify: `packages/kirbot-core/src/bridge/request-coordinator.ts`
- Modify: `packages/kirbot-core/src/domain.ts`
- Modify: `packages/kirbot-core/tests/bridge.test.ts`
- Modify: `packages/kirbot-core/tests/db.test.ts`
- Modify: `packages/telegram-harness/tests/harness.test.ts`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/user-flows.md`

- [ ] **Step 1: Write failing tests for root custom commands and root-surface approvals**

```ts
it("invokes a shared custom command from root against the persistent root session", async () => {
  await database.createCustomCommand({ command: "standup", prompt: "Draft the daily update." });
  await bridge.handleUserTextMessage(rootMessage("/standup blockers", 40));
  expect(codex.turns.at(-1)?.threadId).toBe("thread-root");
});

it("routes approval prompts for the root session back to the root chat", async () => {
  codex.emitCommandApprovalForThread("thread-root");
  await waitForAsyncNotifications();
  expect(telegram.sentMessages.at(-1)?.options?.message_thread_id).toBeUndefined();
});
```

- [ ] **Step 2: Run bridge, DB, and harness tests to confirm topic-only routing fails**

Run: `npm test -- packages/kirbot-core/tests/bridge.test.ts packages/kirbot-core/tests/db.test.ts packages/telegram-harness/tests/harness.test.ts`
Expected: FAIL because root custom-command invocation is rejected and request routing still assumes `telegram_topic_id` is always set.

- [ ] **Step 3: Implement shared custom-command invocation and surface-based request lookups**

```ts
private async tryHandleCustomCommandInvocation(
  message: UserTurnMessage,
  commandName: string,
  argsText: string
): Promise<boolean> {
  const session = await this.resolveSessionForMessage(message);
  // root and topic both allowed
}

private async findSessionForRequest(request: ServerRequest): Promise<BridgeSession | undefined> {
  const threadId = extractThreadId(request);
  return threadId ? this.database.getSessionByCodexThreadId(threadId) : undefined;
}
```

Implementation notes:
- Remove the `message.topicId === null` early return in custom-command invocation.
- Update any topic-only help text and confirmation copy.
- Allow `PendingServerRequest.telegramTopicId` to be `null` in domain types and routing logic.
- Ensure all request publication/edit paths omit `message_thread_id` for root-session prompts.
- Update docs to describe root as a persistent session, `/thread` as the new topic spawn entrypoint, and custom commands as chat-shared.

- [ ] **Step 4: Re-run bridge, DB, and harness tests**

Run: `npm test -- packages/kirbot-core/tests/bridge.test.ts packages/kirbot-core/tests/db.test.ts packages/telegram-harness/tests/harness.test.ts`
Expected: PASS

- [ ] **Step 5: Commit command-scope and request-routing changes**

```bash
git add packages/kirbot-core/src/bridge.ts \
  packages/kirbot-core/src/bridge/custom-commands.ts \
  packages/kirbot-core/src/bridge/request-coordinator.ts \
  packages/kirbot-core/src/domain.ts \
  packages/kirbot-core/tests/bridge.test.ts \
  packages/kirbot-core/tests/db.test.ts \
  packages/telegram-harness/tests/harness.test.ts \
  README.md docs/architecture.md docs/user-flows.md
git commit -m "feat: support shared commands across root and topic sessions"
```

## Task 6: Run full verification and clean up compatibility shims

**Files:**
- Modify: `packages/kirbot-core/src/db.ts`
- Modify: `packages/kirbot-core/src/bridge.ts`
- Modify: `packages/kirbot-core/src/turn-runtime.ts`
- Test: workspace-wide verification

- [ ] **Step 1: Remove temporary compatibility wrappers and dead topic-only code left from intermediate tasks**

```ts
// Delete temporary wrappers once all callers use:
getSessionBySurface(...)
archiveSessionBySurface(...)
updateSessionPreferredModeBySurface(...)
```

- [ ] **Step 2: Run typecheck and targeted regression suites**

Run: `npm run typecheck`
Expected: PASS

Run: `npm test -- packages/kirbot-core/tests/db.test.ts packages/kirbot-core/tests/bridge.test.ts packages/kirbot-core/tests/turn-lifecycle.test.ts packages/kirbot-core/tests/telegram-messenger.test.ts packages/kirbot-core/tests/telegram-command-sync.test.ts packages/telegram-harness/tests/harness.test.ts`
Expected: PASS

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Build a final detached/manual smoke-check command list if needed**

Run: `npm run typecheck && npm test`
Expected: PASS with no dirty-worktree surprises beyond the intentional refactor files.

- [ ] **Step 5: Commit the final compatibility cleanup**

```bash
git add packages/kirbot-core/src/db.ts \
  packages/kirbot-core/src/bridge.ts \
  packages/kirbot-core/src/turn-runtime.ts
git commit -m "refactor: finalize unified session model"
```
