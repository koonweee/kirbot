# Kirbot Managed Codex Profile Config Design

Date: 2026-03-24

## Summary

Kirbot will move from environment-driven profile routing to a checked-in profile
configuration model centered on `config/codex-profiles.json`.

That JSON file becomes the single authored source of truth for:

- command-to-profile routing
- per-profile Codex defaults
- shared skill definitions by id
- shared MCP definitions by key
- per-profile selection of skill ids and MCP keys

Kirbot will derive each profile home automatically under the data directory,
materialize the managed parts of that home on every startup, and preserve
runtime state such as authentication and thread history.

## Goals

- make profile routing and profile behavior live in one checked-in config file
- remove inline env JSON for Codex profile configuration
- derive managed profile homes automatically instead of requiring explicit
  `homePath` boilerplate
- let profiles share repo-authored skills and shared MCP definitions by name
- fail early on invalid profile config before any Codex gateway starts
- keep profile homes reproducible without destroying runtime-owned state

## Non-Goals

- manage `rules/` or `superpowers/` in v1
- support hand-edited profile `config.toml` files as a stable workflow
- support host-local skill source directories outside the repo convention
- migrate legacy shared-home sessions into the new managed homes

## Source Of Truth

Kirbot will use one checked-in config file:

- `config/codex-profiles.json`

This file replaces `CODEX_PROFILES_JSON` as the authored profile config.

The remaining env vars stay focused on deployment and secrets such as:

- Telegram credentials
- workspace chat id
- mini app URL
- database path

Profile routing and profile capability selection will no longer be authored in
environment variables.

## Shared Asset Layout

Shared skills will use a fixed repo convention:

- `skills/<skill-id>/`

Each shared skill directory must contain:

- `SKILL.md`

Kirbot will treat the repo-local `skills/` directory as the source for
profile-managed skills. Profile homes will not be the place where humans edit
shared skill source.

Shared MCPs will live inline in `config/codex-profiles.json` under a top-level
registry map. Profiles will reference MCP definitions by key only.

## Config Shape

The config file will use a generic command-like route map and shared registries
for skills and MCPs.

Example:

```json
{
  "routes": {
    "general": "general",
    "thread": "coding",
    "plan": "coding",
    "read-only": "readonly"
  },
  "skills": {
    "brainstorming": {},
    "requesting-code-review": {},
    "kirbot-skill-install": {}
  },
  "mcps": {
    "github": {
      "type": "stdio",
      "command": [
        "github-mcp",
        "serve"
      ]
    }
  },
  "profiles": {
    "general": {
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
      "skills": [
        "brainstorming",
        "requesting-code-review",
        "kirbot-skill-install"
      ],
      "mcps": [
        "github"
      ]
    }
  }
}
```

Notes:

- route keys are command-like ids, not a fixed enum limited to today's commands
- the application still requires `general`, `thread`, and `plan`
- profiles reference shared skills and MCPs by key only
- `skills` is a registry of known shared skills, even though the source on disk
  also exists under `skills/<skill-id>/`

## Route Semantics

The initial route contract remains:

- `general` -> a dedicated general-chat profile
- `thread` -> `coding` profile
- `plan` -> `coding` profile

Future commands can add more route keys without changing the config format.

Kirbot must still enforce:

- required routes `general`, `thread`, and `plan` exist
- every route target references a declared profile
- the profile selected by `routes.general` is dedicated to that route and cannot
  be shared with another route

## Derived Profile Homes

Profile homes become managed artifacts derived from the database location.

For profile `<id>`, Kirbot derives:

- `dirname(DATABASE_PATH)/homes/<id>`

Example:

- `DATABASE_PATH=data/telegram-codex-bridge.sqlite`
- `general` home -> `data/homes/general`
- `coding` home -> `data/homes/coding`

There is no authored `homePath` in normal config.

Kirbot creates missing home directories on startup.

## Home Ownership Boundary

Each profile home contains both managed artifacts and runtime-owned state.

Managed by Kirbot on every startup:

- `config.toml`
- `skills/`

Preserved as runtime-owned:

- `auth.json`
- Codex thread and session state
- logs and caches
- `rules/`
- `superpowers/`
- other non-managed files

This means profile homes are not treated as fully disposable directories, but
their managed subtrees are fully reconciled from config.

## Startup Reconciliation

After config validation passes, Kirbot reconciles each profile home on startup.

Expected behavior:

