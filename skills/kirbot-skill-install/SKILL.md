---
name: kirbot-skill-install
description: Use when adding a shared Kirbot skill, enabling a skill for one or more Codex profiles, or updating skill wiring in the managed profile config.
---

# Kirbot Skill Install

## Overview
Kirbot does not treat per-profile Codex homes as the source of truth for shared skills. Shared skills are authored once in the repo and then materialized into each managed home on startup.

## When to Use
- Adding a new shared skill for Kirbot
- Enabling or disabling a skill for a profile in `config/codex-profiles.json`
- Updating a shared skill that should appear in one or more managed profile homes

## Workflow
1. Author or update the shared skill at `skills/<skill-id>/SKILL.md`.
2. Register the skill id in `config/codex-profiles.json` under top-level `skills`.
3. Add that skill id to each profile that should receive it under `profiles.<profile>.skills`.
4. Do not edit `dirname(DATABASE_PATH)/homes/<profile>/skills/` directly. With the default database path that is `data/homes/<profile>/skills/`. Kirbot rewrites that subtree on startup.
5. Restart Kirbot so the managed profile homes reconcile to the updated config.

## Rules
- Keep shared skills in the checked-in repo `skills/` directory.
- Treat `config/codex-profiles.json` as the enablement source of truth.
- Treat `dirname(DATABASE_PATH)/homes/<profile>/skills/` as generated output.
- If a skill is removed from a profile, expect the next startup to remove it from that profile home.

## Common Mistakes
- Editing a generated `dirname(DATABASE_PATH)/homes/<profile>/skills/` copy and expecting the change to persist
- Adding a new skill directory without registering the skill id in `config/codex-profiles.json`
- Enabling a skill in one profile home manually instead of declaring it in the profile config
