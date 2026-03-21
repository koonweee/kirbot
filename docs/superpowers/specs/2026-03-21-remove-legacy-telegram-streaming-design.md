# Remove Legacy Telegram Streaming Design

## Goal

Remove the retained legacy edit-streaming Telegram turn path and clean up the code so kirbot keeps only the current status-bubble-plus-final-message behavior behind a single Telegram turn-surface abstraction.

## Context

Kirbot recently introduced a `TelegramTurnSurface` abstraction with a new default behavior:

- status is shown in its own editable Telegram bubble
- assistant output is not streamed visibly
- one final assistant bubble is sent when the turn completes
- the status bubble is deleted after successful final send

The old edit-streaming path was intentionally preserved as an alternate internal implementation. That made the migration safer, but it now leaves dead configuration, extra branching, and tests for behavior we no longer want to support. The cleanup should remove that legacy path entirely while preserving the current visible behavior.

## Requirements

- Keep the `TelegramTurnSurface` interface as the boundary between turn orchestration and Telegram-visible rendering.
- Remove the old edit-streaming implementation completely.
- Remove mode/config plumbing that exists only to support the legacy path.
- Preserve the current status-bubble-plus-final-message behavior exactly.
- Preserve current terminal safety behavior:
  - failed final send keeps/edits the status bubble
  - failed status delete is best-effort only
  - non-success terminal states keep the status bubble
- Remove tests that only exist to verify the legacy edit-streaming path.
- Keep runtime assistant accumulation, artifact generation, and footer generation unchanged.

## Proposed Approaches

### 1. Minimal dead-code deletion

Delete `EditStreamingTurnSurface` and leave the rest of the abstraction shape mostly intact.

Pros:
- smallest diff
- low behavioral risk

Cons:
- leaves mode-oriented names and plumbing behind
- keeps now-meaningless concepts like `TelegramTurnSurfaceMode`
- does not fully clean the architecture

### 2. Interface cleanup with one implementation

Keep the `TelegramTurnSurface` interface, but remove all mode plumbing and rename the remaining implementation to a neutral single-purpose surface.

Pros:
- removes dead configurability
- preserves the useful abstraction boundary
- leaves the code simpler and easier to understand

Cons:
- slightly broader rename/refactor surface than minimal deletion

### 3. Full collapse into lifecycle/finalizer

Remove the interface and inline the remaining behavior directly into lifecycle/finalization.

Pros:
- fewer files

Cons:
- loses a good boundary that already matches the product behavior
- makes Telegram rendering policy harder to test in isolation
- increases coupling between lifecycle and transport behavior

### Recommendation

Use interface cleanup with one implementation. The surface abstraction is still valuable, but the old mode and its supporting configuration are not.

## Architecture

Keep:

- `TelegramTurnSurface` interface
- one concrete Telegram turn surface that implements the current status-bubble-plus-final-message behavior

Remove:

- `TelegramTurnSurfaceMode`
- factory branching between multiple implementations
- `EditStreamingTurnSurface`
- `surfaceMode` state stored on turns
- any dependency/config fields that only select between Telegram surface modes
- the `TelegramTurnStream` compatibility alias

The remaining implementation should be renamed to something neutral, such as `TelegramTurnMessageSurface`, so the code reflects that there is now only one supported Telegram turn UX.

## Data Flow

### Turn Activation

`TurnLifecycleCoordinator.activateTurn()` always creates the single Telegram turn surface implementation. There is no mode lookup and no alternate path.

### During the Turn

- status updates continue to flow through `surface.updateStatus(...)`
- assistant deltas continue to accumulate in runtime for final text, snapshots, and artifacts
- visible assistant updates remain a no-op through the surface

### Finalization

Successful completion with publishable assistant text:

- finalizer resolves final text and reply markup
- surface sends the final assistant bubble
- surface best-effort deletes the status bubble

Completed turns with no publishable assistant message:

- finalizer calls `surface.publishTerminalStatus(...)`

Failed/interrupted turns:

- finalizer calls `surface.publishTerminalStatus(...)`

The cleanup should not change any of those behaviors; it only removes the unused legacy branch.

## Error Handling

Keep current behavior unchanged:

- if final assistant send fails, keep the status bubble and edit it into `failed`
- if status delete fails after final send, log and continue
- if no status bubble exists, terminal handling may still send/edit a fallback visible message
- late assistant updates after finalization remain ignored for visible output

Removing the legacy path should reduce branching, not alter the safety model.

## Testing

Update tests to match the single remaining Telegram surface:

- keep `telegram-turn-surface.test.ts`, but remove tests that explicitly select or verify the legacy edit-streaming path
- keep lifecycle, bridge, and harness coverage for:
  - status bubble creation/editing
  - no visible assistant streaming
  - final assistant send
  - status deletion after successful completion
  - terminal fallback behavior
- remove test-only references to mode selection or alternate implementations

As part of cleanup, verify there are no remaining code or test references to:

- `edit_streaming`
- `TelegramTurnSurfaceMode`
- `surfaceMode`
- `EditStreamingTurnSurface`
- `TelegramTurnStream`

## Out of Scope

- changing current Telegram-visible UX
- reintroducing completion pings
- modifying assistant runtime accumulation behavior
- changing artifact publication or footer semantics

## Implementation Notes

- This is a cleanup pass, not a product-behavior change.
- Favor renaming the remaining implementation to a neutral name so future readers do not infer unsupported alternate modes.
- If `telegram-streaming.ts` becomes empty after removing the legacy implementation, delete the file and move the single implementation into the canonical turn-surface file or another focused file with a neutral name.
