# PR Outline: Telegram Entity Formatting Migration

## Summary

This PR replaces Kirbot's Telegram HTML formatting path with a Kirbot-owned
`FormattedText` abstraction backed by Telegram `MessageEntity[]`.

## What Changed

### New formatting layer

- Added `src/telegram-format/`:
  - `entity-builder.ts`
    - builder-first API for plain text plus explicit entity annotations
  - `markdown.ts`
    - Markdown to `FormattedText` via `mdast-util-from-markdown` and micromark
  - `preformatted.ts`
    - literal preformatted rendering for commentary/code-style output
  - `chunk.ts`
    - UTF-16-safe chunking and prefix shifting for multi-part Telegram messages
  - `utf16.ts`
    - surrogate-pair-safe split helpers
  - `types.ts`
    - shared `FormattedText` model and entity helpers

### Transport changes

- Removed Kirbot-owned `parseMode` support from `src/telegram-messenger.ts`
- Telegram drafts and final sends now carry:
  - plain text only, or
  - plain text plus `entities`
- Draft dedupe now compares full rendered payloads instead of `text + parseMode`

### Presentation changes

- Removed all HTML construction from `src/bridge/presentation.ts`
- Assistant drafts/finals now render Markdown to text + entities
- Commentary drafts/finals now render as literal `pre` entities with language
  `kirbot`
- Final message chunking now happens after formatting, so entity offsets stay
  aligned

### Tests

- Added `tests/telegram-format.test.ts`
- Updated bridge, messenger, and lifecycle tests to assert entity payloads
  instead of HTML strings and `parse_mode`

## High-ROI Coverage Added

- Manual entity builder path for non-Markdown callers
- Nested Markdown formatting
- UTF-16 offsets around emoji
- Fenced code blocks with language
- Blockquote rendering
- Unsupported syntax staying literal
- Entity-preserving chunking
- Header prefix offset shifting for multipart messages

## Example Flows

### Assistant draft

Input:

```md
Use **bold** and `code`.
```

Telegram payload:

```ts
{
  text: "Use bold and code.",
  entities: [
    { type: "bold", offset: 4, length: 4 },
    { type: "code", offset: 13, length: 4 }
  ]
}
```

### Final assistant message with fenced code

Input:

````md
Use **bold** and `code`.

```ts
const answer = 42;
```
````

Telegram payload:

```ts
{
  text: "Use bold and code.\n\nconst answer = 42;",
  entities: [
    { type: "bold", offset: 4, length: 4 },
    { type: "code", offset: 13, length: 4 },
    { type: "pre", offset: 20, length: 18, language: "ts" }
  ]
}
```

### Commentary draft/final

Input:

```text
Inspecting the files
```

Telegram payload:

```ts
{
  text: "Inspecting the files",
  entities: [
    { type: "pre", offset: 0, length: 20, language: "kirbot" }
  ]
}
```

### Multipart final answer

Flow:

1. Render full Markdown to a single `FormattedText`
2. Chunk rendered text at Telegram-safe boundaries
3. Clip and shift entities per chunk
4. Prefix each chunk with `Part x/n\n\n`
5. Shift entity offsets by the prefix length

## Reviewer Notes

- The migration is intentionally builder-first: Markdown parsing is one producer,
  not the core abstraction.
- Commentary still bypasses Markdown parsing on purpose.
- The current Markdown support focuses on high-ROI syntax used by Codex output:
  headings, emphasis, strong, strikethrough, inline code, fenced/indented code,
  links, blockquotes, and lists.
