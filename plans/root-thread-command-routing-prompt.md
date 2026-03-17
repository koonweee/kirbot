# Root Thread Command Routing Planning Prompt

You are working in the Kirbot repository. Analyze the current codebase and produce a concrete implementation plan for supporting bot-level commands in the Telegram root thread without always creating a new Telegram topic.

Do not implement code yet. Inspect the current codebase first, then write a concrete plan grounded in the actual files, abstractions, and test coverage that exist today.

## Context

Kirbot currently treats any Telegram message that does not have a `message_thread_id` as a request to start a new session topic.

That behavior is wired into the bridge today. We want to preserve the existing default for ordinary root-thread messages, but introduce a clean extension point so some root-thread messages can be handled in place as bot-level commands.

Examples of desired future behavior:

- `/help` handled in the root thread
- `/sessions` handled in the root thread
- `/new Fix the failing tests` explicitly creates a new session topic
- plain text in the root thread still creates a new topic by default

Strong preference: this logic should live in the bridge layer, not in the Telegram transport entrypoint.

## Key Design Direction

The current Telegram entrypoint in `src/index.ts` should remain transport-thin. It should continue to normalize Telegram updates into bridge inputs and avoid accumulating routing policy.

The main architectural change should happen around the current `topicId === null` path in `TelegramCodexBridge.handleUserMessage(...)`, which currently hard-routes to `startSessionFromRootMessage(...)`.

We want a first-class root-thread routing layer that:

1. can decide whether a root-thread message is:
   - a root-level command handled in place, or
   - a normal message that should create a new session topic
2. is easy to extend with more root-level commands later
3. does not tangle root-thread command logic with in-topic session handling

## Specific Deliverables For Your Plan

Produce a concrete plan that includes:

1. A current-state analysis
- Identify the files and functions currently responsible for:
  - Telegram message intake
  - root-thread detection
  - topic creation from root messages
  - in-topic session creation and turn submission
  - any current command or callback-query routing
  - tests that currently lock in root-thread behavior

2. A proposed architecture
- Recommend the module layout for a root-thread router or lobby router.
- Explain where the dispatch boundary should live.
- Explain whether the router should return a disposition/result type, throw, or directly own side effects.
- Explain how to keep root-thread handling separate from in-topic session behavior.

3. A command-handling model
- Recommend how root commands should be recognized.
- Address at least:
  - known slash commands such as `/help`, `/sessions`, `/new`
  - unknown slash commands
  - non-command text in the root thread
  - non-text root-thread messages such as photos/documents
- Explicitly say whether unknown slash commands should:
  - show help / an error in root, or
  - fall through to topic creation

4. A migration plan
- Break the work into implementation phases with file-level detail.
- Include the minimal first slice that introduces the extension point without overbuilding.
- Include test changes and new tests required.
- Call out whether any existing tests should be rewritten versus supplemented.

5. Risks and edge cases
- Include Telegram root-thread messages that do not include text.
- Include duplicate update handling and idempotency.
- Include callback-query behavior if root-level buttons are added later.
- Include how to avoid accidental regressions in current root-message-to-topic behavior.
- Include how this should interact with existing auth / allowed-user checks.

## Important Constraints

- Base your plan on the code as it exists in this repository now.
- Do not move routing policy into `src/index.ts` unless the current code forces it and you can justify that with evidence.
- Prefer the simplest robust architecture that creates a stable home for future extensions.
- Do not propose a large generic command framework unless the current code structure truly benefits from it.
- Keep the final plan concrete, not aspirational.

## Things To Verify During Analysis

- Exactly where `topicId` is derived from Telegram updates.
- Exactly where `topicId === null` currently becomes `createForumTopic(...)`.
- Whether root-thread photos/documents currently create topics too.
- Whether callback queries already have topic-sensitive behavior that should influence the design.
- Which existing tests prove the current root-thread semantics.

## Output Format

Return:

1. A short current-state summary
2. A concrete phased implementation plan
3. A proposed router/handler shape
4. A risk list / open questions

When referencing code, cite exact files and relevant functions.
