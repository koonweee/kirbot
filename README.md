# kirbot

<img src="./kirbot.png" alt="kirbot" width="128" />

kirbot is a Telegram bot that connects a private Telegram chat in threaded mode to a Codex app server session. It lets approved Telegram users start Codex conversations from Telegram, continue them in-thread, and handle Codex approvals or input requests without leaving Telegram.

## Architecture

At a high level, the system has four parts:

- Telegram bot: receives user messages and sends replies in Telegram threads
- Bridge service: maps Telegram conversations to Codex threads and turns
- Codex app server: runs the Codex session and tool workflow
- SQLite database: stores chat, thread, turn, and pending-request state

Typical flow:

1. A user sends a message in Telegram.
2. kirbot creates or resumes a Codex thread for that Telegram thread.
3. The message is forwarded to the Codex app server.
4. Codex responses are streamed back into Telegram.
5. If Codex needs approval or user input, kirbot relays that request back through Telegram.

## Setup

Prerequisites:

- Node.js 22 or newer
- A Telegram bot token
- A private Telegram chat configured for threaded use
- A running `codex app-server`, or permission for kirbot to spawn it

Install dependencies:

```bash
npm install
```

Create an environment file from the example and fill in the required values:

```bash
cp .env.example .env
```

Required configuration:

- `TELEGRAM_BOT_TOKEN`: Telegram bot token
- `TELEGRAM_CHAT_ID`: target private Telegram chat ID
- `TELEGRAM_ALLOWED_USER_IDS`: comma-separated Telegram user IDs allowed to use the bot

Codex-related configuration:

- `CODEX_APP_SERVER_URL`: WebSocket URL for the Codex app server
- `CODEX_SPAWN_APP_SERVER`: set to `true` to let kirbot start `codex app-server`
- `CODEX_DEFAULT_CWD`: default working directory for Codex sessions
- `KIRBOT.md`: the developer-instructions prompt kirbot always sends to Codex

kirbot intentionally leaves Codex base instructions unset and uses `KIRBOT.md` for developer instructions.

Build and run:

```bash
npm run build
npm start
```

For local development:

```bash
npm run dev
```

To run tests:

```bash
npm test
```

Attribution: side profile Kirby by @KIRBYSWARPSTAR on X.
