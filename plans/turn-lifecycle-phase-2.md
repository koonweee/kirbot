# Turn Lifecycle Phase 2

## Goal

Introduce an explicit `TurnContext` and lifecycle coordinator so turn-owned state and resources stop being managed as scattered bridge-local structures and procedural control flow.

## Why This Phase

Phase 1 reduces duplication at terminal time. Phase 2 addresses the larger structural problem: the bridge already behaves like a state machine, but that logic is implicit.

Right now turn state is spread across:

- `ActiveTurn`
- `BridgeTurnRuntime`
- `#activeTurns`
- `#submitPendingSteersAfterInterrupt`
- draft handles and commentary stream maps
- temporary per-turn resources like retained images

That makes it hard to answer basic lifecycle questions such as:

- who owns this resource
- what phase the turn is in
- whether a steer can still attach to this turn
- what cleanup is guaranteed on terminal transition

## Scope

This phase should introduce explicit lifecycle structure without rewriting the entire bridge.

It should:

- keep the Telegram bridge as the top-level integration point
- give each active turn a concrete owned context
- define explicit lifecycle transitions
- reduce cross-cutting state scattering

## Proposed Model

### 1. `TurnContext`

Create a concrete object representing one live turn. It should own:

- `chatId`
- `topicId`
- `threadId`
- `turnId`
- current lifecycle phase
- status draft state
- Telegram status handle
- Telegram final stream handle
- commentary stream handles
- turn-scoped attachments or other temporary resources
- any turn control metadata added by product behavior

This context should become the primary container for turn-owned resources that are currently stored indirectly.

### 2. `TurnPhase`

Define a small explicit phase model, for example:

- `submitting`
- `active`
- `finalizing`
- `completed`
- `failed`
- `interrupted`

The goal is not theoretical purity. The goal is to make legal transitions explicit and easier to test.

### 3. `TurnLifecycle` or `TurnCoordinator`

Introduce a concrete coordinator with methods such as:

- `activateTurn(...)`
- `attachSteerInput(...)`
- `updateFromNotification(...)`
- `beginFinalization(...)`
- `finalizeCompleted(...)`
- `finalizeFailed(...)`
- `finalizeInterrupted(...)`

This layer should own lifecycle transitions and delegate side effects to a few narrow collaborators.

## Extraction Targets

Current logic to move out of the bridge over this phase:

- active turn creation
- turn-owned resource registration
- transition from submit success to active turn
- transition from active to finalizing
- terminal lifecycle state mutation

Logic that can stay outside for now:

- high-level topic/session lookup
- Telegram callback query entry points
- server request routing unrelated to turn ownership

## Deliverables

- `TurnContext` type or class
- lifecycle coordinator with explicit transitions
- `TelegramCodexBridge` updated to call the coordinator instead of mutating turn lifecycle inline
- reduced direct manipulation of `#activeTurns` and turn-owned resources in bridge methods

## Testing Plan

Add focused tests for:

- allowed lifecycle transitions
- duplicate finalization protection
- steer attachment to active turns
- resource ownership transfer to a turn
- terminal cleanup from the coordinator

These tests should be narrower than the current bridge integration tests and should not require full Telegram rendering to validate lifecycle correctness.

Run:

- `npm run check`
- `npm test`

## Definition of Done

This phase is done when:

- turn-owned state has a clear single owner
- lifecycle transitions are explicit in code
- new turn-scoped concerns can be added to `TurnContext` without threading through multiple bridge maps

## Risks

- duplicating state between `TurnContext` and `BridgeTurnRuntime`
- introducing an abstraction that is too generic to be useful
- moving too many concerns at once and losing behavior parity

## Non-Goals

- replacing `BridgeTurnRuntime` entirely in one step
- introducing pluggable lifecycle middleware
- redesigning Telegram rendering behavior
