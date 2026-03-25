# Session Management

Use separate sessions when you need isolated cookies, storage, history, or open tabs.

## Named Sessions

- `agent-browser --session auth open <url>` keeps a login flow isolated.
- `agent-browser --session public open <url>` can browse separately with different state.
- Each session has its own cookies, localStorage, sessionStorage, cache, history, and tabs.

## State Persistence

- Save session state with `agent-browser state save /path/to/state.json`.
- Restore it with `agent-browser state load /path/to/state.json`.
- Combine `--session-name` with saved state if you want long-lived reuse across restarts.

## Cleanup

- Close a specific session with `agent-browser --session auth close`.
- Use semantic session names like `github-auth`, `docs-scrape`, or `variant-a`.
- Remove stale state files when they are no longer needed.

## Practical Patterns

- Use one session per target site when scraping multiple sites in parallel.
- Use separate sessions for login vs public browsing so cookies do not leak across flows.
