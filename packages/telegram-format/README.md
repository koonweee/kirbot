# Telegram Format

Kirbot's Telegram formatting layer converts parsed markdown AST or manual formatting inputs into plain text plus `MessageEntity[]`.
It centralizes mdast-to-Telegram rendering, manual entity producers, UTF-16 offset handling, and entity-aware truncation for Telegram output.

This README documents the formatting contract for this subsystem. For repo-wide
architecture, onboarding, and flow behavior, use the docs in the repository
root instead of expanding this file into a general system overview.

| Markdown syntax | mdast representation | Telegram entity / output |
| --- | --- | --- |
| `# Heading` | `heading` | `bold` |
| `> quote` | `blockquote` | `expandable_blockquote` |
| `**bold**`, `__bold__` | `strong` | `bold` |
| `*italic*`, `_italic_` | `emphasis` | `italic` |
| `~~strike~~` | `delete` | `strikethrough` |
| `` `code` `` | `inlineCode` | `code` |
| Fenced / indented code block | `code` | `pre` |
| `[label](https://example.com)` | `link` | `text_link` |
| `[label](/abs/path/to/file)` or `[label](src/path/file.md)` | `link` | `code` |
| `[label](invalid target)` | `link` | plain text label |
| Hard line break | `break` | newline in plain text |
| Plain text | `text` | plain text |
| List item | `list` / `listItem` | plain text with list prefix |
| Thematic break | `thematicBreak` | plain text `---` |
| Raw HTML | `html` | literal text |
| `\|\|spoiler\|\|` | literal spoiler delimiters in text | `spoiler` |

Markdown link handling is target-sensitive:

- valid Telegram-safe URLs stay clickable via `text_link`
- local filesystem paths and repo-relative file paths render their label as inline `code`
- other invalid or malformed targets fall back to an unannotated plain text label
