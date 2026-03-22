# kirbot

<img src="./kirbot.png" alt="kirbot" width="128" />

kirbot is a Telegram bot that turns a dedicated private forum supergroup plus topics into a chat UI for Codex. One configured workspace chat can keep a persistent Codex conversation in the forum root, spawn additional topic threads with `/thread <prompt>`, approve tool actions, answer follow-up questions, and switch between planning and implementation without leaving Telegram. Final responses and completed plans can open in a separate Telegram Mini App instead of forcing long content into message bubbles.

## Start Here

New to the repo:

- Read [docs/architecture.md](docs/architecture.md) for the system model and code map.
- Read [docs/user-flows.md](docs/user-flows.md) for the user-visible flows and the code that owns each one.
- Read [docs/engineering-guide.md](docs/engineering-guide.md) for setup, tests, change boundaries, and documentation maintenance.
- Read [docs/telegram-harness.md](docs/telegram-harness.md) if you want to drive kirbot without a real Telegram client.

Formatting work has its own local guide in [packages/telegram-format/README.md](packages/telegram-format/README.md) and [packages/telegram-format/AGENTS.md](packages/telegram-format/AGENTS.md).

## Mental Model

kirbot sits between Telegram and a pinned local Codex app server:

- Telegram is the user-facing UI.
- Final responses, commentary, and completed plans are encoded into shared static Mini App URLs.
- `packages/kirbot-core/src/bridge.ts` translates Telegram events into session and turn actions.
- `packages/codex-client/src/codex.ts` and `packages/codex-client/src/rpc.ts` manage the Codex app-server connection.
- `packages/kirbot-core/src/db.ts` stores topic/session state, turn records, and pending requests.
- `packages/kirbot-core/src/telegram-messenger.ts` and `packages/telegram-format/src/*` own Telegram delivery and formatting.
- `apps/plan-mini-app` is a separate SvelteKit frontend for rendering completed plans from typed URL payloads.

The bridge uses one persistent root session plus topic sessions:

- plain forum root messages continue the same workspace Codex thread
- `/thread <prompt>` and root `/plan [prompt]` create topic-backed Codex sessions
- later messages inside a topic continue that topic's Codex thread
- pending approvals and user-input requests route back to the surface that owns the session

## Quick Start

Prerequisites:

- Node.js 22+
- `tmux` for optional detached dev or production sessions
- a Telegram bot token
- the Telegram workspace chat ID for the dedicated private forum supergroup
- a deployed Telegram Mini App URL over `https`

Install and configure:

```bash
npm install
npm run mini-app:install
cp .env.example .env
```

Required settings:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WORKSPACE_CHAT_ID`
- `TELEGRAM_MINI_APP_PUBLIC_URL`

Commonly adjusted settings:

- `DATABASE_PATH`
- `CODEX_DEFAULT_CWD`
- `CODEX_HOME_PATH`
- `CODEX_MODEL`
- `CODEX_MODEL_PROVIDER`
- `CODEX_SANDBOX_MODE`
- `CODEX_APPROVAL_POLICY`
- `CODEX_CONFIG_JSON`

Bootstrap note:

- `CODEX_MODEL`, `CODEX_MODEL_PROVIDER`, `CODEX_SANDBOX_MODE`, `CODEX_APPROVAL_POLICY`, and `CODEX_CONFIG_JSON` only seed a brand new isolated `CODEX_HOME/config.toml`.
- After that file exists, treat the isolated `config.toml` as Kirbot's global Codex source of truth.

Telegram BotFather requirements:

- Create a dedicated private forum supergroup for kirbot.
- Enable forum topics for that supergroup.
- Disable user-created topics in the forum so kirbot can own `/thread` and root `/plan` topic creation.

Run locally in development:

```bash
npm run dev
npm run mini-app:install
npm run mini-app:dev
```

Run a detached development session in tmux:

```bash
npm run dev:tmux
npm run dev:tmux:attach
npm run dev:tmux:restart
```

Build and run production output:

```bash
npm run build
npm start
```

Run a detached production session in tmux:

```bash
npm run build
npm run start:tmux
npm run start:tmux:attach
npm run start:tmux:restart
```

## Development Commands

```bash
npm run dev
npm run dev:tmux
npm run dev:tmux:attach
npm run dev:tmux:restart
npm run mini-app:dev
npm run mini-app:build
npm run mini-app:check
npm start
npm run start:tmux
npm run start:tmux:attach
npm run start:tmux:restart
npm run harness:telegram
npm test
npm run typecheck
npm run verify:codex-types
npm run generate:codex-types
npm run verify:codex-upgrade
```

Notes:

- kirbot always starts the pinned `@openai/codex` app server from `node_modules`; it does not depend on a globally installed `codex`.
- kirbot prepares a dedicated Codex home for newly created sessions by default. Set `CODEX_HOME_PATH` if you need that isolated state somewhere other than beside `DATABASE_PATH`.
- kirbot keeps a shared-home Codex app-server available for legacy thread ids, so existing topics can still resume while future topics are isolated from other Codex clients on the same machine.
- Intentional override points over the isolated global `config.toml` are:
- global `/model`, `/fast`, and `/permissions` changes, which rewrite the isolated Codex config
- topic-local `/model`, `/fast`, and `/permissions` changes, which apply thread-local overrides instead of rewriting global defaults
- new-session `cwd` selection, including `/start <path>`, which stays per thread because it is session-specific
- `apps/bot/KIRBOT.md` is sent as Codex developer instructions.
- Codex base instructions are intentionally left unset.
- `packages/codex-client/src/generated/codex` is checked in and should stay aligned with the pinned `@openai/codex` version.
- `npm run dev` is the watched local development entrypoint.
- `apps/plan-mini-app` is built and deployed separately; it is a shared static frontend that decodes typed plan payloads from the URL fragment.
- Detached tmux sessions use stable names: `kirbot-dev` for `npm run dev` and `kirbot-prod` for `npm start`.
- The attach scripts connect to the existing tmux session, or switch clients if already inside tmux, so they are the fastest way for an agent to inspect live process output.
- The restart scripts clear the pane scrollback, recreate the pane command in place, and create the session first if it does not already exist.
- Detached production sessions assume `dist/` is already built. Run `npm run build` before `npm run start:tmux` or `npm run start:tmux:restart`.
- `npm run harness:telegram` starts the in-process Telegram harness for agent-driven E2E flows with transcript, event, and log inspection. See [docs/telegram-harness.md](docs/telegram-harness.md).

Attribution: side profile Kirby by @KIRBYSWARPSTAR on X.
