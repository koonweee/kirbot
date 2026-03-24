# Kirbot Profile Home Mirror Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each Kirbot Codex profile run with an isolated profile-local `HOME`/`CODEX_HOME` that mirrors most top-level entries from the real user home while excluding codex-related top-level entries such as `.codex` and `.agents`.

**Architecture:** Extend profile-home reconciliation in `packages/kirbot-core/src/codex-home.ts` so a real profile home is rebuilt as a top-level symlink mirror of the real home with a hard exclusion for codex-related top-level entries such as `.codex` and `.agents`, then layer the existing Kirbot-managed Codex boundary on top of that home. Update the Codex app-server spawn environment in `packages/codex-client/src/codex.ts` so the spawned process uses the profile home for both `HOME` and `CODEX_HOME`, which removes access to the real `~/.codex` while preserving shared access to other home-scoped state through live symlinks.

**Tech Stack:** TypeScript, Node filesystem APIs, Vitest, Codex app-server RPC

---

## File Structure

**Create:**
- `docs/superpowers/plans/2026-03-24-kirbot-home-mirror.md`

**Modify:**
- `packages/kirbot-core/src/codex-home.ts`
- `packages/kirbot-core/tests/codex-home.test.ts`
- `packages/codex-client/src/codex.ts`
- `packages/codex-client/tests/codex.test.ts`
- `README.md`
- `apps/bot/KIRBOT.md`

**Responsibilities:**
- `packages/kirbot-core/src/codex-home.ts`: reconcile top-level home mirroring, exclude codex-related top-level entries such as `.codex` and `.agents`, keep managed Codex boundary explicit, and seed profile-local `auth.json` from the real home’s `.codex/auth.json`
- `packages/kirbot-core/tests/codex-home.test.ts`: pin mirror semantics, managed-boundary precedence, stale mirror cleanup, and auth seeding
- `packages/codex-client/src/codex.ts`: set both `HOME` and `CODEX_HOME` for spawned Codex app-server processes
- `packages/codex-client/tests/codex.test.ts`: pin spawn environment behavior for profile homes
- `README.md` and `apps/bot/KIRBOT.md`: document mirror semantics, codex-related top-level exclusions, and restart-vs-live-reflection behavior

### Task 1: Pin Mirror Reconciliation Semantics In Tests

**Files:**
- Modify: `packages/kirbot-core/tests/codex-home.test.ts`

- [ ] **Step 1: Write the failing mirror tests**

Add tests that describe the new profile-home contract:

```ts
it("mirrors top-level home entries while excluding codex-related state", () => {
  fs.mkdirSync(join(sourceHome, ".ssh"), { recursive: true });
  fs.writeFileSync(join(sourceHome, ".gitconfig"), "[user]\n\tname = Jeremy\n");
  fs.mkdirSync(join(sourceHome, ".codex"), { recursive: true });
  fs.writeFileSync(join(sourceHome, ".codex", "auth.json"), '{"token":"abc"}');
  fs.mkdirSync(join(sourceHome, ".agents", "skills"), { recursive: true });
  fs.symlinkSync(join(sourceHome, ".codex", "superpowers", "skills"), join(sourceHome, ".agents", "skills", "superpowers"), "dir");

  prepareKirbotCodexHome({
    sourceHomePath: sourceHome,
    targetHomePath: targetHome,
    managed: {
      managedConfigToml: 'model = "gpt-5-codex"\n',
      managedSkillIds: ["kirbot-skill-install"],
      managedProfilesConfigPath: join(repoRoot, "config", "codex-profiles.json")
    }
  });

  expect(fs.lstatSync(join(targetHome, ".ssh")).isSymbolicLink()).toBe(true);
  expect(fs.lstatSync(join(targetHome, ".gitconfig")).isSymbolicLink()).toBe(true);
  expect(fs.existsSync(join(targetHome, ".codex"))).toBe(false);
  expect(fs.existsSync(join(targetHome, ".agents"))).toBe(false);
  expect(fs.readFileSync(join(targetHome, "auth.json"), "utf8")).toBe('{"token":"abc"}');
});
```

Add a second test that stale mirrored entries are removed on reconcile but runtime-owned Codex directories survive:

```ts
expect(fs.existsSync(join(targetHome, ".obsolete"))).toBe(false);
expect(fs.readFileSync(join(targetHome, "sessions", "keep.txt"), "utf8")).toBe("keep");
expect(fs.readFileSync(join(targetHome, "shell_snapshots", "keep.txt"), "utf8")).toBe("keep");
```

Add a third test that managed Codex paths win over mirrored home entries:

