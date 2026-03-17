# Telegram Format

Kirbot's Telegram formatting layer converts Markdown or manual formatting inputs into plain text plus `MessageEntity[]`.
It centralizes Markdown rendering, manual entity producers, UTF-16 offset handling, and entity-aware chunking for Telegram output.

| Markdown syntax | mdast representation | Telegram entity / output |
| --- | --- | --- |
| `# Heading` | `heading` | `bold` |
| `> quote` | `blockquote` | `expandable_blockquote` |
| `**bold**`, `__bold__` | `strong` | `bold` |
| `*italic*`, `_italic_` | `emphasis` | `italic` |
| `~~strike~~` | `delete` | `strikethrough` |
| `` `code` `` | `inlineCode` | `code` |
| Fenced / indented code block | `code` | `pre` |
| `[label](url)` | `link` | `text_link` |
| Hard line break | `break` | newline in plain text |
| Plain text | `text` | plain text |
| List item | `list` / `listItem` | plain text with list prefix |
| Thematic break | `thematicBreak` | plain text `---` |
| Raw HTML | `html` | literal text |
| `\|\|spoiler\|\|` | no supported mdast mapping in this module | literal text |
