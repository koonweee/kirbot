# Codex CLI Alignment TODO

## Done

- Send explicit `initialize.capabilities` instead of `null`
- Preserve structured JSON-RPC method errors in the RPC client
- Add transport-close and initialize-shape tests
- Introduce a bridge turn runtime to separate protocol state from Telegram rendering
- Replace immediate steer-race fallback with pending-steer and queued-follow-up handling
- Classify `turn/steer` failures using structured JSON-RPC metadata with message fallback
- Add tests for structured stale-turn and oversized-input steer failures
- Add Telegram send-now interrupt control for pending steers
- Handle interrupted turns via `turn/completed` interrupted status and resubmit pending steers on demand
- Preserve pending steers by moving them into the next-turn queue when a turn ends interrupted without send-now

## Intentional Telegram Divergences

- Final assistant text still prefers `thread/read` reconciliation over streamed text
- Pending steers and queued follow-ups are in-memory only

## Next

- Decide whether queued follow-ups and pending steers should persist across process restart
- Evaluate whether Telegram needs a separate interrupt-only affordance beyond send-now
- Replace the separate status message with a single-slot status code fence whose lowercase label carries the current status and emoji, while commentary uses a lowercase `thinking` fence with a brain emoji
