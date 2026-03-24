# Kirbot Multi-Profile Codex Home Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Kirbot's single isolated Codex home plus shared-home fallback with multiple isolated profile-specific Codex homes, with `General` on `general`, `/thread` and `/plan` on `coding`, and persisted profile-based routing for all session activity.

**Architecture:** Add explicit profile configuration and persist `profile_id` on sessions. Runtime will spawn one gateway per configured profile, the bridge will choose a profile at session creation time and re-register persisted thread routes on resume, and the legacy shared-home fallback path will be removed entirely. Chat-level defaults will move from `root`/`spawn` buckets to profile-aware defaults so new sessions seed their settings from the selected profile.

**Tech Stack:** TypeScript, Vitest, Zod config parsing, SQLite via Kysely, Codex app-server RPC

---

## File Structure

**Create:**
- `packages/kirbot-core/src/codex-profiles.ts`
- `packages/kirbot-core/tests/runtime.test.ts`
- `docs/superpowers/plans/2026-03-24-kirbot-multi-profile-codex-home.md`

**Modify:**
- `packages/kirbot-core/src/config.ts`
- `packages/kirbot-core/src/domain.ts`
- `packages/kirbot-core/src/db.ts`
- `packages/kirbot-core/src/runtime.ts`
- `packages/kirbot-core/src/routed-codex.ts`
- `packages/kirbot-core/src/bridge.ts`
- `packages/kirbot-core/src/index.ts`
- `packages/kirbot-core/tests/config.test.ts`
- `packages/kirbot-core/tests/db.test.ts`
- `packages/kirbot-core/tests/routed-codex.test.ts`
- `packages/kirbot-core/tests/bridge.test.ts`
- `.env.example`
- `README.md`

**Responsibilities:**
- `codex-profiles.ts`: profile ids, routing targets, config schema/helpers, and route-selection helpers shared by config/runtime/bridge
- `config.ts`: parse the new JSON profile config and expose it through `AppConfig`
- `domain.ts` and `db.ts`: persist session `profileId` and profile-aware chat defaults
- `runtime.ts` and `routed-codex.ts`: spawn one gateway per profile, remove shared fallback, and route by declared profile id
- `bridge.ts`: select profiles for `General`, `/thread`, and `/plan`; seed defaults from the selected profile; surface first-resume failure for old legacy sessions
- tests: prove config parsing, DB migration/default behavior, profile routing, bridge session creation, and legacy-failure behavior

### Task 1: Add Profile Configuration And Types

**Files:**
- Create: `packages/kirbot-core/src/codex-profiles.ts`
- Modify: `packages/kirbot-core/src/config.ts`
- Modify: `packages/kirbot-core/src/index.ts`
- Modify: `packages/kirbot-core/tests/config.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write the failing config tests**

Add expectations that `loadConfig()` accepts one JSON profile config and rejects:
- missing required routes for `general`, `thread`, or `plan`
- a routing target that references an undeclared profile
- a profile without `homePath`

Use a fixture shaped like:

```ts
CODEX_PROFILES_JSON: JSON.stringify({
  profiles: {
    general: { homePath: "/srv/kirbot/codex-home-general" },
    coding: { homePath: "/srv/kirbot/codex-home-coding" }
  },
  routing: {
    general: "general",
    thread: "coding",
    plan: "coding"
  }
})
```

- [ ] **Step 2: Run the config tests to confirm failure**

Run: `npm test -- packages/kirbot-core/tests/config.test.ts`

Expected: FAIL because the current config parser still expects `CODEX_HOME_PATH` and has no profile schema.

- [ ] **Step 3: Add `codex-profiles.ts` and wire config parsing**

Implement a focused helper module that exports:

```ts
export type CodexProfileId = string;
export type CodexProfilesConfig = {
  profiles: Record<string, { homePath: string }>;
  routing: {
    general: string;
    thread: string;
    plan: string;
    [entrypoint: string]: string;
  };
};
```

Then update `config.ts` to:
- replace `CODEX_HOME_PATH` with `CODEX_PROFILES_JSON`
- parse the JSON with Zod
- expose `config.codex.profiles` and `config.codex.routing`
- stop exposing a single `homePath`

- [ ] **Step 4: Update the example env file**

Replace the old single-home example with a multi-profile JSON example and keep the bootstrap note scoped to profile homes.

- [ ] **Step 5: Run the config tests again**

Run: `npm test -- packages/kirbot-core/tests/config.test.ts`

Expected: PASS

- [ ] **Step 6: Commit the config slice**

Run:

```bash
git add packages/kirbot-core/src/codex-profiles.ts packages/kirbot-core/src/config.ts packages/kirbot-core/src/index.ts packages/kirbot-core/tests/config.test.ts .env.example
git commit -m "feat: add Kirbot Codex profile config"
```

### Task 2: Persist Session Profiles And Profile Defaults

**Files:**
- Modify: `packages/kirbot-core/src/domain.ts`
- Modify: `packages/kirbot-core/src/db.ts`
- Modify: `packages/kirbot-core/tests/db.test.ts`

- [ ] **Step 1: Write the failing DB tests**

Add coverage for:
- provisioning a root session with `profileId: "general"`
- provisioning a topic session with `profileId: "coding"`
- storing and loading `profileId` on active sessions
- profile-aware defaults stored by `(telegram_chat_id, profile_id)`
- migration from existing `chat_thread_defaults.root` to `general` and `chat_thread_defaults.spawn` to `coding`

Use exact expectations such as:

```ts
expect(session.profileId).toBe("coding");
expect(defaults.profileId).toBe("general");
```

- [ ] **Step 2: Run the DB tests to confirm failure**

Run: `npm test -- packages/kirbot-core/tests/db.test.ts`

Expected: FAIL because the current session schema has no `profile_id` and defaults are still `root`/`spawn`.

- [ ] **Step 3: Update the domain model and DB layer**

Implement:
- `profileId` on `BridgeSession` and `TopicSession`
- `createProvisioningSession()` requiring a profile id
- a new `chat_profile_defaults` table keyed by `telegram_chat_id` and `profile_id`
- a schema version bump from V8 to V9
- a new `#migrateFromV8ToV9()` path in `packages/kirbot-core/src/db.ts`
- migration logic that seeds:
  - `general` defaults from old `chat_thread_defaults.root`
  - `coding` defaults from old `chat_thread_defaults.spawn`