- create the profile home if missing
- preserve `auth.json` if already present
- seed `auth.json` from the base Codex home if needed
- rewrite the full managed `config.toml`
- rebuild the managed `skills/` directory to exactly match the profile config
- preserve unmanaged files and directories

Manual edits to:

- `data/homes/<profile>/config.toml`
- `data/homes/<profile>/skills/`

are unsupported and will be overwritten on the next startup.

## Managed `config.toml`

Kirbot will treat `config/codex-profiles.json` as the only authored source for
profile-global Codex config and will rewrite the full `config.toml` for each
profile on every startup.

That generated file will include:

- model selection
- sandbox mode
- approval policy
- generated MCP configuration for the profile's selected MCP keys
- any other Kirbot-managed Codex keys needed for a reproducible profile

Kirbot should use Codex-generated types and enums where possible when parsing
and generating these values.

## Managed Skills

Shared skill source lives in:

- `skills/<skill-id>/`

Kirbot will materialize `data/homes/<profile>/skills/` from the profile's
declared skill ids.

Desired implementation:

- prefer symlinks from the profile home into repo-local `skills/<skill-id>/`
- fall back to copying if symlinks are unavailable or unsuitable

This materialization detail is internal. The config contract remains "profile
references these skill ids."

Reconciliation behavior:

- declared skills appear in the profile home
- undeclared managed skills are removed from that profile home
- direct edits inside the managed profile-home `skills/` directory are not
  preserved

## Managed MCPs

Shared MCP definitions live inline in the config file under a top-level `mcps`
map.

Profiles reference MCPs by key only.

Kirbot will resolve the selected MCP keys for each profile and write the
resulting MCP configuration into the generated profile `config.toml`.

Kirbot will not create a separate MCP source directory in v1.

## Validation

Startup must validate `config/codex-profiles.json` completely before creating
gateways.

Hard startup errors:

- required routes `general`, `thread`, or `plan` are missing
- a route references an undeclared profile
- `general` shares a profile with another route
- a profile references a missing skill id
- a referenced skill directory is missing
- a referenced skill directory lacks `SKILL.md`
- a profile references a missing MCP key
- per-profile model, sandbox, or approval values fail validation
- generated home paths would collide
- JSON shape is invalid

Warnings only:

- skill ids declared in the top-level `skills` registry that are unused by every
  profile
- extra folders under repo-local `skills/` that do not correspond to any
  declared shared skill id
- MCP registry entries that are declared but unused by every profile

Error messages should be actionable and name the broken key or path.

## Runtime Routing

Session routing remains profile-based and persistent:

- General sessions persist the routed profile for `general`
- topic sessions persist the routed profile for the command that created them
- later resume, turn, archive, approval, and user-input operations route from
  the persisted `profileId`

This design does not change the user-facing routing decision:

- `General` still uses `general`
- `/thread` and `/plan` still use `coding`

It changes where profile behavior is authored and how profile homes are built.

## Legacy Session Behavior

The hard-cutover behavior remains:

- no shared-home fallback
- no migration of old shared-home sessions
- old sessions fail when first resumed

User-facing error text should continue directing people to start a new thread or
topic when a legacy removed-home session is touched.

## Documentation And Agent Guidance

Kirbot will add a repo-local skill:

- `skills/kirbot-skill-install/`

That skill explains the non-standard skill installation model:

- shared skill source is authored in `skills/<skill-id>/`
- `config/codex-profiles.json` enables the skill for profiles by id
- agents must not edit `data/homes/<profile>/skills/` directly

Kirbot should also add a note in:

- `apps/bot/KIRBOT.md`

to point agents at `kirbot-skill-install` and clarify that profile-home
`skills/` is generated.

## Testing

Add coverage for:

- config parsing and semantic validation of `config/codex-profiles.json`
- required route enforcement and dedicated `general` profile validation
- missing skill directory and missing `SKILL.md` failures
- warnings for unused shared skills and unused MCP definitions
- derived home path calculation from `DATABASE_PATH`
- startup reconciliation of managed `config.toml`
- startup reconciliation of managed `skills/`
- preservation of `auth.json` and other unmanaged files
- MCP generation into per-profile `config.toml`
- profile routing continuing to work with the new config source

## Rollout Notes

Operationally, rollout becomes:

- check in `config/codex-profiles.json`
- check in shared skills under `skills/`
- deploy the new Kirbot build
- let Kirbot create and reconcile `data/homes/<profile>` on startup

Existing legacy sessions from the removed shared-home path are still not
migrated and will fail on first resume.
