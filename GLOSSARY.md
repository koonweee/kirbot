# Glossary

This file defines the repo-local terms that show up in docs, tests, and bridge
code. It is intentionally short and focuses on the stable mental model.

## Conversation Units

`root chat`

The top-level private Telegram chat with the bot, outside any topic. A normal
message here usually creates a new topic and a new Codex thread.

`lobby`

Shorthand for the root chat. In repo docs and tests, `lobby` and `root chat`
mean the same user-facing place.

`topic`

A Telegram topic inside the root chat. This is the stable user-facing unit of
conversation.

`thread`

A Codex thread. This is the stable model-facing unit of conversation that kirbot
maps to a Telegram topic.

`root thread`

Not a separate persisted concept in kirbot. When this phrase appears casually,
it usually refers to the root Telegram chat outside topics, or to Telegram's own
topic/thread wording. Prefer `root chat` for the Telegram side and `Codex
thread` for the model side to avoid ambiguity.

## Telegram Output Terms

`status draft`

The temporary Telegram draft that shows current turn state while Codex is still
working, such as `thinking`, `running: npm test`, or `waiting`.

`status block` / `status message`

Informal names for the rendered status text shown to the user. In practice this
is usually the status draft message in Telegram.

`commentary`

Intermediate assistant narration about ongoing work. Commentary is buffered
during the turn, then exposed separately from the final answer so the topic
stays readable.

`commentary block` / `commentary message`

The Telegram affordance that exposes commentary. When Mini App support is
configured, this is usually a `Commentary` Mini App button on the
following assistant message. If no assistant message follows, kirbot can send a
compact commentary stub instead.

`footer`

The completion metadata shown after a turn finishes, such as model, reasoning
effort, duration, changed files, remaining context, working directory, and git
branch.

`footer block` / `footer message`

The rendered Telegram message for that completion metadata. It is separate from
the final answer text.

## Rendering Language

`block`

A logical rendered output unit in kirbot's presentation language. A block often
becomes one Telegram message, but long outputs can be split into multiple
messages.

`message`

An actual Telegram message, draft, or persisted post. Repo discussions
sometimes use `block` and `message` loosely when the distinction does not
matter.
