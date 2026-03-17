# kirbot

<img src="./kirbot.png" alt="kirbot" width="128" />

kirbot is a Telegram bot that turns a Telegram root chat plus topics into a chat UI for Codex. One configured Telegram user can start sessions from the lobby, continue them inside topics, approve tool actions, answer follow-up questions, and switch between planning and implementation without leaving Telegram.

## Start Here

New to the repo:

- Read [docs/architecture.md](docs/architecture.md) for the system model and code map.
- Read [docs/user-flows.md](docs/user-flows.md) for the user-visible flows and the code that owns each one.
- Read [docs/engineering-guide.md](docs/engineering-guide.md) for setup, tests, change boundaries, and documentation maintenance.

Formatting work has its own local guide in [src/telegram-format/README.md](src/telegram-format/README.md) and [src/telegram-format/AGENTS.md](src/telegram-format/AGENTS.md).

## Mental Model

kirbot sits between Telegram and a pinned local Codex app server:

- Telegram is the user-facing UI.
- `src/bridge.ts` translates Telegram events into session and turn actions.
- `src/codex.ts` and `src/rpc.ts` manage the Codex app-server connection.
- `src/db.ts` stores topic/session state, turn records, and pending requests.
- `src/telegram-messenger.ts` and `src/telegram-format/*` own Telegram delivery and formatting.

The bridge is intentionally topic-centric:

- a root-chat message usually creates a new Telegram topic and a new Codex thread
- later messages inside that topic continue the same Codex thread
- pending approvals and user-input requests are routed back into that same topic

## Quick Start

Prerequisites:

- Node.js 22+
- a Telegram bot token
- the Telegram user ID allowed to use the bot

Install and configure:

```bash
npm install
cp .env.example .env
```

Required settings:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_USER_ID`

Commonly adjusted settings:

- `DATABASE_PATH`
- `CODEX_DEFAULT_CWD`
- `CODEX_APP_SERVER_URL`
- `CODEX_MODEL`
- `CODEX_MODEL_PROVIDER`
- `CODEX_SANDBOX_MODE`
- `CODEX_APPROVAL_POLICY`
- `CODEX_CONFIG_JSON`

Telegram BotFather requirements:

- Enable private-chat topics for the bot.
- Disable user-created topics in private chats so kirbot can own session topic creation from the lobby.

Run locally:

```bash
npm run dev
```

Build and run production output:

```bash
npm run build
npm start
```

## Development Commands

```bash
npm test
npm run typecheck
npm run verify:codex-types
npm run generate:codex-types
npm run verify:codex-upgrade
```

Notes:

- kirbot always starts the pinned `@openai/codex` app server from `node_modules`; it does not depend on a globally installed `codex`.
- `KIRBOT.md` is sent as Codex developer instructions.
- Codex base instructions are intentionally left unset.
- `src/generated/codex` is checked in and should stay aligned with the pinned `@openai/codex` version.

Attribution: side profile Kirby by @KIRBYSWARPSTAR on X.
