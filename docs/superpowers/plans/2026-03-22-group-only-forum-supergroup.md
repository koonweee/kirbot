# Group-Only Forum Supergroup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate Kirbot from Telegram private-chat topics to a single private forum supergroup where `General` is the shared root session and each forum topic is a shared Kirbot session.

**Architecture:** Replace the current private-chat-root surface model with an explicit forum-workspace model that distinguishes `General` from non-`General` topics, routes all session state by workspace chat plus surface, and removes single-user assumptions from the Telegram entrypoint, bridge, database, and command sync. Keep the existing root-vs-topic workflow, but reinterpret it as `General` versus forum topic inside one dedicated supergroup.

**Tech Stack:** TypeScript, Vitest, grammy, Telegram Bot API, Kysely, better-sqlite3, Kirbot bridge/runtime

---

### Task 1: Replace private-chat config with explicit workspace-chat config

**Files:**
- Modify: `packages/kirbot-core/src/config.ts`
- Modify: `packages/kirbot-core/tests/config.test.ts`
- Modify: `apps/bot/tests/config.test.ts`
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Write failing config tests for workspace-chat settings**

Add tests covering:
- `loadConfig()` requires a workspace chat ID instead of `TELEGRAM_USER_ID`
- `loadConfig()` exposes `config.telegram.workspaceChatId`
- importing config no longer depends on a single allowed user ID

- [ ] **Step 2: Run the config tests to verify they fail**

Run: `npm test -- packages/kirbot-core/tests/config.test.ts apps/bot/tests/config.test.ts -v`
Expected: FAIL because config still requires `TELEGRAM_USER_ID` and exposes `telegram.userId`

- [ ] **Step 3: Implement the minimal config shape change**

Update env parsing and returned config shape from:

```ts
telegram: {
  botToken: string;
  userId: number;
}
```

to:

```ts
telegram: {
  botToken: string;
  workspaceChatId: number;
}
```

Rename the environment variable everywhere to `TELEGRAM_WORKSPACE_CHAT_ID`, update tests, and update setup docs/examples to describe a dedicated private forum supergroup.

- [ ] **Step 4: Run the config tests to verify they pass**

Run: `npm test -- packages/kirbot-core/tests/config.test.ts apps/bot/tests/config.test.ts -v`
Expected: PASS

### Task 2: Introduce an explicit `General` surface in domain and persistence

**Files:**
- Modify: `packages/kirbot-core/src/domain.ts`
- Modify: `packages/kirbot-core/src/db.ts`
- Modify: `packages/kirbot-core/tests/db.test.ts`

- [ ] **Step 1: Write failing DB tests for `General` and topic surfaces**

Add tests covering:
- a session can be stored and read back as `{ kind: "general" }`
- a topic session still requires a numeric `topicId`
- unique indexes allow one `general` session and many topic sessions per workspace chat
- root/default settings lookup now maps to the workspace `General` session semantics

- [ ] **Step 2: Run the DB tests to verify they fail**

Run: `npm test -- packages/kirbot-core/tests/db.test.ts -v`
Expected: FAIL because `SessionSurface` only supports `root` and `topic`, and the schema only recognizes `surface_kind = 'root' | 'topic'`

- [ ] **Step 3: Implement the minimal schema and domain migration**

Change:

```ts
export type SessionSurface =
  | { kind: "root" }
  | { kind: "topic"; topicId: number };
```

to:

```ts
export type SessionSurface =
  | { kind: "general" }
  | { kind: "topic"; topicId: number };
```

Update row mapping, lookup helpers, indexes, and schema versioning in `db.ts` so `general` is explicit and no longer represented as `topicId = null` meaning "private root chat".

- [ ] **Step 4: Run the DB tests to verify they pass**

Run: `npm test -- packages/kirbot-core/tests/db.test.ts -v`
Expected: PASS

### Task 3: Rework Telegram startup and command sync for one forum workspace