```ts
fs.mkdirSync(join(sourceHome, "skills", "wrong-skill"), { recursive: true });
prepareKirbotCodexHome(...);
expect(fs.readFileSync(join(targetHome, "skills", "kirbot-skill-install", "SKILL.md"), "utf8")).toContain("kirbot-skill-install");
```

- [ ] **Step 2: Run the home tests to verify failure**

Run: `npm test -- packages/kirbot-core/tests/codex-home.test.ts`

Expected: FAIL because `prepareKirbotCodexHome()` currently treats `sourceHomePath` as a Codex home root, does not mirror top-level home entries, does not remove stale mirrored entries, and does not exclude codex-related top-level entries.

- [ ] **Step 3: Commit the red test slice**

```bash
git add packages/kirbot-core/tests/codex-home.test.ts
git commit -m "test: cover kirbot profile home mirroring"
```

### Task 2: Implement Top-Level Home Mirroring And Codex-Related Exclusions

**Files:**
- Modify: `packages/kirbot-core/src/codex-home.ts`
- Modify: `packages/kirbot-core/tests/codex-home.test.ts`

- [ ] **Step 1: Implement a tracked top-level mirror reconcile**

Refactor `prepareKirbotCodexHome()` so `sourceHomePath` means the real home root, defaulting to `homedir()`.

Add helper structure like:

```ts
const MIRROR_EXCLUDED_TOP_LEVEL_NAMES = new Set([".agents", ".codex"]);
const MANAGED_LOCAL_TOP_LEVEL_NAMES = new Set([
  "auth.json",
  "config.toml",
  "skills",
  "sessions",
  "shell_snapshots",
  "tmp",
  "rules",
  "superpowers"
]);
const MIRROR_MANIFEST_FILE = ".kirbot-managed-home-mirror.json";
```

Implement a reconcile flow that:
- reads top-level entries from `sourceHomePath`
- creates symlinks in `targetHomePath` for entries not in the exclusion set and not reserved for Kirbot/Codex-local ownership
- records the mirrored entry names in a manifest file under the target home
- removes stale previously mirrored top-level symlinks on the next reconcile
- never removes or rewrites runtime-owned Codex directories like `sessions/`, `shell_snapshots/`, `tmp/`, `rules/`, or `superpowers/`

- [ ] **Step 2: Seed `auth.json` from the real home’s `.codex`**

Update auth seeding so the source becomes:

```ts
seedAuthJsonIfMissing(join(sourceHomePath, ".codex"), targetHomePath);
```

That preserves current Codex auth bootstrap behavior while keeping codex-related top-level state out of the mirror.

- [ ] **Step 3: Keep the managed Codex boundary layered on top**

After mirror reconcile:
- rewrite managed `config.toml`
- rebuild managed `skills/`
- preserve runtime-owned state

Add or update comments so the ownership boundary is explicit:

```ts
// Kirbot mirrors most top-level home entries by symlink, but codex-related
// homes such as `.codex` and `.agents` are excluded.
// Inside the profile home, `config.toml` and `skills/` are Kirbot-managed,
// while `sessions/`, `shell_snapshots/`, `tmp/`, `rules/`, and `superpowers/`
// remain runtime-owned.
```

- [ ] **Step 4: Run the home tests again**

Run: `npm test -- packages/kirbot-core/tests/codex-home.test.ts`

Expected: PASS

- [ ] **Step 5: Commit the mirror implementation slice**

```bash
git add packages/kirbot-core/src/codex-home.ts packages/kirbot-core/tests/codex-home.test.ts
git commit -m "feat: mirror home entries into profile homes"
```

### Task 3: Make Spawned Codex Processes Use The Profile Home As `HOME`

**Files:**
- Modify: `packages/codex-client/tests/codex.test.ts`
- Modify: `packages/codex-client/src/codex.ts`

- [ ] **Step 1: Write the failing spawn-env test**

Tighten the existing environment test so the spawned app-server environment uses the profile home for both variables:

```ts
it("sets HOME and CODEX_HOME to the profile home when requested", () => {
  const env = buildAppServerSpawnEnv(
    {
      HOME: "/home/dev",
      PATH: "/usr/bin"
    },
    "/srv/kirbot/data/homes/coding"
  );

  expect(env).toMatchObject({
    HOME: "/srv/kirbot/data/homes/coding",
    PATH: "/usr/bin",
    CODEX_HOME: "/srv/kirbot/data/homes/coding"
  });
});
```

- [ ] **Step 2: Run the codex-client tests to verify failure**

Run: `npm test -- packages/codex-client/tests/codex.test.ts`

