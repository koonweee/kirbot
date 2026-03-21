# Status Bubble + Final Message Design

## Goal

Add an alternate Telegram turn surface where status is shown in its own editable bubble, assistant output is not streamed, and completion sends one full assistant message before deleting the status bubble. Make this the new default while keeping the current edit-streaming path available internally.

## Context

Kirbot currently uses one visible Telegram message per turn. Status updates, assistant streaming, and final assistant output all flow through `TelegramTurnStream`, which edits the same message in place. That design simplified draft-based streaming, but it also coupled two distinct user experiences:

- ephemeral status updates (`thinking`, `running`, `editing`)
- persistent assistant output with Mini App buttons

The new default should separate those surfaces again without reintroducing the old draft complexity. Status remains live and editable. Assistant output becomes a single final message. The current edit-streaming behavior remains as an alternate implementation path for future comparison or rollback.

## Requirements

- Status is its own Telegram bubble and is updated in place as the turn progresses.
- Assistant output is not visibly streamed in the new default path.
- Assistant deltas must still accumulate in runtime exactly as they do today so final snapshots, artifacts, and footers continue to work.
- On successful completion, Kirbot sends one full assistant message with the normal Mini App reply markup, then best-effort deletes the status message.
- On interrupted or failed turns that do not publish a final assistant message, the status bubble is kept and edited into a terminal status/result.
- The current edit-streaming implementation must remain available as an alternate internal path.
- The new status-bubble path becomes the code default.
- The separate `> done` notification is removed for the new default path.

## Proposed Approaches

### 1. Branch inside `TelegramTurnStream`

Add a mode flag to the existing `TelegramTurnStream` and teach it both behaviors.

Pros:
- small diff in the short term
- minimal constructor churn

Cons:
- combines two distinct surface models in an already stateful class
- makes status cadence, assistant streaming, final publish, and deletion behavior harder to reason about
- increases the chance of subtle regressions when changing Telegram behavior again

### 2. Surface Strategy Abstraction

Introduce a turn-surface interface and provide one implementation for each Telegram UX model.

Pros:
- clean separation between the new default and the old streaming path
- isolates message-identity and cleanup behavior behind one boundary
- keeps `TurnLifecycleCoordinator` and `TurnFinalizer` focused on turn logic instead of Telegram policy

Cons:
- requires a small refactor up front
- tests need to be redistributed around the new abstraction

### 3. Ad Hoc Lifecycle/Finalizer Split

Leave the stream class mostly intact, bypass visible assistant streaming in lifecycle, and special-case final send/delete in finalization.

Pros:
- lowest initial refactor cost

Cons:
- behavior gets distributed across multiple coordinators
- the two Telegram modes become implicit instead of explicit
- harder to maintain and test

### Recommendation

Use the surface strategy abstraction. The new behavior is a real surface-model change, not a small tweak to edit cadence. It should be represented as a first-class boundary.

## Architecture

Add a `TelegramTurnSurface` interface that represents the user-visible Telegram surface for one turn.

Responsibilities:

- publish and update a status bubble
- receive assistant render updates
- publish the final assistant message
- publish terminal status when no final assistant bubble should exist
- handle end-of-turn cleanup

Implementations:

- `EditStreamingTurnSurface`
  - preserves the current one-message edit-streaming behavior
  - can wrap or absorb the existing `TelegramTurnStream` logic
- `StatusThenFinalMessageTurnSurface`
  - owns one editable status message
  - ignores assistant updates for visible output
  - sends one final assistant message on completion
  - deletes the status bubble only after the final assistant send succeeds
  - keeps and edits the status bubble for interrupted/failed/no-final-message terminal states

Selection:

- create the chosen surface in `TurnLifecycleCoordinator.activateTurn()`
- default to `StatusThenFinalMessageTurnSurface`
- keep `EditStreamingTurnSurface` wired as an alternate internal mode
- choose the implementation through one internal factory/helper so production code, tests, and harness coverage all exercise the same selection path

## Data Flow

### Turn Activation

`TurnLifecycleCoordinator.activateTurn()` creates the turn context and the selected surface implementation. No visible Telegram message exists until the first status update is published.

