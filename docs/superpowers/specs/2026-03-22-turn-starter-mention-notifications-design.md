# Turn-Starter Mention Notifications Design

## Summary

Kirbot should mention the Telegram user who started the relevant turn or
request when it sends a message that intentionally triggers a Telegram
notification for that specific piece of work. The mention should be a plain
`@username` prefix, and Kirbot should omit the mention entirely when the
originating user has no Telegram username.

This applies to turn-scoped assistant notifications and request-scoped
intervention prompts. It does not apply to silent status updates, generic
topic-level messages, or other notifications that are not tied to one user's
request.

## Goals

- Make notification-bearing Kirbot messages visibly target the user who started
  the relevant turn or request.
- Preserve current notification behavior, adding a mention only where Kirbot
  already sends a noisy message.
- Keep the rule narrow and predictable so Kirbot does not over-mention users in
  shared topics.
- Cover edge cases where the only notifying output is an artifact-availability
  message rather than a normal final assistant reply.

## Non-Goals

- Mentioning users who do not have a Telegram username.
- Falling back to display names, user IDs, or `text_mention` entities.
- Adding mentions to silent status bubbles, queue previews, provisioning
  messages, startup footers, or other generic topic-level messages.
- Mentioning every message in a completion path. Only the primary notifying
  message for that turn or request should mention the user.
- Redesigning Telegram delivery or notification policy beyond this mention
  behavior.

## Product Decisions

### Mention Format

- Use a literal `@username ` prefix at the start of the message body.
- Do not create a fallback mention when `username` is absent.
- Do not attempt direct user mentions by Telegram user ID or display name.

### Mention Scope

- Mention only when the outgoing message belongs to a specific user-started
  turn or request.
- Mention only on messages that Kirbot already sends with notifications
  enabled.
- Omit mentions on generic topic-level notifications even if they happen near a
  user action.

### Notification Selection

- Each turn or request should have at most one primary notifying message that
  gets the mention.
- For normal turn completion, the final assistant message is the primary
  notifying message.
- For approval, permissions, or structured user-input requests, the prompt
  message is the primary notifying message.
- For plan-only completion, the first plan artifact publication or its oversize
  fallback is the primary notifying message.
- For commentary-only or response-only artifact output, the first notifying
  artifact-availability message is the primary notifying message when no normal
  final assistant reply is sent.

## Current State

Kirbot currently captures `userId` and `actorLabel` from Telegram updates but
drops the sender's `username` before the message reaches the bridge. Outbound
message paths already distinguish between silent and notifying sends via
`disableNotification`, but they do not currently have a turn-starter mention
concept.

The relevant code paths are:

- `apps/bot/src/index.ts` for Telegram ingress.
- `packages/kirbot-core/src/domain.ts` for `UserTurnMessage`.
- `packages/kirbot-core/src/bridge/turn-context.ts` and
  `packages/kirbot-core/src/bridge/turn-lifecycle.ts` for active turn state.
- `packages/kirbot-core/src/bridge/turn-finalization.ts` for final assistant,
  commentary, response, and plan completion messages.
- `packages/kirbot-core/src/bridge/request-coordinator.ts` for approval,
  permissions, and user-input prompts.

## Proposed Design

### Capture And Carry Username

- Extend inbound Telegram message handling in `apps/bot/src/index.ts` to read
  `context.message.from.username`.
- Add an optional `telegramUsername` field to `UserTurnMessage`.
- Copy that username into active `TurnContext` so completion-time message
  publishing can use it without reaching back into Telegram update objects.
- Keep queued follow-ups and pending steers carrying the same
  `telegramUsername` as the originating message so downstream turn-scoped
  notifications remain attributable.

### Mention Formatting Helper

- Add a small helper in the bridge layer that prepends `@username ` to an
  existing `{ text, entities }` payload.
- If `username` is missing or blank, return the original payload unchanged.
- When a message already has Telegram entities, shift all entity offsets by the
  UTF-16 length of the prefix so existing formatting remains correct.
- Keep the helper string-based. No new Telegram entity type is required because
  the requested behavior is the visible `@username` text itself.

### Turn-Scoped Notification Publishing

Turn finalization should choose the primary notifying message for the turn, then
apply the mention only there.

#### Normal Final Assistant Reply

- When finalization publishes a normal final assistant message with
  `disableNotification: false`, prepend the turn starter's `@username`.

#### Commentary-Only Or Response-Only Output

- If a turn's user-visible notifying output is the first standalone commentary
  artifact message, prepend the turn starter's `@username` there.
- If a turn's user-visible notifying output is the first standalone response
  artifact message, prepend the turn starter's `@username` there.
- This rule matters when the turn produces a notifying artifact-availability
  message instead of a normal final assistant reply.

#### Plan-Only Output

- When a completed turn publishes only plan artifact messages, prepend the turn
  starter's `@username` to the first notifying plan publication.
- If the plan artifact is too large and Kirbot falls back to the oversize
  message, that fallback should receive the mention because it is the notifying
  message on that path.

### Request-Scoped Prompt Publishing

- Approval prompts in `request-coordinator.ts` should mention the user who
  started the associated turn or request.
- Permissions approval prompts should do the same.
- Structured user-input prompts should do the same.
- These are request-scoped notification messages and should stay within the same
  username-only rule.

## Primary Notifying Message Rule

The implementation should make the "primary notifying message" explicit rather
than scattered across individual send calls.

- Completion paths should decide whether the notifying message is:
  - the final assistant reply
  - the first commentary artifact message
  - the first response artifact message
  - the first plan artifact message
  - the oversize fallback for one of those artifact types
- Once that selection is made, only that first notifying message should receive
  the mention.
- Additional artifact chunks in the same completion path should remain silent
  and unmentioned.

This keeps shared-topic notification behavior predictable and avoids multiple
mentions for one user action.

## Messages That Must Not Mention

- Status bubble sends and edits in `telegram-turn-surface.ts`.
- Queue preview messages and updates.
- Session provisioning notices.
- Session startup footers and initial prompt mirrors.
- Generic bridge messages such as invalid-command feedback or workspace
  guidance.
- Completion footer messages unless they become the sole primary notifying
  message for a user-scoped path, which is not part of the current design.

## Risks

### Username Availability

Some Telegram users do not have usernames. In those cases, Kirbot will emit the
same notifying message it emits today, just without a mention. That is expected
behavior, not an error condition.

### Entity Offset Bugs

Prepending text to messages with existing Telegram entities can corrupt
formatting if offsets are not shifted in UTF-16 code units. The helper should
centralize this logic rather than duplicating it across send sites.

### Over-Mentioning In Shared Topics

If the primary-notifying-message rule is not explicit, multiple messages in one
completion path could mention the same user. The implementation should choose
the notifying message once per path and keep every other message unchanged.

## Verification Targets

Add tests for:

- Telegram ingress capturing `username` into `UserTurnMessage`.
- Mention helper behavior with no username, simple plain text, and existing
  entities.
- Final assistant completion with a username.
- Final assistant completion without a username.
- Commentary-only notifying output.
- Response-only notifying output.
- Plan-only notifying output.
- Oversize plan/commentary/response fallback messages when they are the
  notifying path.
- Approval prompts with mentions.
- Permissions approval prompts with mentions.
- Structured user-input prompts with mentions.
- Silent status and queue preview paths remaining unmentioned.

## Recommendation

Implement the narrow username-only design: capture the initiating Telegram
username at ingress, carry it through turn and request state, and prepend
`@username` only on the primary notifying message for that specific turn or
request. This solves the shared-topic notification targeting problem without
changing Kirbot's broader notification policy.