Keep the session surface split (`general` vs `topic`) unchanged.

- [ ] **Step 4: Replace the old defaults helpers**

Add DB methods shaped like:

```ts
getChatProfileDefaults(chatId: string, profileId: string)
upsertChatProfileDefaults(chatId: string, profileId: string, settings: PersistedThreadSettings)
```

Leave old `chat_thread_defaults` reads only in migration code.

- [ ] **Step 5: Run the DB tests again**

Run: `npm test -- packages/kirbot-core/tests/db.test.ts`

Expected: PASS

- [ ] **Step 6: Commit the persistence slice**

Run:

```bash
git add packages/kirbot-core/src/domain.ts packages/kirbot-core/src/db.ts packages/kirbot-core/tests/db.test.ts
git commit -m "feat: persist Kirbot session profiles"
```

### Task 3: Replace Shared/Isolated Routing With Profile Routing

**Files:**
- Modify: `packages/kirbot-core/src/bridge.ts`
- Modify: `packages/kirbot-core/src/routed-codex.ts`
- Modify: `packages/kirbot-core/src/runtime.ts`
- Modify: `packages/kirbot-core/tests/routed-codex.test.ts`
- Create: `packages/kirbot-core/tests/runtime.test.ts`

- [ ] **Step 1: Write the failing router and runtime tests**

Update `routed-codex.test.ts` to assert:
- `createThread("coding", ...)` creates on the `coding` gateway
- request/event routing is retained per profile
- unknown thread ids do not probe a second gateway

Add `runtime.test.ts` to assert:
- one app-server is spawned per configured profile
- each spawn receives the expected `homePath`
- no shared-home gateway is started

- [ ] **Step 2: Run the router and runtime tests to confirm failure**

Run: `npm test -- packages/kirbot-core/tests/routed-codex.test.ts packages/kirbot-core/tests/runtime.test.ts`

Expected: FAIL because the current router is hardcoded to `shared` and `isolated`, and runtime still starts both.

- [ ] **Step 3: Generalize `RoutedCodexApi` to profile gateways**

Refactor the router to own:

```ts
gateways: Record<string, BridgeCodexApi>
threadRoutes: Map<string, string>
requestRoutes: Map<RequestId, string>
```

Expose explicit profile-aware entry points:
- `createThread(profileId, title, options)`
- `readProfileSettings(profileId)`
- `updateProfileSettings(profileId, update)`
- `registerThreadProfile(threadId, profileId)`

Update the `BridgeCodexApi` interface in `packages/kirbot-core/src/bridge.ts` at the same time so the router and bridge stay type-aligned.

Keep thread/request operations single-route only. If a route is missing or wrong, fail immediately.

- [ ] **Step 4: Update runtime to spawn one gateway per profile**

For each configured profile:
- prepare the profile home
- bootstrap managed global config if its `config.toml` does not yet exist
- spawn a dedicated app-server for that home

Delete the special shared-home startup path completely.

- [ ] **Step 5: Run the router and runtime tests again**

Run: `npm test -- packages/kirbot-core/tests/routed-codex.test.ts packages/kirbot-core/tests/runtime.test.ts`

Expected: PASS

- [ ] **Step 6: Commit the routing slice**

Run:

```bash
git add packages/kirbot-core/src/routed-codex.ts packages/kirbot-core/src/runtime.ts packages/kirbot-core/tests/routed-codex.test.ts packages/kirbot-core/tests/runtime.test.ts
git commit -m "feat: route Kirbot Codex traffic by profile"
```

### Task 4: Make The Bridge Profile-Aware

**Files:**
- Modify: `packages/kirbot-core/src/bridge.ts`
- Modify: `packages/kirbot-core/tests/bridge.test.ts`

