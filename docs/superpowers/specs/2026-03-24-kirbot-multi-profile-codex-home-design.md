# Kirbot Multi-Profile Codex Home Design

Date: 2026-03-24

## Summary

Kirbot will move from one shared isolated Codex home for all newly created sessions to multiple isolated Codex homes, each selected by a persisted session profile.

In the new model:

- `General` always uses a dedicated `general` profile.
- `/thread` and `/plan` both use a shared `coding` profile.
- future commands such as `/read-only` may map to their own profile.
- the legacy shared-home fallback path is removed entirely.

The goal is to let different conversation surfaces run with different skills, MCPs, and Codex config, while keeping routing deterministic after restart.

## Goals

- support multiple isolated Codex environments inside one Kirbot deployment
- make environment selection explicit and persistent per session
- keep `General` separate from work-oriented topic threads
- allow multiple commands to share the same environment profile
- remove the shared-home legacy compatibility path

## Non-Goals

- migrate old shared-home thread state into new isolated homes
- preserve support for the old single `CODEX_HOME_PATH` configuration model
- infer a profile from topic title, prior messages, or runtime heuristics
- make `/plan` and `/thread` different environments unless explicitly configured that way later

## Terms

- Profile: a named Codex environment backed by its own isolated `CODEX_HOME`
- Mode: the session behavior inside a thread, such as default mode or plan mode
- Surface: the Telegram location for the session, either `general` or a `topic`

Profile and mode are separate concerns:

- profile decides Codex home, skills, MCPs, and global config
- mode decides how the conversation behaves inside that profile

## Current State

Kirbot currently starts two gateways:

- one gateway using the shared home
- one gateway using a single isolated Kirbot home

All newly created sessions are created on the isolated gateway. The shared gateway remains only as a fallback for legacy thread ids that no longer exist in the isolated home.

This means:

- all new `General` sessions use the same isolated home
- all new topic sessions use the same isolated home
- there is no concept of multiple isolated profiles today

## Proposed Model

Kirbot will start one isolated gateway per configured profile and route every session directly to the gateway for its persisted `profileId`.

Initial profiles:

- `general`
- `coding`

Initial entrypoint mapping:

- `General` -> `general`
- `/thread` -> `coding`
- `/plan` -> `coding`

Possible future extension:

- `/read-only` -> `read-only`

No shared-home gateway will exist in the new model.

## Configuration

Kirbot will use a JSON configuration object for profile declarations and routing.

Example:

```json
{
  "profiles": {
    "general": {
      "homePath": "/srv/kirbot/codex-home-general"
    },
    "coding": {
      "homePath": "/srv/kirbot/codex-home-coding"
    },
    "read-only": {
      "homePath": "/srv/kirbot/codex-home-read-only"
    }
  },
  "routing": {
    "general": "general",
    "thread": "coding",
    "plan": "coding",
    "read-only": "read-only"
  }
}
```

Configuration requirements:

- every routing target must reference a declared profile
- every declared profile must define its isolated home path
- profile ids must be stable strings suitable for persistence

Kirbot will not preserve the old single-home config path as a supported configuration mode.

## Home Preparation

Each profile home will be prepared the same way the current isolated home is prepared:

- create the target directory if needed
- seed `auth.json` if available
- seed `rules/`, `skills/`, and `superpowers/` if available

This keeps each profile self-contained and independently configurable after bootstrap.

## Session Persistence

Kirbot session records will gain a persisted `profileId`.

Rules:

- root session rows store the routed `general` profile
- topic session rows store the profile chosen when the session is created
- later resume, turn, compact, archive, and approval operations route from the persisted `profileId`

Routing will not depend on:

- whether the session is new or old
- whether the session is `General` or a topic at the time of resume
- probing multiple gateways until one succeeds

The database becomes the source of truth for environment selection.

## Thread Creation Semantics

Thread creation will follow profile routing first, then mode behavior.

### General

- first normal message in `General` creates a root session
- the root session uses profile `general`

### `/thread`

- creates a topic session
- the topic session uses profile `coding`
- the session starts in normal mode

### `/plan`

- creates a topic session
- the topic session uses profile `coding`
- the session starts in plan mode

This keeps `/thread` and `/plan` in the same coding environment while preserving their different workflow behavior.

## Runtime Routing

The current two-gateway `shared` versus `isolated` router will be replaced by a profile router.

Conceptually:

- `general` -> gateway for the `general` home
- `coding` -> gateway for the `coding` home
- future profile ids -> their own gateways

Operations that use `profileId` routing:

- thread creation
- thread resume and metadata reads
- turn start and steer
- interrupt
- archive
- approvals and user-input responses
- event ownership and request routing

Kirbot will no longer treat "newly created thread" as equivalent to "single isolated gateway". A new thread will be created on the gateway selected by its profile.

## Legacy Cleanup

The legacy shared-home path will be removed completely.

This includes:

- stop starting the shared-home app-server
- delete fallback routing that probes shared-home for unknown thread ids
- remove tests that assert shared fallback behavior
- remove docs that describe the legacy shared-home resume path

No migration will be attempted for old shared-home sessions.

## Failure Behavior For Old Sessions

Old sessions that only exist in the removed shared-home environment will fail when they are first resumed or otherwise loaded.

Chosen behavior:

- no startup scan
- no proactive marking of sessions as unusable
- fail on first resume attempt

User-facing behavior:

- Kirbot should surface a clear message that the session belongs to a removed legacy Codex home and cannot be resumed
- the message should tell the user to start a new thread or restart the session in a new topic

This keeps cleanup explicit and avoids carrying silent migration complexity.

## Settings Behavior

Profile and thread settings remain layered:

- profile home owns skills, MCPs, and profile-global Codex config
- thread-local overrides still handle per-session values such as model, reasoning effort, permissions, sandbox policy, and cwd

This preserves the current thread-local settings behavior while moving environment-level concerns into profile homes.

## Data Model Changes

Expected persistence changes:

- add `profile_id` to session records
- keep session surface and preferred mode as separate fields
- evolve chat defaults to become profile-aware rather than only `root` and `spawn`

The existing `root` versus `spawn` default split is not rich enough once multiple topic profiles exist. Defaults should align with profile identities instead of only surface categories.

## Testing

Add coverage for:

- runtime initialization with multiple configured profile gateways
- config validation for profile declarations and routing targets
- `General` creating sessions on `general`
- `/thread` creating sessions on `coding`
- `/plan` creating sessions on `coding` while setting plan mode
- persisted `profileId` driving resume and turn routing after restart
- missing legacy thread ids failing directly instead of probing another gateway
- removal of shared-home fallback behavior

## Rollout Notes

This is a hard-cutover change.

Operationally:

- deploy new multi-profile config
- start Kirbot with profile-specific isolated homes
- accept that old shared-home sessions will fail when first resumed

No compatibility window is planned.