### Status Updates

Status-producing events continue to call `updateStatus(...)`.

In the new default surface:

- the first rendered status sends one normal Telegram message
- later status updates edit that same message
- existing status throttling can remain in the surface implementation

### Assistant Deltas

Assistant deltas continue through `BridgeTurnRuntime.appendAssistantDelta(...)` and `commitAssistantItem(...)` exactly as they do today. This preserves:

- final text accumulation
- response artifact generation
- commentary artifact generation
- snapshots
- footers

In the new default surface, assistant render updates are accepted but produce no visible Telegram assistant draft updates.

### Completion

`TurnFinalizer` continues to:

- resolve the final snapshot
- compute final text
- build response/commentary publications
- resolve Mini App reply markup
- publish commentary/plan/footer artifacts

For the final assistant surface step, the finalizer delegates to the selected surface:

- on successful completion with a publishable assistant message:
  - send one full assistant bubble with final text and reply markup
  - after success, best-effort delete the status bubble
- on completion with no publishable assistant message:
  - preserve visible terminal state via the status bubble

A publishable assistant message means the same condition the current finalizer already uses for final assistant output:

- `publishesPlanOnly` is false, and
- either the final text is non-empty after trimming, or `publishWhenEmpty` is true and a fallback final text such as `(no assistant output)` has been produced

Oversized response/commentary artifacts do not make the assistant message non-publishable. They only affect which buttons can be attached directly versus deferred into standalone follow-up messages.

### Non-Success Terminal States

For interrupted and failed turns without a final assistant bubble:

- keep the status bubble
- edit it into terminal text/results

If no status bubble was ever sent, the surface may fall back to sending a terminal message directly.

## Error Handling

### Final Assistant Send Failure

If sending the final assistant message fails:

- do not delete the status bubble
- edit the status bubble into a terminal failure message when possible
- preserve a visible message for the user rather than leaving the turn silent

### Status Deletion Failure

If the final assistant message succeeds but status deletion fails:

- log the failure
- continue finalization
- leave the stale status bubble in chat rather than risking the final answer path

Deletion is best-effort only.

### Late Assistant Updates

Once finalization begins, assistant render updates for the new default surface should be ignored for visible output. Runtime accumulation remains authoritative for final resolved text.

### Terminal Fallbacks

- `completed` with assistant text or fallback text: send assistant bubble, then delete status bubble best-effort
- `failed` / `interrupted` without a final assistant bubble: keep status bubble and edit it into terminal text
- no existing status bubble: fall back to `sendMessage` for the terminal state

## Testing

### Turn Surface Unit Tests

Add focused tests for `StatusThenFinalMessageTurnSurface`:

- first status update sends one status message
- subsequent status updates edit the same status message
- assistant render updates do not publish visible assistant drafts
- successful finalization sends final assistant message and then deletes the status message
- interrupted/failed finalization edits the status message into terminal text and does not delete it
- failed final assistant send preserves the status message and produces terminal fallback text

Retain coverage for `EditStreamingTurnSurface` so the alternate path remains intentionally supported.

### Coordinator / Finalizer Tests

Update lifecycle/finalization tests to assert:

- assistant deltas still accumulate in runtime for snapshots and artifacts
- the final assistant message gets reply markup on the final bubble in the new default path
- status deletion happens only after final assistant send success
- non-success terminal flows keep a visible status bubble

### Harness / Integration Tests

Update harness expectations for the new default transcript shape:

- status message sent
- status message edited over time
- final assistant message sent
- status message deleted
- footer sent

Keep at least one integration path for the alternate edit-streaming surface.

## Out of Scope

- per-chat or user-facing mode selection
- changing approval/prompt message behavior
- reworking artifact publication logic beyond routing the final assistant reply markup to the new final message
- adding a new completion ping

## Implementation Notes

- The current working tree already has local changes around completion ping behavior. This design should avoid relying on the ping path for core completion UX.
- The abstraction should be introduced at the turn surface boundary rather than by scattering mode checks through lifecycle and finalization.
- The runtime model should remain the source of truth for assistant content; only the Telegram-visible rendering policy changes.
