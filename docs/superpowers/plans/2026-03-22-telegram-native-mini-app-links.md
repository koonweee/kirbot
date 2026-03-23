# Telegram-Native Mini App Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace browser-opening artifact links with Telegram-native full-height Mini App launches that work in the workspace forum supergroup.

**Architecture:** Keep the existing deployed Mini App frontend, but stop encoding full artifact content into public HTTPS links for Telegram delivery. Instead, persist published artifacts behind short bridge-owned IDs, generate `t.me/<bot>?startapp=<id>` deep links for Telegram buttons, and let the Mini App load artifact content from Kirbot using the short ID. Preserve the existing public-URL codec only where it is still useful outside Telegram.

**Tech Stack:** TypeScript, grammy/Telegram Bot API, SQLite via existing Kirbot DB layer, SvelteKit Mini App frontend, Vitest

---

### Task 1: Define persisted Mini App artifact storage and deep-link codec

**Files:**
- Modify: `packages/kirbot-core/src/db.ts`
- Modify: `packages/kirbot-core/src/mini-app/url.ts`
- Modify: `packages/kirbot-core/tests/db.test.ts`
- Test: `packages/kirbot-core/tests/mini-app-url.test.ts`

- [ ] **Step 1: Write the failing tests**

Add tests that prove:
- short artifact IDs can be encoded into Telegram `startapp` deep links for `@kw_kirbot`
- oversized markdown artifacts are stored/retrieved via DB-backed IDs rather than URL fragments
- persisted artifacts can be loaded by ID after publication

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/kirbot-core/tests/mini-app-url.test.ts packages/kirbot-core/tests/db.test.ts`
Expected: FAIL because no Telegram deep-link builder or persisted mini-app artifact storage exists yet.

- [ ] **Step 3: Write minimal implementation**

Implement:
- a new DB table/repository for published Mini App artifacts keyed by a short ID
- Mini App URL helpers that build `https://t.me/kw_kirbot?startapp=<id>` links
- retrieval helpers that resolve an artifact by short ID

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/kirbot-core/tests/mini-app-url.test.ts packages/kirbot-core/tests/db.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/kirbot-core/src/db.ts \
  packages/kirbot-core/src/mini-app/url.ts \
  packages/kirbot-core/tests/db.test.ts \
  packages/kirbot-core/tests/mini-app-url.test.ts
git commit -m "feat: add persisted telegram mini app artifact links"
```

### Task 2: Publish Telegram artifact buttons using persisted deep links

**Files:**
- Modify: `packages/kirbot-core/src/bridge/presentation.ts`
- Modify: `packages/kirbot-core/src/bridge/turn-finalization.ts`
- Modify: `packages/kirbot-core/src/runtime.ts`
- Modify: `packages/kirbot-core/src/config.ts`
- Modify: `packages/kirbot-core/tests/presentation.test.ts`
- Modify: `packages/kirbot-core/tests/turn-lifecycle.test.ts`
- Modify: `packages/kirbot-core/tests/bridge.test.ts`
- Modify: `packages/telegram-harness/tests/harness.test.ts`

- [ ] **Step 1: Write the failing tests**

Add/update tests that prove:
- `Response`, `Commentary`, and `Plan` buttons use Telegram deep links instead of raw site URLs
- generated links point at `t.me/<bot>?startapp=...`
- link generation works for large artifacts without size-based browser fallback

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packages/kirbot-core/tests/presentation.test.ts packages/kirbot-core/tests/turn-lifecycle.test.ts packages/kirbot-core/tests/bridge.test.ts packages/telegram-harness/tests/harness.test.ts`
Expected: FAIL because presentation/finalization still assumes direct public URLs.

- [ ] **Step 3: Write minimal implementation**

Implement:
- config needed to know the bot username for Telegram deep links
- presentation/finalization wiring that persists artifacts, then builds Telegram-native deep links
- full-height Mini App launch defaults

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/kirbot-core/tests/presentation.test.ts packages/kirbot-core/tests/turn-lifecycle.test.ts packages/kirbot-core/tests/bridge.test.ts packages/telegram-harness/tests/harness.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/kirbot-core/src/bridge/presentation.ts \
  packages/kirbot-core/src/bridge/turn-finalization.ts \
  packages/kirbot-core/src/runtime.ts \
  packages/kirbot-core/src/config.ts \
  packages/kirbot-core/tests/presentation.test.ts \
  packages/kirbot-core/tests/turn-lifecycle.test.ts \
  packages/kirbot-core/tests/bridge.test.ts \
  packages/telegram-harness/tests/harness.test.ts
git commit -m "feat: launch artifact mini apps inside telegram"
```

### Task 3: Serve artifact content to the Mini App frontend

**Files:**
- Modify: `apps/bot/src/index.ts`
- Modify: `apps/plan-mini-app/src/routes/plan/+page.svelte`
- Modify: `apps/plan-mini-app/src/routes/+layout.ts` or owning fetch helper if needed
- Test: `apps/bot/tests/index.test.ts`
- Test: `packages/kirbot-core/tests/bridge.test.ts`

- [ ] **Step 1: Write the failing tests**

Add tests that prove:
- Kirbot exposes a read endpoint for Mini App artifacts by ID
- the Mini App can load the artifact from Telegram `startapp` context instead of URL hash payload

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- apps/bot/tests/index.test.ts packages/kirbot-core/tests/bridge.test.ts`
Expected: FAIL because no artifact fetch route/startapp load path exists.

- [ ] **Step 3: Write minimal implementation**

Implement:
- a bot-side HTTP/route surface or existing-server hook that returns stored artifacts by ID
- Mini App startup logic that reads the Telegram launch/startapp payload and loads the artifact

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- apps/bot/tests/index.test.ts packages/kirbot-core/tests/bridge.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/index.ts \
  apps/plan-mini-app/src/routes/plan/+page.svelte \
  apps/bot/tests/index.test.ts \
  packages/kirbot-core/tests/bridge.test.ts
git commit -m "feat: load telegram mini app artifacts by id"
```

### Task 4: Update docs and verify end-to-end behavior

**Files:**
- Modify: `README.md`
- Modify: `docs/user-flows.md`
- Modify: `docs/architecture.md`

- [ ] **Step 1: Write the failing documentation/test expectation**

Document the new invariant:
- forum-supergroup artifact buttons open inside Telegram as Mini Apps
- raw `TELEGRAM_MINI_APP_PUBLIC_URL` is the deployed app origin, not the Telegram button target

- [ ] **Step 2: Run repository checks**

Run: `npm test -- packages/kirbot-core/tests/presentation.test.ts packages/kirbot-core/tests/turn-lifecycle.test.ts packages/kirbot-core/tests/bridge.test.ts packages/telegram-harness/tests/harness.test.ts apps/bot/tests/index.test.ts packages/kirbot-core/tests/db.test.ts packages/kirbot-core/tests/mini-app-url.test.ts`
Expected: PASS after docs/behavior updates

- [ ] **Step 3: Build and run**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Manual verification**

Run:
- `npm run start:tmux:restart`
- Send a message in workspace `General`
- Tap `Response` / `Commentary` / `Plan`

Expected:
- Mini App opens inside Telegram in full-height mode
- artifact renders correctly
- no external browser opens

- [ ] **Step 5: Commit**

```bash
git add README.md docs/user-flows.md docs/architecture.md
git commit -m "docs: describe telegram-native mini app launches"
```
