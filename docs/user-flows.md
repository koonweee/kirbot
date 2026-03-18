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
- kirbot creates a Telegram topic for that request.
- kirbot creates a new Codex thread for that topic.
- kirbot mirrors the initial prompt into the new topic in a labeled preformatted block when there is prompt text to show.
- The first Codex turn starts immediately in the new topic.

Owned by:

- root-message routing in [`src/bridge.ts`](/home/jtkw/kirbot/src/bridge.ts)
- topic-title and link presentation in [`src/bridge/presentation.ts`](/home/jtkw/kirbot/src/bridge/presentation.ts)
- session persistence in [`src/db.ts`](/home/jtkw/kirbot/src/db.ts)

Verified by:

- lobby startup and initial-prompt mirroring behavior in [`tests/bridge.test.ts`](/home/jtkw/kirbot/tests/bridge.test.ts)

## 2. Start A Session Inside An Existing Topic

User experience:

- If the user sends a normal message inside a topic that kirbot has not mapped yet, kirbot starts a session in that existing topic instead of creating a new one.
- Later messages in that topic continue the same Codex thread.

Owned by:

- topic-message routing in [`src/bridge.ts`](/home/jtkw/kirbot/src/bridge.ts)
- session lookup and activation in [`src/db.ts`](/home/jtkw/kirbot/src/db.ts)

Verified by:

- unmapped-topic session creation tests in [`tests/bridge.test.ts`](/home/jtkw/kirbot/tests/bridge.test.ts)

## 3. Stream A Turn Back Into Telegram

User experience:

- kirbot shows a temporary status while Codex is thinking or using tools.
- Commentary, plan text, and final assistant output are treated differently so Telegram stays readable.
- In-progress planning stays in the status path; kirbot no longer streams partial plan text into Telegram bubbles.
- When the final plan item completes, kirbot persists the plan artifact and either posts a compact Telegram stub with an `Open plan` button or renders the completed plan from the stored artifact when Mini App support is disabled.
- When the turn finishes, kirbot clears drafts, sends durable final messages, and posts a completion footer with execution context.

Owned by:

- active-turn lifecycle in [`src/bridge/turn-lifecycle.ts`](/home/jtkw/kirbot/src/bridge/turn-lifecycle.ts)
- status, footer, and chunk rendering in [`src/bridge/presentation.ts`](/home/jtkw/kirbot/src/bridge/presentation.ts)
- draft and final delivery in [`src/telegram-messenger.ts`](/home/jtkw/kirbot/src/telegram-messenger.ts)
- Markdown/entity formatting in [`src/telegram-format`](/home/jtkw/kirbot/src/telegram-format)

Verified by:

- streaming, chunking, commentary, and footer tests in [`tests/bridge.test.ts`](/home/jtkw/kirbot/tests/bridge.test.ts)
- terminal-path tests in [`tests/turn-lifecycle.test.ts`](/home/jtkw/kirbot/tests/turn-lifecycle.test.ts)
- draft-delivery tests in [`tests/telegram-messenger.test.ts`](/home/jtkw/kirbot/tests/telegram-messenger.test.ts)

## 4. Send A Follow-Up While A Turn Is Still Running

User experience:

- A plain follow-up during an active turn is usually treated as steer input for the current turn.
- If kirbot loses the race to steer the active turn, the follow-up is queued for the next turn instead of being dropped.
- Telegram shows a queue preview so the user can see what is waiting.
- If there are pending steer messages, Telegram can expose a `Send now` action that interrupts the current turn and submits the queued steer input immediately.

Owned by:

- turn orchestration in [`src/bridge.ts`](/home/jtkw/kirbot/src/bridge.ts)
- in-memory queue state in [`src/turn-runtime.ts`](/home/jtkw/kirbot/src/turn-runtime.ts)
- queue-preview presentation in [`src/bridge/presentation.ts`](/home/jtkw/kirbot/src/bridge/presentation.ts)
- final drain and requeue behavior in [`src/bridge/turn-lifecycle.ts`](/home/jtkw/kirbot/src/bridge/turn-lifecycle.ts)

Verified by:

- steer, queueing, and send-now tests in [`tests/bridge.test.ts`](/home/jtkw/kirbot/tests/bridge.test.ts)
- pending-steer finalization tests in [`tests/turn-lifecycle.test.ts`](/home/jtkw/kirbot/tests/turn-lifecycle.test.ts)

## 5. Stop The Current Response

User experience:

- `/stop` interrupts the active turn for the current topic.
- If the turn is already finishing, the user gets a clear response instead of a duplicate interrupt.
- Pending steer instructions can be submitted right after the interrupt completes.

