# Edit-Based Streaming Design

**Date:** 2026-03-21

**Status:** Proposed

## Goal

Replace kirbot's draft-based assistant streaming with a single editable Telegram message per turn:

- start each turn as a normal Telegram message with status text
- update that same message as Codex output arrives
- edit the same message into the final answer when the turn completes
- remove the separate draft path from the normal turn lifecycle

## Current State

Today, kirbot streams assistant output through Telegram drafts:

- `item/agentMessage/delta` is forwarded directly into turn runtime state
- `TelegramMessenger` sends `sendMessageDraft` updates for both status and assistant streaming
- turn completion sends a separate final Telegram message and then clears the draft state

This has two problems:

- the draft surface still feels noisy even when updates are buffered
- the current flow is split across draft-specific and final-message code paths, which makes the lifecycle harder to reason about

Live tests also showed that changing the draft chunk size does not produce the desired user-facing behavior. The draft composer still presents the stream in a way that does not meaningfully improve readability, so the draft path is the wrong abstraction for this feature.

## Design Summary

Move all visible turn streaming onto one editable Telegram message:

- one message is sent when the turn starts
- status updates edit that same message
- assistant deltas accumulate in memory until a semantic flush boundary is reached
- edits are rate-limited so Telegram is updated at most once per second
- the final assistant answer edits the same message in place

This keeps the user-facing surface to one message per turn and removes the need for draft clearing, draft throttling, or draft-specific finalization logic.

## Components

### Turn Streaming Coordinator

Add a centralized coordinator for visible turn streaming, likely under `packages/kirbot-core/src/bridge/`.

Responsibilities:

- own the per-turn visible message state
- buffer Codex deltas
- detect semantic flush boundaries
- enforce the minimum edit interval
- decide when to switch from status text to assistant text
- force the final visible text on completion, interruption, or failure

The coordinator should be the only place that knows about sentence-aware buffering and cooldown policy.

### Telegram Message Transport

Refactor `packages/kirbot-core/src/telegram-messenger.ts` so it becomes a thin transport layer:

- `sendMessage` for the initial visible turn message
- `editMessageText` for all subsequent visible updates
- no draft-specific streaming policy
- no draft clearing logic in the normal turn path

The transport should still own retry-aware Telegram delivery behavior, but not the streaming policy itself.

### Turn Lifecycle Integration

`packages/kirbot-core/src/bridge/turn-lifecycle.ts` should continue to own turn phases and finalization orchestration, but delegate all visible message updates to the streaming coordinator.

It should not decide:

- how to chunk assistant output
- when a semantic chunk is ready
- how often to edit Telegram

It should only tell the coordinator:

- turn started
- status changed
- assistant delta arrived
- turn completed, failed, or interrupted

## User-Facing Behavior

### Turn Start

- kirbot sends one normal Telegram message for the active turn
- the message starts as a status line such as `thinking · 0s`
- the message is silent by default unless an existing flow explicitly requests notification

### Live Streaming

- assistant deltas accumulate in memory
- kirbot only emits an edit when there is a flushable semantic chunk and the cooldown allows it
- semantic flush boundaries include:
  - sentence endings
  - paragraph breaks
  - intentional line breaks when they appear to be structural
- edits happen at most once per second

### Completion

- the same message is edited into the final assistant answer
- no separate final assistant bubble is sent in the normal path
- the visible message is then frozen and closed

### Interrupts And Failures

- interruptions and failures should still force the latest buffered visible text into the same message
- if Telegram rejects a retryable edit, kirbot should keep the latest buffer and retry using the server-provided backoff
- if Telegram rejects a non-retryable edit, kirbot should log the failure and keep the turn lifecycle alive so terminal cleanup still runs

## Data Flow

1. A turn begins and the coordinator asks the messenger to send the initial visible message.
2. The returned `message_id` becomes the stable handle for the turn's visible output.
3. Status updates and assistant deltas are applied to an in-memory buffer for that turn.
4. A boundary detector decides whether the current buffer contains a semantic chunk that can be shown.
5. If the minimum edit interval has elapsed, kirbot edits the same message in place.
6. If not, kirbot keeps the buffer and waits for the next tick or boundary.
7. On terminal turn states, kirbot forces a final edit using the resolved final answer text and stops editing.

## Flush Policy

Use a semantic flush boundary plus a cooldown:

- boundary detection decides whether the current buffer is meaningful enough to show
- a 1 second minimum edit interval decides whether the edit is allowed now

Recommended boundary rules:

- flush on `.`, `?`, or `!` followed by whitespace or end of text
- flush on `\n\n`
- flush on intentional single newlines for list-like or structured text
- do not flush mid-code-block or mid-structured block unless completion forces it

This is intentionally simpler than fixed token or word chunking, and it maps better to human reading behavior.

## Error Handling

- Retryable Telegram edit failures should retain the pending buffer and reschedule with Telegram's backoff.
- Non-retryable edit failures should be logged, but they should not tear down the turn on their own.
- If the initial visible message cannot be sent, the turn should fail as it does today.
- If the final in-place edit fails after retries, kirbot should prefer to preserve the one-message-per-turn model and report the delivery failure rather than immediately reintroducing a separate final bubble.

## Testing Strategy

Update tests around the user-visible contract first.

### Boundary Detection

Add unit tests for the flush-boundary detector:

- sentence endings
- paragraph breaks
- intentional line breaks
- code-block stability

### Streaming Coordinator

Add coordinator tests for:

- no edits more often than once per second
- buffering of partial text until a flush boundary exists
- immediate final flush on completion
- retry behavior for `429` responses
- failure logging for non-retryable edit errors

### Bridge Behavior

Update bridge and lifecycle tests so they assert:

- the initial turn message is sent with `sendMessage`
- subsequent visible updates use `editMessageText`
- no draft events are emitted in the normal turn path
- the final answer edits the existing message instead of sending a separate final bubble

### Harness Behavior

Update harness transcript and event expectations so the visible turn surface is recorded as a single edited message rather than a draft plus final message pair.

## Documentation Updates

After implementation, update the operational docs to match the new behavior:

- [`docs/architecture.md`](/home/dev/kirbot/docs/architecture.md)
- [`docs/user-flows.md`](/home/dev/kirbot/docs/user-flows.md)
- [`docs/engineering-guide.md`](/home/dev/kirbot/docs/engineering-guide.md) if the recommended workflow changes

## Out Of Scope

This change does not alter:

- Codex thread submission semantics
- approval and user-input request handling
- custom commands
- session persistence
- Mini App artifact publication

It only changes how a single turn's visible output is rendered in Telegram.
