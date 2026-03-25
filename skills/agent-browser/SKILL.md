---
name: agent-browser
description: Browser automation CLI for AI agents. Use when a task requires interacting with websites, filling forms, clicking buttons, taking screenshots, extracting data, testing web apps, logging in, or otherwise automating browser work.
allowed-tools: Bash(agent-browser:*), Bash(npx agent-browser:*)
---

# Browser Automation with agent-browser

Use `agent-browser` for browser tasks. It drives Chrome/Chromium through CDP and keeps browser state alive between commands.

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

- Use `agent-browser --session-name <name> ...` for persistent browser state.
- Use `agent-browser state save|load` when you need explicit state files.
- Use `agent-browser --profile <dir> ...` for recurring authenticated browsing.
- Use `agent-browser --auto-connect ...` to reuse an existing Chrome session.

## References

- [Authentication patterns](references/authentication.md)
- [Session management](references/session-management.md)
- Upstream docs: https://vercel.com/docs/agent-resources/skills
- Upstream repo: https://github.com/vercel-labs/agent-browser
