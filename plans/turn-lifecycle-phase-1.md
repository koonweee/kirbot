# Turn Lifecycle Phase 1

## Goal

Unify terminal turn handling into one explicit finalization flow so cross-cutting concerns stop being duplicated across `completeTurn`, `failTurn`, and `finalizeInterruptedTurn`.

## Why This Phase First

The highest-maintenance part of the current lifecycle is terminal cleanup. Today the bridge repeats slightly different versions of:

- final text resolution
- Telegram final message publishing
- database turn completion
- runtime turn removal
- queue preview sync
- queued follow-up advancement
- turn-scoped resource cleanup

This is the most error-prone surface and the fastest place to get leverage.

## Current Problem Areas

Primary file: [src/bridge.ts](/home/jtkw/kirbot/src/bridge.ts)

Current terminal entry points:

- `completeTurn`
- `failTurn`
- `finalizeInterruptedTurn`

Current terminal helpers:

- `beginTurnFinalization`
- `publishFinalTurnText`
- `removeActiveTurn`

The main issue is that terminal transitions are only partially centralized. Side effects are spread across multiple methods, so adding one new concern requires touching several paths and keeping them behaviorally aligned by hand.

## Scope

This phase should not introduce a general plugin system or a full state-machine rewrite.

It should:

- preserve current product behavior
- keep `TelegramCodexBridge` as the top-level orchestrator
- introduce one shared terminal finalization path
- make room for later start/steer lifecycle extraction

## Proposed Changes

### 1. Introduce a shared terminal finalization helper

Add a single helper with a shape roughly like:

```ts
finalizeTurn(activeTurn, {
  terminalStatus,
  threadId,
  finalTextPolicy,
  publishWhenEmpty
})
```

This helper should own:

- resolving final text from stream vs readback
- deciding whether to publish final output
- appending final stream text to the database
- marking the turn terminal in the database
- releasing turn-scoped resources
- finalizing runtime state
- removing active turn state
- syncing queue preview
- scheduling the next queued follow-up when appropriate

### 2. Narrow the terminal entry points

Keep public/internal entry points for semantic clarity:

- `completeTurn`
- `failTurn`
- `finalizeInterruptedTurn`

But make them thin wrappers that only compute the terminal policy and delegate to the shared finalizer.

### 3. Make `beginTurnFinalization` strictly pre-terminal

`beginTurnFinalization` should only cover pre-terminal teardown that must happen before final text publishing:

- clear status draft
- flush or clear commentary streams
- disable or remove any per-turn control UI

It should not own database completion, queue advancement, or turn removal.

### 4. Centralize turn-scoped cleanup

Any concern tied to the lifetime of a turn should be released from the shared terminal path:

- temporary image retention
- future per-turn files or scratch buffers
- future control messages or draft handles if needed

## Deliverables

- one shared terminal finalization path in `src/bridge.ts`
- thin terminal wrappers for completed / failed / interrupted
- tests proving terminal behavior is identical across paths where expected
- no user-facing behavior regressions

## Testing Plan

Add or update tests for:

- completed turn finalization
- failed turn finalization
- interrupted turn finalization
- queued follow-up behavior after each terminal outcome
- turn-scoped resource cleanup in the shared path

Run:

- `npm run check`
- `npm test`

## Definition of Done

This phase is done when:

- all terminal turn paths route through one shared implementation
- new terminal side effects can be added in one place
- no existing Telegram or queue behavior regresses

## Risks

- subtle differences between interrupted and completed behavior can be flattened accidentally
- queue handling can regress if terminal finalization does too much too early
- final output publishing rules must remain explicit, especially for interrupted turns

## Non-Goals

- a full explicit state machine
- notification dispatch redesign
- start/steer lifecycle unification
- generic lifecycle hooks framework
