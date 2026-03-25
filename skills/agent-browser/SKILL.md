---
name: agent-browser
description: Browser automation CLI for AI agents. Use when a task requires interacting with websites, filling forms, clicking buttons, taking screenshots, extracting data, testing web apps, logging in, or otherwise automating browser work.
allowed-tools: Bash(agent-browser:*), Bash(npx agent-browser:*)
---

# Browser Automation with agent-browser

Use `agent-browser` for browser tasks. It drives Chrome/Chromium through CDP and keeps browser state alive between commands.

## Default State

- Use the persistent Kirbot browser defaults from `~/.agent-browser/config.json`.
- That config points at the shared profile directory `/home/dev/.agent-browser/profiles/kirbot` and the session name `kirbot`.
- Do not start a fresh throwaway profile or session unless the user explicitly asks for isolated state.

## Core Workflow

1. Open the page with `agent-browser open <url>`.
2. Take an interactive snapshot with `agent-browser snapshot -i`.
3. Use the refs from the snapshot, such as `@e1`, with `click`, `fill`, `select`, `check`, and `press`.
4. Re-snapshot after navigation or DOM changes.

## Common Commands

- `agent-browser wait --load networkidle`
- `agent-browser screenshot [path]`
- `agent-browser get text @e1`
- `agent-browser close`

## Auth and Session Notes

- Use the configured persistent profile/session for normal browsing.
- Override them only when you need isolation or a site-specific state bucket.
- Use `agent-browser state save|load` when you need explicit state files.
- Use `agent-browser --profile <dir> ...` when you need a different persistent profile.
- Use `agent-browser --session-name <name> ...` when you need a different persistent session name.
- Use `agent-browser --auto-connect ...` to reuse an existing Chrome session.

## References

- [Authentication patterns](references/authentication.md)
- [Session management](references/session-management.md)
- Upstream docs: https://vercel.com/docs/agent-resources/skills
- Upstream repo: https://github.com/vercel-labs/agent-browser
