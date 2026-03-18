# Plan Mode Telegram UX Planning Prompt

You are working in the Kirbot repository. Analyze the current codebase and produce a concrete implementation plan for adding Telegram-first plan mode support that matches the agreed product behavior below.

Do not implement code yet. Inspect the current codebase first, then write an implementation plan grounded in the actual files, abstractions, and tests that exist today.

## Product Goal

Kirbot should support an explicit plan workflow in Telegram that mirrors the intended Codex CLI-style interaction pattern:

1. Users enter plan mode with `/plan`.
2. While in plan mode, new turns start in Codex plan mode and Kirbot surfaces plan content clearly in Telegram.
3. Users exit plan mode with `/implement`.
4. Question prompts emitted by Codex during planning should be rendered cleanly and answered naturally in Telegram.

## Final UX Decisions

These are already decided. Your plan should treat them as requirements, not open questions.

### Entering plan mode

- `/plan some plan prompt`
  - Switch the topic/session into plan mode.
  - Start a new turn immediately using the provided prompt.
- `/plan`
  - Switch the topic/session into plan mode.
  - Acknowledge the mode change in Telegram.
  - Do not start a turn yet.

### Behavior while in plan mode

- In plan mode, normal user messages should start new turns in Codex plan mode.
- Kirbot should render plan progress and final plan output in Telegram.
- Codex user-input questions that happen during planning should be rendered with better UX than the current raw text / JSON reply flow.

### Exiting plan mode

- `/implement`
  - Switch the topic/session back to default mode.
  - Start a new default-mode turn that asks Codex to implement the latest plan.
- `/implement some last instructions`
  - Same as above, but include the extra instructions in the implementation request.

### Edge-case behavior

Treat these behaviors as the v1 decision:

- If a turn is already active, `/plan` or `/implement` should not try to change that active turn's mode via steer.
- Instead, Kirbot should reject the command with a clear Telegram message telling the user to wait for the current turn to finish or stop it first.

### Secret input handling

- `isSecret` does not require a DM flow for this product.
- Assume Kirbot runs only in private chats, so secret prompts can be answered in-place.
- The plan should still note whether the UI should visually distinguish secret prompts.

## Codex API Constraints Already Verified

Base your plan on these constraints:

1. Plan mode is not triggered by plain text alone.
- Codex plan mode must be selected explicitly on `turn/start` via `collaborationMode`.
- See:
  - `packages/codex-client/src/generated/codex/v2/TurnStartParams.ts`
  - `packages/codex-client/src/generated/codex/CollaborationMode.ts`
  - `packages/codex-client/src/generated/codex/ModeKind.ts`

2. Active turns cannot be switched into plan mode via steer.
- `turn/steer` does not expose collaboration mode.
- See:
  - `packages/codex-client/src/generated/codex/v2/TurnSteerParams.ts`

3. There is no dedicated Codex API operation for "implement the plan".
- `/implement` must be a Kirbot-level convention that starts a new default-mode turn in the same thread and asks Codex to implement the latest plan.

4. Thread-level metadata does not provide a native place to persist plan mode.
- If Kirbot wants sticky per-topic plan mode, it must persist that locally.
- See:
  - `packages/codex-client/src/generated/codex/v2/ThreadMetadataUpdateParams.ts`
  - `src/domain.ts`
  - `packages/kirbot-core/src/db.ts`

## Current Product / Code Gaps Already Identified

Your implementation plan should verify these and then build on them:

1. No slash-command parsing exists today.
- Text messages are forwarded directly as user input.
- Relevant files:
  - `packages/kirbot-core/src/bridge.ts`

2. Kirbot does not currently request plan mode on new turns.
- `CodexGateway.sendTurn()` only sends `threadId` and `input`.
- Relevant files:
  - `packages/codex-client/src/codex.ts`

