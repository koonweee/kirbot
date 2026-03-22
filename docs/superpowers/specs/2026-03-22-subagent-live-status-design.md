# Subagent Live Status Bubble Design

**Date:** 2026-03-22

**Status:** Proposed

## Goal

Improve Kirbot's Telegram UX for subagent runs by surfacing live multi-agent progress inside the existing in-progress turn bubble.

The desired UX is:

- keep one in-progress Telegram bubble per turn
- keep the existing top-line status text such as `thinking`, `running`, or `waiting`
- add a short live detail block below that status when Codex is actively using subagents
- show the current snapshot only, not a growing event log
- prefer friendly labels over raw thread IDs
- keep failure details brief in the live bubble

## Current State

Kirbot currently handles `collabAgentToolCall` items in two ways:

- live turn status becomes the generic `using tool`
- completion details are recorded into the activity log and only become visible later through the final `Commentary` artifact

That produces two UX problems:

- users do not know what subagents are doing while the turn is active
- successful subagent work is effectively invisible unless the user opens commentary

The current behavior is technically correct but too opaque for longer plan-mode and multi-agent turns.

## Requirements

- Reuse the existing live turn bubble. Do not send separate Telegram messages for routine subagent activity.
- Render subagent progress in the same bubble as the status text.
- Show a short detail block only while there is active collab work for the turn.
- The detail block must be a current snapshot, not a cumulative event feed.
- The block should contain:
  - one short header
  - up to 3 agent rows
  - an overflow row such as `- ...and 2 more` when needed
- Agent labels should prefer friendly names:
  - nickname if available
  - role if available
  - fallback labels like `agent 1`, `agent 2`
- Failures should be brief in the live bubble, for example `explorer: failed - timeout`.
- Final `Commentary` behavior should remain unchanged in this design.
- Telegram draft edits should only happen when the rendered visible text actually changes.

## Approaches Considered

### 1. Richer Single-Bubble Status

Keep the existing turn bubble and extend the rendered status draft with a subagent snapshot block.

Pros:

- lowest-noise UX
- fits Kirbot's current one-bubble turn model
- small conceptual change to lifecycle/finalization
- does not change final artifact publication rules

Cons:

- less detailed than a dedicated event feed
- requires new lifecycle-owned snapshot state

### 2. Separate Subagent Activity Messages

Send Telegram messages for spawn, wait start, wait finish, and failures.

Pros:

- very visible
- close to the Codex TUI transcript model

Cons:

- high chat noise
- more message ordering and cleanup complexity
- harder to keep readable during busy turns

### 3. Final-Only Summary

Keep live status generic and improve only the final commentary or final answer summary.

Pros:

- smallest implementation change
- no extra Telegram edit churn

Cons:

- does not solve the main visibility problem during active turns

### Recommendation

Use the richer single-bubble status approach. It gives users live visibility into subagent work without abandoning Kirbot's existing low-noise Telegram model.

## Design Summary

Add a lifecycle-owned `subagentSnapshot` to each active turn and pass it into status rendering.

When there is active collab work, the live Telegram bubble should render like:

```text
waiting · 14s

waiting for 2 agents
- explorer: running
- worker: completed
```

The top line remains the normal status line. The lower block is a concise snapshot derived from the latest active `collabAgentToolCall` state for the turn.

## Data Model

Extend turn-local lifecycle state with a nullable subagent snapshot. This state belongs near `TurnContext`, because it is visible-turn state rather than durable runtime transcript state.

Proposed shape:

```ts
type LiveSubagentSnapshot = {
  summary: string;
  agents: Array<{
    label: string;
    state: "pending" | "running" | "completed" | "failed" | "interrupted";
    detail: string | null;
  }>;
};
```

Notes:

- `summary` is the short block header, for example `waiting for 2 agents`.
- `agents` is already normalized for rendering.
- `detail` is optional and only used for short failure or completion previews.
- This structure is intentionally presentation-oriented. It should not preserve full upstream metadata.

## Lifecycle Ownership

`TurnLifecycleCoordinator` should own snapshot updates because it already sees both `itemStarted` and `itemCompleted` events for `collabAgentToolCall`.

### On `handleItemStarted(...)`

When a `collabAgentToolCall` starts:

- map the collab tool to a top-level status draft:
  - `spawnAgent` -> `spawning agent`
  - `wait` -> `waiting`
  - `resumeAgent` / `sendInput` -> `using tool` unless a clearer mapping is later desired
- seed or replace the turn's `subagentSnapshot`
- derive the initial header from the active tool
- populate friendly fallback agent labels from `receiverThreadIds` when available

### On `handleItemCompleted(...)`

When a `collabAgentToolCall` completes:

- if the completed item still represents the latest active collab state worth showing, refresh the snapshot from `agentsStates`
- normalize upstream agent statuses into the short live states
- capture only brief detail text
- clear the snapshot when no active collab work remains for the turn

The live bubble should always show the latest current snapshot rather than merging multiple collab items into one transcript-like history.

## Rendering Rules

Update `renderTelegramStatusDraft(...)` so it can accept optional subagent snapshot data and render a single Telegram message body.

Rendering rules:

- no snapshot: render status exactly as today
- snapshot present:
  - line 1 is the existing status line
  - insert one blank line
  - render the snapshot header
  - render up to 3 agent lines
  - if more agents exist, add `- ...and N more`

Agent line format:

- `- explorer: running`
- `- worker: completed`
- `- agent 2: failed - timeout`

The live block should not render:

- raw thread IDs
- raw tool names such as `spawnAgent`
- prompts
- model/reasoning metadata

Those remain appropriate for commentary, not the live bubble.

## Friendly Label Policy

The live bubble should prefer readable labels over technical identifiers.

Priority:

1. explicit nickname, if Kirbot can obtain one in future protocol revisions
2. agent role, if available
3. stable fallback label derived from current receiver order, for example `agent 1`

For this design, fallback labels are sufficient because the current app-server item shape available to Kirbot does not expose the richer TUI-side nickname/role data for all paths.

## Snapshot Semantics

This feature should be snapshot-based, not event-based.

That means:

- older subagent states do not remain visible after the snapshot changes
- no append-only history is shown in the live bubble
- the bubble is rewritten to the latest current state

This avoids Telegram churn and keeps the turn bubble readable during long agent runs.

## Failure Handling

The live bubble should show brief failures, but should not become a verbose stack trace surface.

Rules:

- use `failed` as the visible state
- append a short detail only when available
- trim detail aggressively
- do not include raw multi-line logs

Examples:

- `- explorer: failed`
- `- explorer: failed - timeout`

Structured failure detail should continue to live in final `Commentary`.

## Finalization Behavior

Turn finalization should remain unchanged in this design.

Specifically:

- successful and failed `collabAgentToolCall` completions still append activity log entries
- final `Commentary` artifact publication remains as-is
- no additional durable subagent summary is added to the final answer

The new live snapshot is purely an in-progress surface improvement.

## Update Suppression

Telegram edits should only happen when the rendered bubble text changes.

This matters because:

- subagent metadata may change without changing visible text
- the lifecycle already throttles some status edits
- avoiding redundant edits reduces Telegram churn and keeps tests stable

The comparison should happen on the fully rendered status bubble text, not on raw snapshot object identity.

## Testing Strategy

Add or update tests in `packages/kirbot-core/tests/` for:

- `spawnAgent` in progress with no known agent states yet
- `wait` in progress with two agents
- fallback labels `agent 1`, `agent 2`
- overflow behavior for more than 3 agents
- brief failure rendering with and without message detail
- no subagent block when no snapshot is active
- no redundant visible-message update when only invisible metadata changes

Also keep existing commentary tests unchanged to confirm that final durable reporting remains stable.

## Out Of Scope

This design does not:

- add a separate Telegram subagent activity feed
- change final `Commentary` formatting
- expose raw thread IDs in the live bubble
- add prompt previews, model names, or reasoning effort to the live subagent block
- attempt to mirror the Codex TUI transcript exactly

## Implementation Notes

The smallest clean change is:

- add `subagentSnapshot` to turn-local bridge state
- add a small presentation helper that builds the live subagent block
- update lifecycle methods that already process `collabAgentToolCall`
- extend status rendering to include the optional block

This keeps the feature isolated to live bridge presentation rather than spreading collab-specific formatting logic across finalization and artifact publication paths.