Expected: FAIL because `buildAppServerSpawnEnv()` currently preserves the parent `HOME` and only adds `CODEX_HOME`.

- [ ] **Step 3: Implement the spawn-env change**

Update `buildAppServerSpawnEnv()` so a provided profile home path overrides both environment keys:

```ts
return {
  ...env,
  ...(homePath ? { HOME: homePath, CODEX_HOME: homePath } : {})
};
```

- [ ] **Step 4: Run the codex-client tests again**

Run: `npm test -- packages/codex-client/tests/codex.test.ts`

Expected: PASS

- [ ] **Step 5: Commit the spawn-env slice**

```bash
git add packages/codex-client/src/codex.ts packages/codex-client/tests/codex.test.ts
git commit -m "feat: isolate codex app-server home"
```

### Task 4: Document Mirror Semantics And Verify The Real Behavior

**Files:**
- Modify: `README.md`
- Modify: `apps/bot/KIRBOT.md`

- [ ] **Step 1: Document the mirror rules**

Update docs to state:
- profile homes mirror most top-level real-home entries by symlink
- codex-related top-level entries such as `.codex` and `.agents` are excluded and remain profile-local
- changes inside already-mirrored paths reflect immediately
- new or removed top-level real-home entries require Kirbot restart/reconcile

Use wording along these lines:

```md
- Kirbot profile homes mirror most top-level entries from the runtime user's home by symlink.
- codex-related top-level entries such as `~/.codex` and `~/.agents` are excluded from that mirror and remain isolated per profile.
- Changes inside already-mirrored paths are visible immediately through the symlink.
- New or removed top-level home entries are picked up on Kirbot restart.
```

- [ ] **Step 2: Run targeted tests and the live behavior probe**

Run:

```bash
npm test -- packages/kirbot-core/tests/codex-home.test.ts packages/codex-client/tests/codex.test.ts
```

Expected: PASS

Run:

```bash
node - <<'EOF'
const { spawnCodexAppServer, CodexRpcClient, StdioRpcTransport } = require('./packages/codex-client/dist');

(async () => {
  const app = await spawnCodexAppServer({ homePath: '/home/dev/kirbot/apps/bot/data/homes/coding' });
  const transport = new StdioRpcTransport(app.process);
  const client = new CodexRpcClient(transport);
  try {
    await transport.connect();
    await client.initialize({
      clientInfo: { name: 'verify-home-mirror', title: 'verify-home-mirror', version: '0.1.0' },
      capabilities: { experimentalApi: true }
    });
    const res = await client.call('skills/list', {
      cwds: ['/home/dev/kirbot/apps/bot'],
      forceReload: true
    });
    console.log(res.data[0].skills.map((skill) => skill.path).join('\n'));
  } finally {
    await client.close();
    await app.stop();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
EOF
```

Expected:
- no `/home/dev/.codex/superpowers/...` paths in the output
- no skill discovery through `/home/dev/.agents/skills/...` when that tree points back into `~/.codex`
- profile-managed/system skills still present

- [ ] **Step 3: Commit docs and verification-ready state**

```bash
git add README.md apps/bot/KIRBOT.md
git commit -m "docs: describe kirbot home mirroring"
```

### Task 5: Final End-To-End Verification

**Files:**
- Modify: `packages/kirbot-core/src/codex-home.ts`
- Modify: `packages/kirbot-core/tests/codex-home.test.ts`
- Modify: `packages/codex-client/src/codex.ts`
- Modify: `packages/codex-client/tests/codex.test.ts`
- Modify: `README.md`
- Modify: `apps/bot/KIRBOT.md`

- [ ] **Step 1: Run the full focused verification set**

Run:

```bash
npm test -- packages/kirbot-core/tests/codex-home.test.ts packages/codex-client/tests/codex.test.ts packages/kirbot-core/tests/runtime.test.ts
```

Expected: PASS

- [ ] **Step 2: Inspect the final diff**

Run:

```bash
git diff -- packages/kirbot-core/src/codex-home.ts packages/kirbot-core/tests/codex-home.test.ts packages/codex-client/src/codex.ts packages/codex-client/tests/codex.test.ts README.md apps/bot/KIRBOT.md
```

Expected: only the mirror, env, and documentation changes described in the spec

- [ ] **Step 3: Commit the final integration checkpoint if needed**

```bash
git add packages/kirbot-core/src/codex-home.ts packages/kirbot-core/tests/codex-home.test.ts packages/codex-client/src/codex.ts packages/codex-client/tests/codex.test.ts README.md apps/bot/KIRBOT.md
git commit -m "feat: isolate kirbot codex homes from ~/.codex"
```
