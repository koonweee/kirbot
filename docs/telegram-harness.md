# Telegram Harness

This harness runs the real kirbot core against a recording Telegram transport.
It is the fastest way for an engineer or agent to exercise real bridge, DB, and
Codex behavior without manually using a Telegram client.

## What It Uses

The harness keeps these parts real:

- kirbot runtime/bootstrap
- bridge/session/turn orchestration
- SQLite persistence
- media-store lifecycle
- Codex app server and RPC path by default over a harness-owned stdio child

The harness replaces only Telegram transport:

- inbound user messages are injected at the bridge entrypoints
- outbound Telegram API calls are captured by a recording `TelegramApi`

This means the harness is app-level end-to-end coverage, not a real Telegram
network test. Keep a thin manual smoke check against Telegram for Bot API
confidence.

## CLI Usage

Start the interactive CLI:

```bash
npm run harness:telegram
```

Available commands:

- `root <text>`: send a root-chat message
- `topic <topicId> <text>`: send a message inside an existing topic
- `press <messageId> <callbackData>`: press an inline button by callback payload
- `wait`: block until no active turn or pending request remains
- `transcript`: print the current synthesized visible chat state
- `events`: print raw outbound Telegram API events
- `logs`: print captured kirbot and Codex app-server logs
- `quit`: stop the runtime and exit

Default behavior:

- the harness creates isolated state under a temp directory instead of reusing
  the normal app database
- the harness creates an isolated empty Codex workspace under that temp
  directory instead of reusing the normal `CODEX_DEFAULT_CWD`
- the harness uses its own stdio-managed Codex app-server child instead of
  sharing any live kirbot transport state
- Codex runs for real unless the caller injects a test double through the
  library API
- startup command-menu sync is skipped because the harness is focused on
  conversational flows, not BotFather-visible menus

This makes `npm run harness:telegram` safe to run next to a live kirbot
development or production process by default. The harness still exercises real
Codex behavior, but it does not share the live bridge database, media temp
directory, or Codex workspace unless a caller explicitly opts into that.

## Library Usage

Create a harness from code:

```ts
import { createTelegramHarness } from "../src/harness";

const harness = await createTelegramHarness();
await harness.start();

await harness.sendRootText("Inspect the repo");
await harness.waitForIdle();

console.log(harness.getTranscript());
console.log(harness.getTelegramEvents());
console.log(harness.getLogs());

await harness.stop();
```

Primary API:

- `start()` / `stop()`
- `sendRootText(text)`
- `sendTopicText(topicId, text)`
- `pressButton({ messageId, callbackData | buttonText })`
- `waitForIdle({ timeoutMs?, settleMs? })`
- `getTranscript()`
- `getTelegramEvents()`
- `getLogs()`

Optional creation overrides:

- `workspaceMode: "empty" | "inherit"`: choose between the default isolated
  empty workspace and the configured `CODEX_DEFAULT_CWD`
- `workspaceDir`: use an explicit workspace path instead of the default harness
  workspace

## Reading Harness Output

Use the outputs for different questions:

- `transcript`: what a Telegram user would currently see
- `events`: the exact outbound Telegram API calls kirbot made
- `logs`: kirbot runtime logs plus Codex app-server stdout/stderr captured with
  source tags

Drafts are intentionally not merged into durable transcript history. They stay
visible in raw events and in the transcript draft section so streamed status can
be inspected without pretending those drafts were permanent messages.

## Extending The Harness

When kirbot adds new Telegram-facing behavior, update the harness in this order:

1. Extend the recording Telegram transport in `src/harness/recording-telegram.ts`.
2. Update transcript synthesis if the new behavior changes visible chat state.
3. Extend the library API or CLI only if callers need a new control surface.
4. Add or update a harness test that covers the new behavior.
5. Update this doc if the usage model or maintenance rules changed.

Keep these boundaries:

- do not emulate raw Telegram HTTP or `grammy` internals
- do not duplicate bridge logic inside the harness
- do not move Telegram formatting into the harness; it should only observe the
  formatted payloads kirbot emits

## When To Use It

Prefer the harness when:

- you want to drive real Codex-backed flows without manual Telegram clicks
- you need to inspect both chat-visible output and raw Telegram API calls
- you want runtime logs next to transcript state

Prefer narrower unit/bridge tests when:

- the behavior is isolated to formatting, queue state, or persistence
- deterministic fake Codex behavior is more valuable than a real app-server run
