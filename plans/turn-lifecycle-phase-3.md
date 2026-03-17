# Turn Lifecycle Phase 3

## Goal

Make the lifecycle event flow testable and extensible by routing notifications and submission paths through explicit lifecycle transitions, then rebalance tests so lifecycle correctness is verified independently from Telegram/Codex integration details.

## Why This Phase

After Phases 1 and 2, the architecture should have:

- shared terminal finalization
- explicit turn-owned context
- a lifecycle coordinator

Phase 3 finishes the job by reducing the amount of lifecycle logic still embedded inside event dispatch and bridge orchestration.

## Current Problem Areas

Primary file: [src/bridge.ts](/home/jtkw/kirbot/src/bridge.ts)

The current bridge still acts as:

- transport notification dispatcher
- lifecycle decision-maker
- Telegram rendering coordinator
- queue manager
- persistence orchestrator

Even with helper extraction, `handleNotification` is still the place where concerns meet. That makes notification-driven bugs hard to reason about and hard to test in isolation.

## Scope

This phase should:

- make notification handling dispatch into lifecycle methods
- unify submission and steer ownership flows with the lifecycle model
- rebalance the test suite toward lifecycle-focused tests plus thinner integration coverage

It should not:

- redesign the Codex protocol layer
- replace Telegram integration boundaries

## Proposed Changes

### 1. Notification dispatch table

Refactor `handleNotification` so it mainly maps notifications to lifecycle transitions:

- assistant delta updates
- assistant item completion
- plan/status updates
- terminal turn notifications
- error notifications

The bridge should stop containing lifecycle-heavy branching inline where possible.

### 2. Submission and steer through the same lifecycle entry points

Both of these should use shared lifecycle ownership concepts:

- new turn submission
- steer submission into an active turn

That includes:

- preparing input resources
- transferring ownership of turn-scoped resources
- handling submission failure cleanup
- tracking whether input is now bound to a live turn

### 3. Concrete lifecycle handlers for cross-cutting concerns

At this point it should be easy to plug in a small number of concrete handlers for concerns like:

- persistence
- Telegram status rendering
- Telegram final output rendering
- queue preview synchronization
- turn-scoped resource cleanup

These should remain explicit collaborators, not arbitrary runtime plugins.

## Test Strategy

Split tests into two layers.

### Lifecycle-focused tests

These should validate:

- event-to-transition mapping
- finalization rules
- duplicate notification safety
- resource ownership and cleanup
- queue scheduling behavior

These tests should be as small and deterministic as possible.

### Bridge integration tests

Keep a thinner set of end-to-end integration tests that prove:

- Telegram rendering still works
- Codex notification wiring still works
- request routing still works

The bridge tests should stop being the only place lifecycle correctness is asserted.

## Deliverables

- notification dispatch routed through lifecycle transitions
- shared submission/steer lifecycle entry points
- lifecycle unit tests or focused subsystem tests
- trimmed but still strong bridge integration coverage

## Definition of Done

This phase is done when:

- lifecycle behavior is testable without relying on large bridge integration scenarios
- new cross-cutting turn concerns can be added through explicit lifecycle collaborators
- `TelegramCodexBridge` is mostly orchestration and integration, not the place where lifecycle rules live

## Risks

- over-separating concerns and making debugging harder
- introducing too many layers for a small codebase
- accidentally weakening integration coverage while adding lifecycle tests

## Non-Goals

- generic event bus or middleware system
- protocol rewrite
- major product behavior changes unless explicitly desired
