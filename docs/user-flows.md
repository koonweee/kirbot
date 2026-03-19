# User Flows

This document explains kirbot from the user’s point of view and maps each flow to the code that owns it. It intentionally avoids restating low-level implementation details that already live in code and tests.

For the module map, read [architecture.md](architecture.md).

## Reading This File

Each flow has three lenses:

- what the Telegram user experiences
- which module owns the behavior
- which tests lock the behavior down

## 1. Start A Session From The Lobby

User experience:

- The user sends a normal message in the root private chat or lobby.
- kirbot creates a Telegram topic with a random icon for that request.
- kirbot creates a new Codex thread for that topic.
- kirbot posts a startup footer in the topic before any other topic message.
- kirbot mirrors the initial prompt into the new topic in a labeled preformatted block when there is prompt text to show.
- The first Codex turn starts immediately in the new topic.
- The user can also run `/start <path>` from the lobby to create a new empty topic and Codex thread in that directory without sending an initial turn.

Owned by:

- root-message routing in [`packages/kirbot-core/src/bridge.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/bridge.ts)
- topic-title and link presentation in [`packages/kirbot-core/src/bridge/presentation.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/bridge/presentation.ts)
- session persistence in [`packages/kirbot-core/src/db.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/db.ts)

Verified by:

- lobby startup and initial-prompt mirroring behavior in [`packages/kirbot-core/tests/bridge.test.ts`](/home/jtkw/kirbot/packages/kirbot-core/tests/bridge.test.ts)

## 2. Start A Session Inside An Existing Topic

User experience:

- If the user sends a normal message inside a topic that kirbot has not mapped yet, kirbot starts a session in that existing topic instead of creating a new one.
- kirbot posts the startup footer before any other topic message for that new thread.
- Later messages in that topic continue the same Codex thread.

Owned by:

- topic-message routing in [`packages/kirbot-core/src/bridge.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/bridge.ts)
- session lookup and activation in [`packages/kirbot-core/src/db.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/db.ts)

Verified by:

- unmapped-topic session creation tests in [`packages/kirbot-core/tests/bridge.test.ts`](/home/jtkw/kirbot/packages/kirbot-core/tests/bridge.test.ts)

## 3. Stream A Turn Back Into Telegram

User experience:

- kirbot shows a temporary status while Codex is thinking or using tools.
- Live status drafts stay compact as state plus elapsed time; tool details and
  commentary stay out of the draft itself.
- Commentary, plan text, and final assistant output are treated differently so Telegram stays readable.
- Commentary artifacts foreground assistant prose and collapse completed or
  failed work into compact `Logs` sections inside the Mini App. Failed commands
  still include the command in a code block, inline `CWD`/exit metadata, and a
  bounded error block when output is available. Failed file changes, tool
  calls, agent tasks, and image generations use the same structured failure
  treatment when metadata is available.
- Final assistant output is published as a single Telegram message with a `Response` Mini App button, and oversized messages are truncated with a note to continue in View.
- When commentary also exists, the same assistant message gets a second `Commentary` button. If no assistant message follows, commentary is exposed through a compact stub instead.
- In-progress planning stays in the status path; kirbot no longer streams partial plan text into Telegram bubbles.
- When the final plan item completes, kirbot posts a compact Telegram stub with `Plan` and `Implement` actions so the user can inspect the plan or immediately start implementation in the same topic.
- When the turn finishes, kirbot clears drafts, sends durable final messages, and posts a completion footer with execution context.

Owned by:

- active-turn lifecycle in [`packages/kirbot-core/src/bridge/turn-lifecycle.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/bridge/turn-lifecycle.ts)
- status, footer, truncation, and Mini App button rendering in [`packages/kirbot-core/src/bridge/presentation.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/bridge/presentation.ts)
- draft and final delivery in [`packages/kirbot-core/src/telegram-messenger.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/telegram-messenger.ts)
- Markdown/entity formatting in [`packages/telegram-format/src`](/home/jtkw/kirbot/packages/telegram-format/src)

Verified by:

- streaming, truncation, commentary, response-button, and footer tests in [`packages/kirbot-core/tests/bridge.test.ts`](/home/jtkw/kirbot/packages/kirbot-core/tests/bridge.test.ts)
- terminal-path tests in [`packages/kirbot-core/tests/turn-lifecycle.test.ts`](/home/jtkw/kirbot/packages/kirbot-core/tests/turn-lifecycle.test.ts)
- draft-delivery tests in [`packages/kirbot-core/tests/telegram-messenger.test.ts`](/home/jtkw/kirbot/packages/kirbot-core/tests/telegram-messenger.test.ts)

## 4. Send A Follow-Up While A Turn Is Still Running

User experience:

- A plain follow-up during an active turn is usually treated as steer input for the current turn.
- If kirbot loses the race to steer the active turn, the follow-up is queued for the next turn instead of being dropped.
- Telegram shows a queue preview so the user can see what is waiting.
- If there are pending steer messages, Telegram can expose a `Send now` action that interrupts the current turn and submits the queued steer input immediately.

Owned by:

- turn orchestration in [`packages/kirbot-core/src/bridge.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/bridge.ts)
- in-memory queue state in [`packages/kirbot-core/src/turn-runtime.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/turn-runtime.ts)
- queue-preview presentation in [`packages/kirbot-core/src/bridge/presentation.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/bridge/presentation.ts)
- final drain and requeue behavior in [`packages/kirbot-core/src/bridge/turn-lifecycle.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/bridge/turn-lifecycle.ts)

Verified by:

- steer, queueing, and send-now tests in [`packages/kirbot-core/tests/bridge.test.ts`](/home/jtkw/kirbot/packages/kirbot-core/tests/bridge.test.ts)
- pending-steer finalization tests in [`packages/kirbot-core/tests/turn-lifecycle.test.ts`](/home/jtkw/kirbot/packages/kirbot-core/tests/turn-lifecycle.test.ts)

## 5. Stop The Current Response

User experience:

- `/stop` interrupts the active turn for the current topic.
- If the turn is already finishing, the user gets a clear response instead of a duplicate interrupt.
- Pending steer instructions can be submitted right after the interrupt completes.

Owned by:

- topic command handling in [`packages/kirbot-core/src/bridge.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/bridge.ts)
- post-interrupt finalization in [`packages/kirbot-core/src/bridge/turn-lifecycle.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/bridge/turn-lifecycle.ts)

Verified by:

- stop and stale-interrupt tests in [`packages/kirbot-core/tests/bridge.test.ts`](/home/jtkw/kirbot/packages/kirbot-core/tests/bridge.test.ts)

## 6. Change Global Codex Settings

User experience:

- `/model`, `/fast`, and `/permissions` change global Codex defaults for all topics, whether the user runs them from the lobby or inside a topic.
- The settings UI no longer requires an existing topic session.
- Changes apply immediately to loaded threads and future topics instead of waiting for the next turn in one topic.
- `/approvals` remains an alias for `/permissions`.

Owned by:

- global slash-command routing in [`packages/kirbot-core/src/bridge.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/bridge.ts)
- command definitions in [`packages/kirbot-core/src/bridge/slash-commands.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/bridge/slash-commands.ts)
- app-server config read/write in [`packages/codex-client/src/codex.ts`](/home/jtkw/kirbot/packages/codex-client/src/codex.ts) and [`packages/codex-client/src/rpc.ts`](/home/jtkw/kirbot/packages/codex-client/src/rpc.ts)

Verified by:

- global settings command and callback tests in [`packages/kirbot-core/tests/bridge.test.ts`](/home/jtkw/kirbot/packages/kirbot-core/tests/bridge.test.ts)
- command-menu tests in [`packages/kirbot-core/tests/telegram-command-sync.test.ts`](/home/jtkw/kirbot/packages/kirbot-core/tests/telegram-command-sync.test.ts)

## 7. Manage Custom Thread Commands

User experience:

- `/cmd` in the lobby shows a short help blurb for `add`, `update`, and `delete`.
- `/cmd add <command> <prompt>` validates the command name and prompt, then sends a confirmation message in the lobby with `Add` and `Cancel` buttons instead of creating the command immediately.
- `/cmd update <command> <prompt>` and `/cmd delete <command>` update the saved command set immediately after validation.
- Confirmed custom commands are typed-only; kirbot does not add them to Telegram’s visible slash-command picker.
- A custom command can be invoked only inside topics. When invoked, kirbot expands it to the stored prompt text plus any extra trailing text and routes it like a normal user message, including session bootstrap in an unmapped topic and steer or queue behavior during an active turn.

Owned by:

- root `/cmd` routing and typed custom command invocation in [`packages/kirbot-core/src/bridge.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/bridge.ts)
- custom command parsing and validation helpers in [`packages/kirbot-core/src/bridge/custom-commands.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/bridge/custom-commands.ts)
- custom command persistence and pending add confirmation state in [`packages/kirbot-core/src/db.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/db.ts)

Verified by:

- custom command management and invocation tests in [`packages/kirbot-core/tests/bridge.test.ts`](/home/jtkw/kirbot/packages/kirbot-core/tests/bridge.test.ts)
- custom command persistence tests in [`packages/kirbot-core/tests/db.test.ts`](/home/jtkw/kirbot/packages/kirbot-core/tests/db.test.ts)
- command-menu tests in [`packages/kirbot-core/tests/telegram-command-sync.test.ts`](/home/jtkw/kirbot/packages/kirbot-core/tests/telegram-command-sync.test.ts)

## 8. Switch Between Planning And Implementation

User experience:

- `/plan` enables plan mode for a topic.
- `/plan` from the lobby creates a new plan-oriented topic and can optionally start a turn immediately if the command includes a prompt.
- `/implement` switches the topic back to default implementation mode and starts a normal turn on the existing thread context.
- Mode changes are blocked while a turn is still active.

Owned by:

- slash-command routing in [`packages/kirbot-core/src/bridge.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/bridge.ts)
- command definitions in [`packages/kirbot-core/src/telegram-commands.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/telegram-commands.ts)
- preferred-mode persistence in [`packages/kirbot-core/src/db.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/db.ts)

