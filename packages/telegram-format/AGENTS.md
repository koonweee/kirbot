# Telegram Formatters

This directory owns Kirbot's Telegram text formatting layer.

For repo-level architecture and onboarding context, start with
[README.md](/home/jtkw/kirbot/README.md),
[docs/architecture.md](/home/jtkw/kirbot/docs/architecture.md), and
[docs/user-flows.md](/home/jtkw/kirbot/docs/user-flows.md). This file only
covers the local rules for the formatting subsystem.

## Purpose

Use this module to produce Telegram-ready payloads as:

- plain text, or
- plain text plus `MessageEntity[]`

Do not add new Telegram formatting logic in bridge, lifecycle, messenger, or
test helper code if it belongs here.

## Ownership Boundary

All relevant Telegram formatting logic should live in this directory, including:

- Markdown-to-entity rendering
- manual formatting producers for plain text
- shared entity wrapper helpers
- UTF-16 offset handling
- entity-aware truncation and clipping

Code outside this directory should treat the output here as the source of truth
for Telegram formatting.

## How To Use

Choose the entrypoint based on the producer:

- Markdown input:
  - use `renderMarkdownToFormattedText`
- Manual literal/preformatted content:
  - use `renderPreformattedText`
  - use `renderQuotedText`
- Manual text with explicit formatting:
  - use shared wrappers in `formatters.ts`
  - examples: `boldFormattedText`, `linkFormattedText`,
    `preformattedFormattedText`, `quoteFormattedText`
- Truncated Telegram output:
  - use `truncateFormattedText`

## Design Rules

- Keep Markdown parsing separate from manual producers.
- Share lower-level Telegram entity behavior through common helpers.
- Prefer extending shared helpers over adding one-off entity logic in callers.
- Preserve UTF-16 correctness for all entity offsets and truncation boundaries.
- If a Telegram entity has no natural Markdown source, add it as a manual path
  here rather than leaking ad hoc construction into callers.

## Current Defaults

- Shared quote rendering defaults to `expandable_blockquote`.
- Markdown blockquotes use the shared quote formatter and therefore also render
  as `expandable_blockquote` unless changed centrally here.

## When Adding New Formatting

1. Add or extend the shared formatter helper here.
2. Expose a producer only if callers need a stable entrypoint.
3. Add focused unit tests in `packages/telegram-format/tests/telegram-format.test.ts`.
4. Update `packages/telegram-format/README.md` if the supported formatting surface
   or behavior contract changed.
5. Only then wire the new formatter into bridge/presentation code.