- [ ] **Step 1: Write the failing bridge tests**

Add or update expectations for:
- first `General` message creating a session with `profileId = "general"`
- `/thread` creating a topic session with `profileId = "coding"`
- `/plan` creating a topic session with `profileId = "coding"` and preferred mode `plan`
- profile-aware defaults seeded from `readProfileSettings(profileId)`
- a persisted legacy session whose thread cannot be loaded surfacing a clear failure message on first resume

Use focused assertions such as:

```ts
expect(createdSession.profileId).toBe("coding");
expect(fakeCodex.createThreadCalls[0]?.profileId).toBe("general");
expect(topicMessages.at(-1)?.text).toContain("removed legacy Codex home");
```

- [ ] **Step 2: Run the bridge tests to confirm failure**

Run: `npm test -- packages/kirbot-core/tests/bridge.test.ts`

Expected: FAIL because the bridge still creates root/topic sessions without a persisted profile and still depends on `root`/`spawn` defaults.

- [ ] **Step 3: Route session creation by configured profile**

Update the bridge so that:
- root session creation resolves `config.codex.routing.general`
- `/thread` resolves `config.codex.routing.thread`
- `/plan` resolves `config.codex.routing.plan`

Pass the resolved `profileId` into provisioning and `createThread(profileId, ...)`.

- [ ] **Step 4: Replace `root`/`spawn` defaults reads with profile defaults**

Refactor helpers like `getChatThreadSettingsDefaults()` into profile-aware helpers, for example:

```ts
getChatProfileDefaults(chatId, profileId)
updateChatProfileDefaults(chatId, profileId, update)
```

When defaults for a profile do not exist yet, seed them from `codex.readProfileSettings(profileId)`.

- [ ] **Step 5: Centralize persisted thread route registration**

Add one bridge helper that registers `session.codexThreadId -> session.profileId` before any thread-scoped Codex operation. Use it for:
- `ensureThreadLoaded()`
- `sendTurn()`
- `readThread()`
- `readTurnSnapshot()`
- `compactThread()`
- `archiveThread()`
- persisted settings hydration paths that call `ensureThreadLoaded()`

The goal is one reusable entry point rather than scattered ad hoc route registration.

- [ ] **Step 6: Add the first-resume failure message**

When a persisted session fails to load because its old thread does not exist in the selected profile home, send a concise Telegram message telling the user the session belonged to a removed legacy Codex home and should be restarted in a new thread/topic.

- [ ] **Step 7: Run the bridge tests again**

Run: `npm test -- packages/kirbot-core/tests/bridge.test.ts`

Expected: PASS

- [ ] **Step 8: Commit the bridge slice**

Run:

```bash
git add packages/kirbot-core/src/bridge.ts packages/kirbot-core/tests/bridge.test.ts
git commit -m "feat: make Kirbot bridge profile-aware"
```

### Task 5: Remove Legacy Docs And Finish User-Facing Config

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `packages/kirbot-core/tests/config.test.ts`
- Modify: `packages/kirbot-core/tests/routed-codex.test.ts`

- [ ] **Step 1: Write the failing doc-facing expectations if missing**

If there are no existing assertions for env-example or README content, add narrow string assertions in the relevant config/router tests where practical to guard the old names from reappearing:
- no mention of `CODEX_HOME_PATH`
- no mention of shared-home legacy fallback as a supported path

- [ ] **Step 2: Update README for multi-profile setup**

Document:
- the `CODEX_PROFILES_JSON` format
- `general` versus `coding` routing
- one isolated home per profile
- hard cutover behavior for old sessions

- [ ] **Step 3: Clean the example env file and router tests**

Ensure examples, names, and test fixtures no longer reference the shared/isolated pair or the old single-home config.

- [ ] **Step 4: Run the affected documentation-adjacent tests**

Run: `npm test -- packages/kirbot-core/tests/config.test.ts packages/kirbot-core/tests/routed-codex.test.ts`

Expected: PASS

- [ ] **Step 5: Commit the docs and cleanup slice**

Run:

```bash
git add README.md .env.example packages/kirbot-core/tests/config.test.ts packages/kirbot-core/tests/routed-codex.test.ts
git commit -m "docs: describe Kirbot multi-profile Codex homes"
```

### Task 6: Final Verification

**Files:**
- Modify: none

- [ ] **Step 1: Run the full affected test suite**

Run:

```bash
npm test -- packages/kirbot-core/tests/config.test.ts packages/kirbot-core/tests/db.test.ts packages/kirbot-core/tests/routed-codex.test.ts packages/kirbot-core/tests/runtime.test.ts packages/kirbot-core/tests/bridge.test.ts
```

Expected: PASS

- [ ] **Step 2: Run the repo typecheck**

Run: `npm run typecheck`

Expected: PASS

- [ ] **Step 3: Build the repo**

Run: `npm run build`

Expected: PASS

- [ ] **Step 4: Review the working tree**

Run: `git status --short`

Expected: only the intended multi-profile routing changes are present.
