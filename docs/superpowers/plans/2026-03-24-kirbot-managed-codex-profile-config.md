# Kirbot Managed Codex Profile Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace env-authored Codex profile JSON and bootstrap-only profile homes with a checked-in `config/codex-profiles.json` source of truth that fully manages per-profile `config.toml` and `skills/` on startup while preserving runtime state.

**Architecture:** Add a richer `codex-profiles.ts` layer that loads `config/codex-profiles.json`, validates route/profile/skill/MCP semantics, and derives each managed home under `dirname(DATABASE_PATH)/homes/<profile>`. Runtime will reconcile managed home contents before starting each gateway, generating a full `config.toml` and exact `skills/` subtree from the shared repo assets. Existing bridge/session routing stays profile-based, but config loading, home ownership, docs, and tests all shift to the new single-source-of-truth model.

**Tech Stack:** TypeScript, Vitest, Zod, Node filesystem APIs, SQLite via Kysely, Codex app-server RPC

---

## File Structure

**Create:**
- `config/codex-profiles.json`
- `skills/kirbot-skill-install/SKILL.md`
- `docs/superpowers/plans/2026-03-24-kirbot-managed-codex-profile-config.md`

**Modify:**
- `.env.example`
- `README.md`
- `apps/bot/KIRBOT.md`
- `apps/bot/tests/config.test.ts`
- `packages/kirbot-core/src/config.ts`
- `packages/kirbot-core/src/codex-profiles.ts`
- `packages/kirbot-core/src/codex-home.ts`
- `packages/kirbot-core/src/runtime.ts`
- `packages/kirbot-core/tests/config.test.ts`
- `packages/kirbot-core/tests/codex-home.test.ts`
- `packages/kirbot-core/tests/runtime.test.ts`

**Responsibilities:**
- `config/codex-profiles.json`: checked-in routes/profiles/shared skills/shared MCPs source of truth
- `config.ts`: load the config file path, derive data-dir-relative profile homes, and expose richer managed-profile config to runtime
- `codex-profiles.ts`: parse and semantically validate the JSON file, resolve repo-local skill paths, derive managed home paths, surface warnings
- `codex-home.ts`: reconcile managed `config.toml` and `skills/` while preserving runtime-owned state such as `auth.json`
- `runtime.ts`: validate + reconcile profile homes before gateway spawn, fail early on config errors, and emit warnings for unused assets
- docs and skill files: explain the new managed setup and direct agents away from editing generated profile-home skills

### Task 1: Replace Env JSON With Checked-In Profile Config

