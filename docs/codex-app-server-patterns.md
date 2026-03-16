# Codex App-Server Patterns

This document compares how `kirbot` currently interacts with the Codex app server against the current source of truth in the `openai/codex` repo. For app-server integration, the relevant SOT is the Rust implementation behind Codex CLI, especially:

- `codex-rs/app-server-client`
- `codex-rs/exec`
- `codex-rs/app-server/tests/suite/v2/*`

The goal is to make `kirbot` follow Codex CLI patterns where that is practical, and to use the app-server test suite as the baseline for contract and lifecycle behavior.

Verified against the upstream repository on 2026-03-15. The key files re-checked directly were:

- `codex-rs/app-server-client/src/lib.rs`
- `codex-rs/app-server/tests/suite/v2/initialize.rs`
- `codex-rs/app-server/tests/suite/v2/turn_start.rs`
- `codex-rs/app-server/tests/suite/v2/turn_steer.rs`
- `codex-rs/tui/src/chatwidget.rs`
- `codex-rs/tui/src/chatwidget/tests.rs`

## Immediate Alignment Changes

The first local changes should stay at the protocol boundary, because those are direct SOT mismatches and do not require guessing at Telegram product behavior.

Completed in this repo:

- `initialize` now sends an explicit capabilities object with `experimentalApi: false` instead of `capabilities: null`
- the JSON-RPC client now preserves method-specific server error metadata instead of collapsing everything to a plain `Error`
- tests now cover transport-close rejection, structured JSON-RPC error propagation, and the `initialize` request shape emitted by `CodexGateway`

Still queued:

- add protocol-level tests for steer invalid-param variants, based on the upstream `turn_steer.rs` suite
- separate Telegram turn rendering from protocol lifecycle handling
- document local message readback reconciliation as an intentional divergence from raw stream-only consumers

## Task 1: Document Current Kirbot Patterns

### 1. Transport and lifecycle layering

`kirbot` uses a thin out-of-process WebSocket JSON-RPC client:

- Transport: `src/rpc.ts`
- App-server facade: `src/codex.ts`
- Product-specific orchestration: `src/bridge.ts`

Current flow:

1. `initialize`
2. `thread/start`
3. `thread/name/set`
4. `turn/start`
5. stream notifications until `turn/completed` or `error`
6. optional `thread/read` readback to produce the final assistant message

Notable local policy:

- `CodexGateway` caches loaded thread IDs and calls `thread/resume` only when needed.
- `TelegramCodexBridge` owns active turn state and topic-to-turn routing.
- Unsupported server requests are rejected with JSON-RPC `-32601`.

### 2. Streaming and completion

`kirbot` handles assistant output in the Telegram bridge rather than in the transport layer.

Pattern:

- `item/agentMessage/delta` appends text per item ID
- `item/completed` replaces the final text for that item when available
- multiple assistant items are rendered in arrival order with blank-line separators
- `turn/completed` triggers finalization
- final text prefers `thread/read` readback over locally streamed text when readback is non-empty

This gives `kirbot` a reconciliation policy that is stronger than raw streaming alone:

- streamed text is used for drafts and progress
- `thread/read` is treated as the final source if it disagrees with the stream

Current tests:

- `tests/bridge.test.ts`
  - streams turn deltas and publishes final completion message
  - renders multiple assistant items with separators
  - reconciles streamed text with completed item text
  - uses thread readback when streamed text is out of order
  - reuses the temporary status message when no assistant delta arrives

### 3. Steering and follow-up behavior

`kirbot` uses optimistic follow-up steering:

- if a Telegram topic already has an active turn, the next user message attempts `turn/steer`
- if steering succeeds, the message is attached to the active turn
- if steering fails with the active-turn mismatch race, `kirbot` falls back to a fresh `turn/start`

This is a good product behavior, but it is based on local policy and string-matching one server error path.

Current tests:

- `tests/bridge.test.ts`
  - steers a follow-up message into the current topic turn
  - falls back to a new turn when steer loses the active-turn race

### 4. Server request handling

`kirbot` actively supports three app-server request patterns:

- command execution approval
- file change approval
- tool user-input requests

Pattern:

- server request arrives through `onServerRequest`
- bridge resolves the owning Telegram topic from stored thread mapping
- bridge persists the pending request in the database
- Telegram UI is used to collect approval or user input
- bridge responds with the typed request result

Current tests:

- `tests/bridge.test.ts`
  - stores approval requests and resolves them via callback queries
  - routes tool user-input answers back through the bridge fake Codex API

### 5. Current testing shape

`kirbot` coverage is mostly at the product integration layer:

- fake transport tests in `tests/rpc.test.ts`
- fake Codex bridge tests in `tests/bridge.test.ts`

That means current tests are strong on Telegram-facing behavior and local state transitions, but weaker on:

- exact app-server wire contract
- exact JSON-RPC error codes
- initialize capabilities
- transport close and pending-request failure behavior
- notification filtering and backpressure semantics

## Task 2: Compare Kirbot Patterns to Codex CLI / Codex-RS

### 1. Architecture

The main architectural difference is where the protocol behavior lives.

`kirbot`:

- WebSocket JSON-RPC transport in `src/rpc.ts`
- a light operation wrapper in `src/codex.ts`
- most behavior and policy in `src/bridge.ts`

Codex CLI SOT:

- shared in-process client facade in `codex-rs/app-server-client/src/lib.rs`
- higher-level consumers such as `codex-rs/exec/src/lib.rs`
- contract-level server tests in `codex-rs/app-server/tests/suite/v2`

Key SOT traits `kirbot` does not currently mirror:

- typed lifecycle facade instead of ad hoc transport plus product bridge
- bounded event queues with explicit lag signaling
- terminal events marked as delivery-critical
- method-qualified transport, server, and decode errors
- initialize capability handling such as `opt_out_notification_methods`

### 2. Streaming and completion

Similarities:

- both models treat `turn/start` and server notifications as the central turn lifecycle
- both separate immediate request responses from later streamed progress and completion

Differences:

- `kirbot` reconstructs assistant text from `item/agentMessage/delta` and `item/completed`, then reconciles with `thread/read`
- Codex CLI consumers are built around richer event processing and app-server-level guarantees, with the strongest contract tests living in `codex-rs/app-server/tests/suite/v2/turn_start.rs`
- Codex CLI also treats certain completion/abort signals as must-deliver in `codex-rs/app-server-client/src/lib.rs`

Testing difference:

- `kirbot` tests final rendering behavior with a fake Codex client
- SOT tests exercise actual app-server notifications, request/response envelopes, and final turn status through the real test harness

Relevant SOT references:

- `codex-rs/app-server/tests/suite/v2/turn_start.rs`
- `codex-rs/app-server-client/src/lib.rs`

### 3. Steering

Similarities:

- both rely on `turn/steer` with `expectedTurnId`

Differences:

- `kirbot` uses a local optimistic steering policy and falls back based on one race error
- SOT has server-level contract tests for:
  - no active turn
  - oversized input rejection
  - successful steer returning the active turn ID

Relevant SOT references:

- `codex-rs/app-server/tests/suite/v2/turn_steer.rs`

Gap summary:

- `kirbot` does not assert server error codes for invalid steer conditions
- `kirbot` does not test steer input validation against server limits
- `kirbot` does not isolate steer policy from Telegram UI behavior

### 4. Server requests and approvals

Similarities:

- both consume typed server requests and respond with typed approval payloads

Differences:

- `kirbot` presents approvals and user input through Telegram
- `codex-rs/exec` intentionally rejects many requests because exec mode is non-interactive
- the SOT for request contract shape and resolution flow is the app-server test suite, not exec behavior

Relevant SOT references:

- `codex-rs/app-server/tests/suite/v2/turn_start.rs`
- `codex-rs/app-server/tests/suite/v2/request_permissions.rs`
- `codex-rs/app-server/tests/suite/v2/mcp_server_elicitation.rs`

Gap summary:

- `kirbot` tests product flow, but not the request/response contract at the protocol layer
- `kirbot` does not currently cover the broader v2 request surface, only the three methods it uses

### 5. Initialize and transport semantics

Codex CLI SOT explicitly tests initialize capabilities and event-delivery semantics.

Relevant SOT references:

- `codex-rs/app-server/tests/suite/v2/initialize.rs`
- `codex-rs/app-server-client/src/lib.rs`

Notable differences vs `kirbot`:

- `kirbot` sends `capabilities: null`
- `kirbot` does not support `opt_out_notification_methods`
- `kirbot` emits transport close/errors, but has no contract tests for pending-request rejection on disconnect
- `kirbot` has no lag or bounded-queue model comparable to the in-process client facade

### 6. Realtime conversation