Verified by:

- root and topic mode-command tests in [`packages/kirbot-core/tests/bridge.test.ts`](/home/jtkw/kirbot/packages/kirbot-core/tests/bridge.test.ts)
- command-menu tests in [`packages/kirbot-core/tests/telegram-command-sync.test.ts`](/home/jtkw/kirbot/packages/kirbot-core/tests/telegram-command-sync.test.ts)

## 9. Handle Approvals And Structured User Input

User experience:

- When Codex asks for command approval, file approval, or structured user input, kirbot presents that request inside the same Telegram topic.
- Command approvals render as structured cards with the command in a code block,
  `CWD` in inline code, clearer scope wording, and explicit approval button
  labels.
- File approvals render as structured cards too, including the reason,
  requested reusable write root when available, and clearer scope wording.
- Button presses resolve approvals directly.
- Structured user input can progress through multiple questions and can fall back to free text when the prompt allows an `Other` path.
- Normal topic messages are interpreted as answers only when a pending question is currently waiting for free text.

Owned by:

- request routing in [`packages/kirbot-core/src/bridge/request-coordinator.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/bridge/request-coordinator.ts)
- request persistence in [`packages/kirbot-core/src/db.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/db.ts)
- status updates for waiting turns in [`packages/kirbot-core/src/bridge/turn-lifecycle.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/bridge/turn-lifecycle.ts)

Verified by:

- approval and user-input request tests in [`packages/kirbot-core/tests/bridge.test.ts`](/home/jtkw/kirbot/packages/kirbot-core/tests/bridge.test.ts)
- request persistence tests in [`packages/kirbot-core/tests/db.test.ts`](/home/jtkw/kirbot/packages/kirbot-core/tests/db.test.ts)

## 10. Send Images

User experience:

- A Telegram photo or image document is forwarded to Codex as turn input.
- kirbot stores a temporary local copy only for as long as the turn needs it.
- If submission fails or the turn reaches a terminal state, those temporary files are cleaned up.

Owned by:

- Telegram image message intake in [`apps/bot/src/index.ts`](/home/jtkw/kirbot/apps/bot/src/index.ts)
- temporary media lifecycle in [`packages/kirbot-core/src/media-store.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/media-store.ts)
- turn cleanup in [`packages/kirbot-core/src/bridge.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/bridge.ts) and [`packages/kirbot-core/src/bridge/turn-lifecycle.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/bridge/turn-lifecycle.ts)

Verified by:

- image retention and cleanup tests in [`packages/kirbot-core/tests/bridge.test.ts`](/home/jtkw/kirbot/packages/kirbot-core/tests/bridge.test.ts)

## 11. Recover Across Restarts And Topic Closure

User experience:

- If the process restarts, stale pending requests are expired rather than left hanging forever.
- If a Telegram topic is closed, kirbot archives the mapped Codex thread.
- Duplicate Telegram updates are ignored so retries do not create duplicate turns.

Owned by:

- startup cleanup in [`apps/bot/src/index.ts`](/home/jtkw/kirbot/apps/bot/src/index.ts)
- topic archival in [`packages/kirbot-core/src/bridge.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/bridge.ts)
- update deduplication and persistence in [`packages/kirbot-core/src/db.ts`](/home/jtkw/kirbot/packages/kirbot-core/src/db.ts)

Verified by:

- restart and archival behavior in [`packages/kirbot-core/tests/db.test.ts`](/home/jtkw/kirbot/packages/kirbot-core/tests/db.test.ts) and [`packages/kirbot-core/tests/bridge.test.ts`](/home/jtkw/kirbot/packages/kirbot-core/tests/bridge.test.ts)

## Flow Boundaries That Matter

These are the constraints most likely to matter during onboarding:

- The Telegram topic is the stable user-facing unit of conversation.
- The Codex thread is the stable model-facing unit of conversation.
- The bridge owns the mapping between those two units.
- Presentation rules live in bridge presentation and Telegram formatting code, not in flow orchestration.
- Tests are the authoritative place to inspect edge-case behavior before changing a flow.