**Files:**
- Create: `config/codex-profiles.json`
- Modify: `packages/kirbot-core/src/config.ts`
- Modify: `packages/kirbot-core/src/codex-profiles.ts`
- Modify: `packages/kirbot-core/tests/config.test.ts`
- Modify: `apps/bot/tests/config.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write the failing config tests**

Add coverage that `loadConfig()` now:
- loads profile config from `config/codex-profiles.json` without `CODEX_PROFILES_JSON`
- derives homes under `dirname(DATABASE_PATH)/homes/<profile>`
- fails when required routes `general`, `thread`, or `plan` are missing
- fails when a route targets an undeclared profile
- fails when `routes.general` shares its profile with another route
- fails when a profile references a missing skill id or MCP key
- fails when a declared skill id has no `skills/<skill-id>/` directory
- fails when a referenced `skills/<skill-id>/SKILL.md` is missing
- fails when a profile uses an invalid model/sandbox/approval value
- fails on invalid JSON shape
- fails when generated home paths would collide
- warns when declared shared skills or MCPs are unused
- warns when stray folders exist under repo-local `skills/`

Use a checked-in fixture or temporary test config shaped like:

```json
{
  "routes": {
    "general": "chat",
    "thread": "coding",
    "plan": "coding"
  },
  "skills": {
    "brainstorming": {},
    "kirbot-skill-install": {}
  },
  "mcps": {
    "github": {
      "type": "stdio",
      "command": ["github-mcp", "serve"]
    }
  },
  "profiles": {
    "chat": {
      "model": "gpt-5",
      "sandboxMode": "workspace-write",
      "approvalPolicy": "on-request",
      "skills": [],
      "mcps": []
    },
    "coding": {
      "model": "gpt-5-codex",
      "sandboxMode": "danger-full-access",
      "approvalPolicy": "never",
      "skills": ["brainstorming", "kirbot-skill-install"],
      "mcps": ["github"]
    }
  }
}
```

- [ ] **Step 2: Run config-focused tests to verify failure**

Run: `npm test -- packages/kirbot-core/tests/config.test.ts apps/bot/tests/config.test.ts`

Expected: FAIL because the current loader still requires `CODEX_PROFILES_JSON` and the schema only understands explicit `homePath`.

- [ ] **Step 3: Implement the new config source and parser**

Update `packages/kirbot-core/src/config.ts` and `packages/kirbot-core/src/codex-profiles.ts` to:
- remove `CODEX_PROFILES_JSON` from required env
- locate `config/codex-profiles.json` from the repo root
- parse route/profile/skill/MCP config from disk
- derive each managed home as `resolve(dirname(databasePath), "homes", profileId)`
- preserve profile-based routing for the rest of the app
- validate sandbox and approval values against Codex-supported types
- surface warnings for unused declared skills, unused MCPs, and stray `skills/` folders

- [ ] **Step 4: Add the checked-in config and env example**

Create `config/codex-profiles.json` with the current deployment-default routing:
- `general` route -> dedicated general-chat profile
- `thread` and `plan` -> `coding`

Update `.env.example` to remove `CODEX_PROFILES_JSON` and explain that profile config now lives in `config/codex-profiles.json`.

- [ ] **Step 5: Run the config-focused tests again**

Run: `npm test -- packages/kirbot-core/tests/config.test.ts apps/bot/tests/config.test.ts`

Expected: PASS

- [ ] **Step 6: Commit the config-source slice**

```bash
git add config/codex-profiles.json .env.example apps/bot/tests/config.test.ts packages/kirbot-core/src/config.ts packages/kirbot-core/src/codex-profiles.ts packages/kirbot-core/tests/config.test.ts
git commit -m "feat: load managed codex profile config"
```

### Task 2: Reconcile Managed Profile Homes On Startup

**Files:**
- Modify: `packages/kirbot-core/src/codex-home.ts`
- Modify: `packages/kirbot-core/tests/codex-home.test.ts`

- [ ] **Step 1: Write the failing home-reconciliation tests**

Add coverage that home preparation now:
- creates the home directory if missing
- preserves existing `auth.json`
- copies `auth.json` from the base Codex home when the profile home lacks one
- writes a full managed `config.toml`
- writes the selected MCP definitions into the generated `config.toml`
- rebuilds managed `skills/` to match the declared subset exactly
- removes previously managed but now-undeclared skills
- preserves unmanaged directories such as `rules/`, `superpowers/`, and unrelated runtime files

Use exact expectations like:

```ts
expect(readFileSync(join(homePath, "config.toml"), "utf8")).toContain('model = "gpt-5-codex"');
expect(existsSync(join(homePath, "skills", "brainstorming"))).toBe(true);
expect(existsSync(join(homePath, "skills", "old-skill"))).toBe(false);
expect(readFileSync(join(homePath, "auth.json"), "utf8")).toBe('{"token":"abc"}');
```

- [ ] **Step 2: Run the home tests to verify failure**

Run: `npm test -- packages/kirbot-core/tests/codex-home.test.ts`

Expected: FAIL because the current helper only seeds missing files/directories and never rewrites `config.toml` or reconciles `skills/`.

- [ ] **Step 3: Implement managed-home reconciliation**

Refactor `packages/kirbot-core/src/codex-home.ts` so runtime can call a single helper that:
- accepts the derived home path, shared skill selections, and generated config payload
- preserves existing `auth.json` and seeds it from the base Codex home when missing
- rewrites the full `config.toml`
- rebuilds the managed `skills/` subtree from repo-local `skills/<skill-id>/`
- prefers symlinks and falls back to copy when necessary
- avoids touching unmanaged directories/files

Keep the boundary explicit in code comments: `config.toml` and `skills/` are Kirbot-managed; `rules/`, `superpowers/`, and runtime state are not.

- [ ] **Step 4: Run the home tests again**

Run: `npm test -- packages/kirbot-core/tests/codex-home.test.ts`

Expected: PASS

- [ ] **Step 5: Commit the home-management slice**

```bash
git add packages/kirbot-core/src/codex-home.ts packages/kirbot-core/tests/codex-home.test.ts
git commit -m "feat: reconcile managed codex profile homes"
```

### Task 3: Wire Managed Config Into Runtime Startup

**Files:**
- Modify: `packages/kirbot-core/src/runtime.ts`
- Modify: `packages/kirbot-core/tests/runtime.test.ts`

- [ ] **Step 1: Write the failing runtime tests**

Add runtime coverage that:
- config validation happens before any app-server spawn
- one gateway still spawns per profile
- each profile uses its derived data-dir-relative home
- managed home reconciliation runs before spawn
- unused-skill and unused-MCP warnings are logged without failing startup
- routed profile behavior still works after the config-source change, including
  persisted `profileId`-driven session routing

Include a failure case asserting no gateway starts when config validation fails.

- [ ] **Step 2: Run runtime tests to verify failure**

Run: `npm test -- packages/kirbot-core/tests/runtime.test.ts`

Expected: FAIL because runtime currently assumes precomputed `homePath` entries and only bootstraps missing `config.toml` via Codex.

- [ ] **Step 3: Update runtime startup flow**

Modify `packages/kirbot-core/src/runtime.ts` to:
- use the new managed profile config shape from `loadConfig()`
- validate and collect warnings before app-server initialization
- reconcile each managed home before spawn
- stop using `bootstrapManagedGlobalConfig()` as the source of truth for profile-global settings
- continue spawning one gateway per profile and routing through `RoutedCodexApi`

Update the runtime tests or adjacent bridge/router tests as needed so the plan
proves that profile routing continuity survives the config-source change.

- [ ] **Step 4: Run runtime tests again**

Run: `npm test -- packages/kirbot-core/tests/runtime.test.ts`

Expected: PASS

- [ ] **Step 5: Commit the runtime slice**

```bash
git add packages/kirbot-core/src/runtime.ts packages/kirbot-core/tests/runtime.test.ts
git commit -m "feat: start codex profiles from managed config"
```

### Task 4: Add Repo Guidance And Skill-Install Workflow

**Files:**
- Create: `skills/kirbot-skill-install/SKILL.md`
- Modify: `apps/bot/KIRBOT.md`
- Modify: `README.md`

- [ ] **Step 1: Write the failing doc/skill expectations**

Add a small test or snapshot only if there is an existing doc-validation hook. Otherwise skip new automated tests and verify these files directly in review:
- `README.md` explains `config/codex-profiles.json`, derived homes, and managed vs preserved home contents
- `apps/bot/KIRBOT.md` warns that profile-home `skills/` is generated and points agents to `kirbot-skill-install`
- `skills/kirbot-skill-install/SKILL.md` teaches agents to install shared skills under `skills/<skill-id>/` and enable them in `config/codex-profiles.json`

- [ ] **Step 2: Add the new skill and guidance**

Create `skills/kirbot-skill-install/SKILL.md` covering:
- shared skill source location
- profile enablement through `config/codex-profiles.json`
- prohibition on editing `data/homes/<profile>/skills/`
- expectation that startup sync materializes managed skills into each profile home

Update `README.md` and `apps/bot/KIRBOT.md` to reflect the new config source, managed homes, and generated skills behavior.

- [ ] **Step 3: Manually review the docs/skill files**

Verify that the new docs are consistent with the approved spec and do not mention the old `CODEX_PROFILES_JSON` flow as primary guidance.

- [ ] **Step 4: Commit the guidance slice**

```bash
git add README.md apps/bot/KIRBOT.md skills/kirbot-skill-install/SKILL.md
git commit -m "docs: document managed codex profile setup"
```

### Task 5: Run Full Verification And Cleanup

**Files:**
- Modify as needed based on failures from previous tasks

- [ ] **Step 1: Run focused regression suites**

Run:

```bash
npm test -- packages/kirbot-core/tests/config.test.ts apps/bot/tests/config.test.ts packages/kirbot-core/tests/codex-home.test.ts packages/kirbot-core/tests/runtime.test.ts
```

Expected: PASS

- [ ] **Step 2: Run the full repository verification**

Run:

```bash
npm test
npm run typecheck
npm run build
```

Expected: all commands exit 0

- [ ] **Step 3: Review the final diff for managed-config correctness**

Check:
- no remaining production references to `CODEX_PROFILES_JSON`
- `config/codex-profiles.json` is the documented source of truth
- runtime still routes `General` and topic sessions by persisted `profileId`
- unrelated `package-lock.json` changes remain untouched

- [ ] **Step 4: Commit any final cleanup**

```bash
git add <final touched files>
git commit -m "fix: polish managed codex profile config"
```