3. Plan content is not properly surfaced today.
- `turn/plan/updated` only updates status.
- `item/plan/delta` is not handled.
- completed `plan` items are ignored.
- final turn readback only returns agent messages and drops plan items.
- Relevant files:
  - `packages/kirbot-core/src/bridge.ts`
  - `packages/kirbot-core/src/bridge/turn-lifecycle.ts`
  - `packages/kirbot-core/src/bridge/notifications.ts`
  - `packages/codex-client/src/codex.ts`
  - `packages/codex-client/src/generated/codex/v2/ThreadItem.ts`
  - `packages/codex-client/src/generated/codex/ServerNotification.ts`

4. User-input question UX is too primitive.
- Current behavior flattens prompts into raw text and asks for JSON for multi-question replies.
- It does not really use `header`, option descriptions, `isOther`, or `isSecret`.
- Relevant files:
  - `packages/kirbot-core/src/bridge/request-coordinator.ts`
  - `packages/kirbot-core/src/bridge/requests.ts`
  - `packages/codex-client/src/generated/codex/v2/ToolRequestUserInputQuestion.ts`
  - `packages/codex-client/src/generated/codex/v2/ToolRequestUserInputOption.ts`
  - `packages/codex-client/src/generated/codex/v2/ToolRequestUserInputResponse.ts`

## Specific Deliverables For Your Plan

Produce a concrete plan that includes all of the following.

### 1. Current-state analysis

Identify the exact files and functions that currently own:

- Telegram message intake and routing
- topic/session persistence
- active turn submission vs steer behavior
- Codex turn start calls
- server notification handling for plan-related events
- turn finalization and readback
- user-input request rendering and response parsing
- relevant tests that will need to change

### 2. Plan-mode architecture

Recommend the minimal robust design for:

- parsing `/plan` and `/implement`
- persisting per-topic preferred mode
- choosing collaboration mode on each new `turn/start`
- generating the implementation handoff prompt for `/implement`
- rejecting mode-changing commands while a turn is active

Be explicit about where mode state should live and how it should be read on each new turn.

### 3. Plan rendering design

Explain exactly how Kirbot should render:

- planning status updates
- streamed plan deltas
- completed plan items
- final plan-only turns
- mixed turns that contain both plan output and assistant messages

Be explicit about whether plan output should reuse existing draft/final rendering paths or introduce a separate one.

### 4. Question UX design

Explain how Telegram should render and resolve Codex questions during planning, including:

- single-question prompts
- multiple-question prompts
- option buttons when options are provided
- free-text answers
- handling of `header`, `description`, `isOther`, and `isSecret`

The goal is to replace the current "reply with JSON for multiple questions" UX with something more natural.

### 5. API fit / feasibility notes

Call out any required API-facing changes, especially:

- how `collaborationMode` should be constructed
- what model/settings data Kirbot must have available to construct it correctly
- whether current config and persisted thread/session state are sufficient
- whether Kirbot should require `CODEX_MODEL` or persist effective model metadata from Codex responses

### 6. Migration plan

Break the implementation into concrete phases with file-level detail.

Include:

- schema/database updates
- bridge routing changes
- Codex gateway changes
- plan rendering changes
- question UX changes
- tests to add or update

### 7. Risks and open questions

Include any real risks still left after the product decisions above, such as:

- mode persistence shape and backward compatibility
- constructing valid `collaborationMode.settings`
- behavior when readback contains both plan items and assistant messages
- request/reply correlation for multi-step question flows

## Important Constraints

- Base your plan on the repository as it exists now.
- Do not assume there is already a command-routing abstraction.
- Prefer the smallest coherent implementation that matches the agreed UX.
- Do not redesign unrelated bridge behavior.
- Keep the plan concrete and codebase-specific.

## Things To Verify During Analysis

- How new topic/session metadata can be stored with the current SQLite schema
- Whether `CodexGateway.createThread()` / `resumeThread()` responses expose enough effective model information to support collaboration-mode construction
- Whether plan output can be reconciled through existing streamed draft machinery or needs dedicated tracking
- Which tests already assert current status/update behavior for planning and user-input requests
- Whether any existing queue / steer behavior conflicts with the agreed command semantics

## Output Format

Return:

1. A short current-state summary
2. A concrete phased implementation plan
3. A list of required file changes
4. A risk list / open questions

When referencing code, cite exact files and relevant functions.
