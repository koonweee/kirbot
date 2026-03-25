# Authentication Patterns

Use these patterns when a site requires login, SSO, 2FA, or saved browser state.

## Fast Paths

- Reuse a logged-in Chrome session with `agent-browser --auto-connect state save ./auth.json`.
- Load saved state with `agent-browser --state ./auth.json open <url>`.
- Use `agent-browser --profile <dir>` when you want a persistent browser profile.
- Use `agent-browser --session-name <name>` when you want state to auto-save and auto-restore.

## Login Flow

1. Open the login page.
2. Run `agent-browser snapshot -i` to get refs.
3. Fill credentials with `agent-browser fill @e1 "user@example.com"` and `agent-browser fill @e2 "password"`.
4. Submit with `agent-browser click @e3`.
5. Wait for the post-login page and verify the URL or page content.

## Saving and Restoring State

- Save after login with `agent-browser state save ./auth-state.json`.
- Restore later with `agent-browser state load ./auth-state.json`.
- Prefer `AGENT_BROWSER_ENCRYPTION_KEY` if you need encrypted state at rest.

## Special Cases

- OAuth and SSO flows usually require snapshotting after each redirect.
- For 2FA, run headed mode, let the user finish verification, then save state.
- For HTTP basic auth, set credentials before navigation with `agent-browser set credentials <user> <pass>`.
- For cookie-based auth, set the required cookie and navigate to the protected page.

## Security

- Do not commit state files.
- Delete temporary auth state when you are done.