**Files:**
- Modify: `apps/bot/src/index.ts`
- Modify: `packages/kirbot-core/src/runtime.ts`
- Modify: `packages/kirbot-core/src/telegram-command-sync.ts`
- Modify: `packages/kirbot-core/tests/telegram-command-sync.test.ts`
- Modify: `packages/kirbot-core/tests/bridge.test.ts`

- [ ] **Step 1: Write failing tests for workspace-scoped command sync and message acceptance**

Add tests covering:
- command sync targets the configured workspace chat instead of a private user chat
- messages from the configured workspace chat are accepted regardless of sender ID
- DMs are rejected or redirected instead of being treated as the root surface

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `npm test -- packages/kirbot-core/tests/telegram-command-sync.test.ts packages/kirbot-core/tests/bridge.test.ts -v`
Expected: FAIL because runtime still passes `config.telegram.userId` into command sync and the bot entrypoint still rejects any sender not equal to that user ID

- [ ] **Step 3: Implement minimal workspace-aware ingestion**

Update the bot entrypoint so it:
- accepts updates only from `config.telegram.workspaceChatId`
- stops filtering by sender ID
- rejects/redirects direct messages
- forwards forum-topic context to the bridge using workspace chat identity rather than private-chat assumptions

Update command sync so startup applies the visible command list and commands menu button to the workspace group chat scope instead of a private chat scope.

- [ ] **Step 4: Run the targeted tests to verify they pass**

Run: `npm test -- packages/kirbot-core/tests/telegram-command-sync.test.ts packages/kirbot-core/tests/bridge.test.ts -v`
Expected: PASS for the new workspace-chat expectations

### Task 4: Reinterpret root/topic bridge routing as `General` versus forum topic

**Files:**
- Modify: `packages/kirbot-core/src/bridge.ts`
- Modify: `packages/kirbot-core/src/bridge/slash-commands.ts`
- Modify: `packages/kirbot-core/src/bridge/presentation.ts`
- Modify: `packages/kirbot-core/tests/bridge.test.ts`

- [ ] **Step 1: Write failing bridge tests for `General` as the shared root session**

Add tests covering:
- a normal message in `General` boots or continues the shared root Codex thread
- `/thread <prompt>` in `General` creates a forum topic session
- root `/plan [prompt]` in `General` creates a plan topic
- a normal message in an unmapped existing non-`General` topic boots a shared session in that topic
- root-only commands are allowed in `General` and topic-only commands are still restricted to forum topics

- [ ] **Step 2: Run the bridge tests to verify they fail**

Run: `npm test -- packages/kirbot-core/tests/bridge.test.ts -v`
Expected: FAIL because the bridge still treats `topicId = null` as a private-chat root session and routes on `root`/`topic` rather than `general`/`topic`

- [ ] **Step 3: Implement minimal bridge routing changes**

Update bridge routing so:

```ts
surface.kind === "root"
```

becomes:

```ts
surface.kind === "general"
```

and interpret Telegram `General` traffic as the shared root session for the workspace. Keep `/thread`, root `/plan`, topic `/plan`, `/implement`, `/stop`, `/clear`, `/compact`, and `/cmd` behavior aligned with the approved spec.

- [ ] **Step 4: Run the bridge tests to verify they pass**

Run: `npm test -- packages/kirbot-core/tests/bridge.test.ts -v`
Expected: PASS for `General`/topic routing and command scope expectations

### Task 5: Make shared-topic UX explicit for multi-user sessions

**Files:**
- Modify: `packages/kirbot-core/src/bridge/presentation.ts`
- Modify: `packages/kirbot-core/src/bridge/requests.ts`
- Modify: `packages/kirbot-core/src/bridge.ts`
- Modify: `packages/kirbot-core/tests/presentation.test.ts`
- Modify: `packages/kirbot-core/tests/bridge.test.ts`

- [ ] **Step 1: Write failing presentation and bridge tests for actor attribution**

Add tests covering:
- queue preview includes the sender name or fallback user label for queued follow-ups
- shared-topic request copy no longer implies a single private user
- the workspace/thread-start footer explains `General` and `/thread`

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `npm test -- packages/kirbot-core/tests/presentation.test.ts packages/kirbot-core/tests/bridge.test.ts -v`
Expected: FAIL because queue previews and request text still use single-user/private-topic phrasing and do not surface actor attribution

