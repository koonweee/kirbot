# Kirbot Profile Home Mirror Design

Date: 2026-03-24

## Summary

Kirbot will keep one real home directory per Codex profile and use that same
path for both `HOME` and `CODEX_HOME` when spawning the profile's Codex
app-server.

Each profile home will mirror most top-level entries from the real user home by
symlink, while explicitly excluding codex-related entries such as `.codex` and
`.agents`.

This gives profile processes normal access to shared home-scoped user state,
while keeping Codex-specific state isolated per profile.

## Goals

- keep Codex profile state isolated per profile
- stop Codex from discovering skills under the real `~/.codex`
- preserve broad access to normal home-scoped user config and credentials
- make profile home behavior explicit and reproducible on Kirbot startup
- document when live symlinks reflect changes immediately and when restart is
  required

## Non-Goals

- recursively inspect arbitrary mirrored directories for codex-related content
- recursively manage the contents of mirrored directories
- add a manual resync command in v1
- make profile homes fully disposable

## Problem

Kirbot currently sets `CODEX_HOME` for spawned Codex app-server processes, but
it leaves `HOME` pointing at the real user home.

That allows Codex skill discovery to continue reading the real `~/.codex`,
including `~/.codex/superpowers`, even when the profile's `CODEX_HOME` points at
an isolated managed profile home.

## Design

### Profile Home Model

For each profile, Kirbot already derives a managed profile home under:

- `dirname(DATABASE_PATH)/homes/<profile>`

That directory remains the canonical profile home.

Kirbot will now treat it as:

- the profile's `HOME`
- the profile's `CODEX_HOME`

When spawning the Codex app-server for a profile, Kirbot will set both
environment variables to that profile home path.

### Mirror Source

The mirror source is the real user home of the Kirbot runtime process.

In the current deployment that is `/home/dev`.

The implementation should resolve that source from the runtime environment or
OS home resolution used by Kirbot, rather than hardcoding `/home/dev`.

### Mirror Scope

Kirbot will mirror only top-level entries from the source home into each
profile home.

Example source entries:

- `.ssh`
- `.gitconfig`
- `.config`
- `.local`
- `screenshots`

Kirbot will not recursively manage the contents of those directories. The
top-level symlink is the unit of mirroring.

### Exclusion Rule

Kirbot will always exclude codex-related top-level entries, including:

- `.agents`
- `.codex`

The purpose of this exclusion is to prevent Codex-specific state from leaking
from the real user home into profile homes, including alternate discovery roots
such as `$HOME/.agents/skills`.

### Codex Boundary Inside Profile Homes

Inside each profile home, Kirbot will continue to manage the same Codex-owned
boundary it manages today:

- `config.toml`
- `skills/`
- `auth.json` seeding behavior

Codex runtime-owned state inside the profile home remains preserved:

- `sessions/`
- `shell_snapshots/`
- `tmp/`
- `rules/`
- `superpowers/`
- other runtime-created files

This means the profile home is a mixed directory:

- some top-level paths are mirrored from the real home
- some top-level paths are Codex-local and profile-specific

### Ownership Rule

Kirbot owns:

- the existence of the profile home
- mirror reconciliation at the top level
- exclusion of codex-related top-level entries
- managed Codex files and directories it already owns

Kirbot does not own:

- the internals of mirrored directories
- Codex runtime-created session data inside the profile home

If a top-level mirrored path would conflict with a Kirbot-owned path, the
Kirbot-owned path wins.

The main intentional conflicts are codex-related entries such as `.codex` and
`.agents`, which are not mirrored.

## Reconciliation Semantics

Kirbot will reconcile the profile-home mirror on startup.

Expected startup behavior:

1. ensure the profile home exists
2. reconcile mirrored top-level home entries from the real home
3. exclude codex-related top-level entries from that mirror
4. reconcile Kirbot-managed Codex files inside the profile home
5. spawn the profile's Codex app-server with `HOME` and `CODEX_HOME` both set
   to that profile home

### Immediate Reflection Versus Restart

Once a top-level path is mirrored by symlink, changes inside that path reflect
immediately because the symlink points at the live source path.

Examples:

- edits inside `/home/dev/.ssh` are immediately visible through the mirrored
  profile-home `.ssh` symlink
- edits inside `/home/dev/.config` are immediately visible through the mirrored
  profile-home `.config` symlink

Restart is required only when the set of top-level mirrored entries changes.

Examples:

- creating a new top-level path under the real home requires Kirbot restart to
  add the corresponding symlink into each profile home
- deleting a top-level path under the real home requires Kirbot restart to
  remove the stale symlink from each profile home

This rule must be documented in code comments and the spec because it is easy
to misunderstand.

## Failure Handling

Mirror reconciliation should fail fast if Kirbot cannot create the required
top-level symlinks.

Kirbot should not silently continue with a partially mirrored home, because
that would produce hard-to-debug profile-specific behavior.

The managed Codex boundary should continue to use its existing semantics:

- managed `skills/` may still fall back to copy if symlinks are unavailable
- mirror reconciliation itself should not degrade silently into partial copying

## Implementation Shape

The mirror logic belongs in:

- `packages/kirbot-core/src/codex-home.ts`

That file already owns profile-home preparation and managed Codex reconciliation.

The spawn environment change belongs in:

- `packages/codex-client/src/codex.ts`

That file should set:

- `CODEX_HOME=<profile-home>`
- `HOME=<profile-home>`

for spawned Codex app-server processes.

## Tests

Unit coverage should verify:

- normal top-level source-home entries are mirrored into a profile home by
  symlink
- codex-related top-level entries such as `.codex` and `.agents` are excluded from mirroring
- stale mirrored top-level entries are removed on the next reconcile
- existing Codex-managed files still reconcile correctly inside the mirrored
  profile home
- spawned Codex app-server environments set both `HOME` and `CODEX_HOME` to
  the profile home

Behavior verification should also confirm:

- with the profile home used as both `HOME` and `CODEX_HOME`, `skills/list`
  does not expose skills from the real `~/.codex`
- with a real-home `.agents/skills` entry that points back into `~/.codex`,
  the mirrored profile home still does not expose those skills
- managed Kirbot skills and system profile-home skills remain discoverable

## Operational Notes

This design intentionally shares most real-home state across profiles.

That means writes through mirrored paths affect the real home immediately.

Examples:

- writing through a mirrored `.ssh` path changes the real `.ssh`
- writing through a mirrored `.config` path changes the real `.config`

That is acceptable in this design because the user wants broad shared-home
behavior, with Codex-specific state isolated separately.

If a future requirement needs stronger isolation for other home-scoped tools,
the exclusion set can expand in a follow-up design. v1 excludes the known
codex-related top-level entries required to keep Codex state isolated on this
machine.