`kirbot` currently does not use the realtime conversation APIs.

Relevant SOT reference:

- `codex-rs/app-server/tests/suite/v2/realtime_conversation.rs`

This is not an immediate mismatch for the Telegram bridge, but it is part of the current SOT surface area and should be explicitly documented as out of scope for now.

## Task 3: Top Priorities to Align Kirbot More Closely with Codex CLI

### Priority 1: Add protocol-level tests before changing behavior

Add a new layer of tests that exercises `kirbot` app-server behavior closer to the SOT contract rather than only via fake bridge flows.

Highest-value cases to add first:

- `initialize` request shape and capability handling
- `thread/start`, `thread/resume`, and `thread/read` request/response wiring
- `turn/start` lifecycle and terminal notification handling
- `turn/steer` success, missing active turn, and invalid input paths
- approval and user-input request/response round-trips

Target SOT references:

- `codex-rs/app-server/tests/suite/v2/initialize.rs`
- `codex-rs/app-server/tests/suite/v2/turn_start.rs`
- `codex-rs/app-server/tests/suite/v2/turn_steer.rs`

Status:

- partially started via request-shape and transport-lifecycle tests
- still missing server-contract tests around steer invalid params and completion edge cases

### Priority 2: Separate protocol policy from Telegram presentation

Move more app-server lifecycle logic behind a protocol-facing layer so Telegram behavior becomes a consumer of normalized turn events instead of the primary owner of protocol policy.

Why:

- Codex CLI keeps transport/lifecycle concerns in a dedicated client facade
- `kirbot` currently mixes protocol handling, product policy, and Telegram rendering in `src/bridge.ts`

Expected result:

- easier contract-level tests
- fewer behavior decisions hidden in Telegram-only code paths
- clearer mapping from SOT tests to local code

### Priority 3: Make completion semantics explicit

Keep the readback reconciliation behavior, but document it as a local consumer policy rather than an implied transport guarantee.

Follow-up work:

- define which notifications are required for local completion
- define when `thread/read` is a fallback vs authoritative finalizer
- add tests for disconnect, partial stream, and out-of-order item delivery

This keeps the Telegram UX benefits while making the difference from Codex CLI explicit and testable.

### Priority 4: Tighten steer semantics to match SOT behavior

Keep optimistic steering, but align its error handling and tests with the server contract.

Follow-up work:

- stop relying on one raw error string where possible
- assert exact invalid steer behavior from the server contract
- add coverage for oversized input and no-active-turn cases

Concrete SOT note:

- the upstream app-server suite asserts `turn/steer` returns `-32600` when no turn is active
- it separately asserts oversized input returns `INVALID_PARAMS_ERROR_CODE` plus structured `input_error_code`, `max_chars`, and `actual_chars`
- the TUI does not auto-start a fresh turn on steer input; it keeps pending steer state locally and only restores or resubmits it after later lifecycle events

### Priority 5: Broaden v2 request surface awareness

Even if `kirbot` intentionally only supports a subset of requests, it should explicitly track the current v2 surface and reject unsupported requests consistently.

Follow-up work:

- enumerate supported and unsupported request methods in one place
- add tests for unsupported request rejection behavior
- compare periodically against the app-server v2 request surface in `codex-rs`

## Recommended Implementation Order

1. Finish protocol-layer tests for `initialize`, transport-close, `turn/start`, and `turn/steer` error variants.
2. Introduce a protocol-facing turn/session state layer so `src/bridge.ts` consumes normalized events instead of owning raw app-server policy.
3. Revisit steering policy with explicit tests for race, no-active-turn, and oversized-input behavior.
4. Keep `thread/read` reconciliation, but document it as Telegram-specific completion policy and add tests for disconnect and out-of-order delivery.
5. Expand unsupported-request handling and document intentional deviations.

## Bottom Line

`kirbot` already follows the same broad app-server model as Codex CLI: initialize a client, start or resume threads, start turns, consume streamed notifications, and respond to typed server requests. The main gap is not the high-level flow. The main gap is that `kirbot` enforces protocol behavior inside a product bridge and tests it mostly through fake consumer behavior, while Codex CLI treats app-server behavior as a first-class contract with stronger lifecycle, error, and notification tests.

The fastest route to alignment is therefore:

1. adopt the SOT test cases first,
2. isolate protocol behavior from Telegram UI concerns,
3. then adjust runtime behavior only where those tests show a real mismatch.