- [ ] **Step 3: Implement minimal shared-session UX changes**

Add actor-aware queue rendering such as:

```ts
Queued for next turn:
- Jeremy: inspect the deploy logs
```

Update request/onboarding copy so it describes the dedicated workspace and shared-topic behavior instead of a private chat with one operator.

- [ ] **Step 4: Run the targeted tests to verify they pass**

Run: `npm test -- packages/kirbot-core/tests/presentation.test.ts packages/kirbot-core/tests/bridge.test.ts -v`
Expected: PASS

### Task 6: Update docs and remove private-chat product language

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/user-flows.md`
- Modify: `apps/bot/KIRBOT.md`

- [ ] **Step 1: Write the doc diffs to match the shipped behavior**

Update all product/setup docs so they describe:
- one dedicated private forum supergroup workspace
- `General` as the persistent root session
- `/thread` and root `/plan` topic creation from `General`
- shared sessions for all topic participants
- DM rejection/redirect behavior

- [ ] **Step 2: Review the changed docs for stale private-chat wording**

Check for stale phrases such as `private chat`, `allowed Telegram user`, `root chat plus topics`, and `one configured Telegram user`.

Run: `rg -n "private chat|configured Telegram user|allowed user|root chat plus topics|TELEGRAM_USER_ID" README.md docs apps/bot/KIRBOT.md packages/kirbot-core/src -S`
Expected: only intentional references remain, or zero matches after final cleanup

- [ ] **Step 3: Commit the doc-aligned migration**

```bash
git add README.md \
  docs/architecture.md \
  docs/user-flows.md \
  apps/bot/KIRBOT.md \
  packages/kirbot-core/src/config.ts \
  packages/kirbot-core/src/domain.ts \
  packages/kirbot-core/src/db.ts \
  packages/kirbot-core/src/runtime.ts \
  packages/kirbot-core/src/telegram-command-sync.ts \
  packages/kirbot-core/src/bridge.ts \
  packages/kirbot-core/src/bridge/presentation.ts \
  packages/kirbot-core/src/bridge/requests.ts \
  apps/bot/src/index.ts \
  packages/kirbot-core/tests/config.test.ts \
  apps/bot/tests/config.test.ts \
  packages/kirbot-core/tests/db.test.ts \
  packages/kirbot-core/tests/telegram-command-sync.test.ts \
  packages/kirbot-core/tests/presentation.test.ts \
  packages/kirbot-core/tests/bridge.test.ts \
  docs/superpowers/plans/2026-03-22-group-only-forum-supergroup.md
git commit -m "feat: migrate kirbot to forum supergroup workspace"
```

### Task 7: Run full verification before handoff

**Files:**
- Test: `packages/kirbot-core/tests/config.test.ts`
- Test: `apps/bot/tests/config.test.ts`
- Test: `packages/kirbot-core/tests/db.test.ts`
- Test: `packages/kirbot-core/tests/telegram-command-sync.test.ts`
- Test: `packages/kirbot-core/tests/presentation.test.ts`
- Test: `packages/kirbot-core/tests/bridge.test.ts`

- [ ] **Step 1: Run the focused migration test suite**

Run: `npm test -- packages/kirbot-core/tests/config.test.ts apps/bot/tests/config.test.ts packages/kirbot-core/tests/db.test.ts packages/kirbot-core/tests/telegram-command-sync.test.ts packages/kirbot-core/tests/presentation.test.ts packages/kirbot-core/tests/bridge.test.ts -v`
Expected: PASS

- [ ] **Step 2: Run project typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Run the full test suite if the targeted suite passes cleanly**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Record rollout caveats in the final handoff**

Document:
- required Telegram workspace setup for the private forum supergroup
- that DMs are intentionally unsupported
- any remaining unknowns around Telegram `General` topic normalization that were resolved in implementation or still need manual validation
