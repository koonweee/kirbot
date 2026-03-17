# kirbot

<img src="./kirbot.png" alt="kirbot" width="128" />

kirbot is a Telegram bot that connects a Telegram chat to a Codex app server session. It lets a single configured Telegram user start Codex conversations from Telegram, continue them in-thread, and handle Codex approvals or input requests without leaving Telegram.

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
- The Telegram user ID allowed to use the bot

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
- `TELEGRAM_USER_ID`: Telegram user ID allowed to use the bot; in a private chat, this is also the chat ID

Codex-related configuration:

- `CODEX_APP_SERVER_URL`: WebSocket URL kirbot binds its bundled Codex app server to
- `CODEX_DEFAULT_CWD`: default working directory for Codex sessions
- `KIRBOT.md`: the developer-instructions prompt kirbot always sends to Codex

kirbot intentionally leaves Codex base instructions unset and uses `KIRBOT.md` for developer instructions.
kirbot always starts its own pinned Codex app server from the repo's `@openai/codex` dependency rather than using a globally installed `codex`.
The generated bindings in `src/generated/codex` are checked in and are expected to match that pinned Codex version.

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

To intentionally refresh the committed Codex protocol bindings after upgrading the pinned Codex version:

```bash
npm run generate:codex-types
```

To verify that the committed bindings still match the pinned Codex version without rewriting files:

```bash
npm run verify:codex-types
```

`verify:codex-types` only compares the checked-in generated files against fresh output from the pinned `@openai/codex` package. It does not typecheck kirbot's handwritten code.

To typecheck kirbot's handwritten TypeScript code against the current generated bindings:

```bash
npm run typecheck
```

To run the full Codex upgrade workflow after bumping the pinned version:

```bash
npm run verify:codex-upgrade
```

That script regenerates the bindings, then runs the TypeScript typecheck and test suite.

CI runs the non-mutating check and fails if the committed generated files drift from the pinned `@openai/codex` version.

Attribution: side profile Kirby by @KIRBYSWARPSTAR on X.
