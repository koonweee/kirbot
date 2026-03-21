# Restart Command And Keyboard Design

**Date:** 2026-03-21

**Status:** Approved

## Goal

Make the `/commands` reply keyboard show all visible built-in slash commands, and upgrade root `/restart` into an explicit deployment pipeline that reports each step back to Telegram before it runs.

## Current State

- Telegram's native slash suggestions already include `/restart` because the command is visible in the shared slash-command definitions.
- Kirbot's `/commands` reply keyboard excludes `/restart`, `/thread`, and `/cmd` because it is currently built from the topic-allowed command subset.
- Root `/restart` only sends a generic rebuilding message, then delegates to a bot-side helper that runs `npm run build` and `npm run start:tmux:restart`.

## User-Facing Behavior

### Command Keyboard

- `/commands` shows all visible built-in slash commands in both root chat and topics.
- Custom commands remain appended after the built-in list.
- Scope enforcement does not change:
  - root-only commands still fail when invoked in topics
  - topic-only commands still fail when invoked in root

### Root Restart

- `/restart` remains root-only.
- When invoked from root, kirbot sends a separate Telegram message before each step in this exact sequence:
  1. `git checkout master`
  2. `git fetch origin`
  3. `git reset --hard origin/master`
  4. `npm run build`
  5. `npm run start:tmux:restart`
- Each step message is formatted as `Running: <code>…</code>`.
- If a step fails, kirbot stops immediately and posts one failure message that includes the command failure detail.
- If all steps succeed, kirbot posts one final success message after the restart command completes.

## Architecture

- Keep the `/commands` reply-keyboard assembly in `packages/kirbot-core/src/bridge.ts` and `packages/kirbot-core/src/bridge/presentation.ts`.
- Keep root `/restart` Telegram messaging in `packages/kirbot-core/src/bridge.ts`.
- Move the command-sequence execution details into `apps/bot/src/restart-kirbot.ts`, which already owns the detached production restart behavior.
- Expand the restart hook interface so the bridge can pass a step-report callback into the bot-side restart executor.

## Testing

- Update `packages/kirbot-core/tests/bridge.test.ts` to assert:
  - `/commands` shows the global visible built-in command list plus custom commands
  - root `/restart` emits one `Running:` message per step, then a final success message
  - root `/restart` stops after the first failed step and reports the failure
- Update `packages/kirbot-core/tests/presentation.test.ts` to lock in the new keyboard ordering.
- Add bot-side restart tests covering the exact command order, working directory, and failure handling for `apps/bot/src/restart-kirbot.ts`.