Owned by:

- topic command handling in [`src/bridge.ts`](/home/jtkw/kirbot/src/bridge.ts)
- post-interrupt finalization in [`src/bridge/turn-lifecycle.ts`](/home/jtkw/kirbot/src/bridge/turn-lifecycle.ts)

Verified by:

- stop and stale-interrupt tests in [`tests/bridge.test.ts`](/home/jtkw/kirbot/tests/bridge.test.ts)

## 6. Switch Between Planning And Implementation

User experience:

- `/plan` enables plan mode for a topic.
- `/plan` from the lobby creates a new plan-oriented topic and can optionally start a turn immediately if the command includes a prompt.
- `/implement` switches the topic back to default implementation mode and starts a normal turn on the existing thread context.
- Mode changes are blocked while a turn is still active.

Owned by:

- slash-command routing in [`src/bridge.ts`](/home/jtkw/kirbot/src/bridge.ts)
- command definitions in [`src/telegram-commands.ts`](/home/jtkw/kirbot/src/telegram-commands.ts)
- preferred-mode persistence in [`src/db.ts`](/home/jtkw/kirbot/src/db.ts)

Verified by:

- root and topic mode-command tests in [`tests/bridge.test.ts`](/home/jtkw/kirbot/tests/bridge.test.ts)
- command-menu tests in [`tests/telegram-command-sync.test.ts`](/home/jtkw/kirbot/tests/telegram-command-sync.test.ts)

## 7. Handle Approvals And Structured User Input

User experience:

- When Codex asks for command approval, file approval, or structured user input, kirbot presents that request inside the same Telegram topic.
- Button presses resolve approvals directly.
- Structured user input can progress through multiple questions and can fall back to free text when the prompt allows an `Other` path.
- Normal topic messages are interpreted as answers only when a pending question is currently waiting for free text.

Owned by:

- request routing in [`src/bridge/request-coordinator.ts`](/home/jtkw/kirbot/src/bridge/request-coordinator.ts)
- request persistence in [`src/db.ts`](/home/jtkw/kirbot/src/db.ts)
- status updates for waiting turns in [`src/bridge/turn-lifecycle.ts`](/home/jtkw/kirbot/src/bridge/turn-lifecycle.ts)

Verified by:

- approval and user-input request tests in [`tests/bridge.test.ts`](/home/jtkw/kirbot/tests/bridge.test.ts)
- request persistence tests in [`tests/db.test.ts`](/home/jtkw/kirbot/tests/db.test.ts)

## 8. Send Images

User experience:

- A Telegram photo or image document is forwarded to Codex as turn input.
- kirbot stores a temporary local copy only for as long as the turn needs it.
- If submission fails or the turn reaches a terminal state, those temporary files are cleaned up.

Owned by:

- Telegram image message intake in [`src/index.ts`](/home/jtkw/kirbot/src/index.ts)
- temporary media lifecycle in [`src/media-store.ts`](/home/jtkw/kirbot/src/media-store.ts)
- turn cleanup in [`src/bridge.ts`](/home/jtkw/kirbot/src/bridge.ts) and [`src/bridge/turn-lifecycle.ts`](/home/jtkw/kirbot/src/bridge/turn-lifecycle.ts)

Verified by:

- image retention and cleanup tests in [`tests/bridge.test.ts`](/home/jtkw/kirbot/tests/bridge.test.ts)

## 9. Recover Across Restarts And Topic Closure

User experience:

- If the process restarts, stale pending requests are expired rather than left hanging forever.
- If a Telegram topic is closed, kirbot archives the mapped Codex thread.
- Duplicate Telegram updates are ignored so retries do not create duplicate turns.

Owned by:

- startup cleanup in [`src/index.ts`](/home/jtkw/kirbot/src/index.ts)
- topic archival in [`src/bridge.ts`](/home/jtkw/kirbot/src/bridge.ts)
- update deduplication and persistence in [`src/db.ts`](/home/jtkw/kirbot/src/db.ts)

Verified by:

- restart and archival behavior in [`tests/db.test.ts`](/home/jtkw/kirbot/tests/db.test.ts) and [`tests/bridge.test.ts`](/home/jtkw/kirbot/tests/bridge.test.ts)

## Flow Boundaries That Matter

These are the constraints most likely to matter during onboarding:

- The Telegram topic is the stable user-facing unit of conversation.
- The Codex thread is the stable model-facing unit of conversation.
- The bridge owns the mapping between those two units.
- Presentation rules live in bridge presentation and Telegram formatting code, not in flow orchestration.
- Tests are the authoritative place to inspect edge-case behavior before changing a flow.
