# Telegram Entities Migration Planning Prompt

You are working in the Kirbot repository. Analyze the current codebase and produce a concrete implementation plan for migrating Telegram message formatting away from HTML/`parse_mode` and toward plain text plus Telegram `MessageEntity[]`.

Do not implement code yet. Inspect the current codebase first, then write a concrete plan grounded in the actual files, abstractions, and test coverage that exist today.

## Context

Kirbot currently receives Codex assistant text and renders it for Telegram. There is existing formatting logic that converts a small Markdown subset into Telegram HTML and sends messages with `parse_mode: "HTML"`.

We want to replace that approach with:

1. `micromark` for Markdown parsing
2. a Kirbot-owned abstraction that converts parsed Markdown into Telegram entities
3. no HTML construction
4. no Kirbot-level support for changing parse mode or passing HTML
5. all Telegram messages represented as either:
   - plain text, or
   - plain text plus `MessageEntity[]`

Strong preference: use entities wherever formatting is present.

## Key Decisions Already Made

1. Use `micromark`
- Read the official API carefully before planning.
- Pay special attention to any streaming or incremental parsing notes that matter because Codex messages arrive as streaming deltas.
- Assume drafts should likely be rendered by reparsing the full buffered text on each throttled flush unless the codebase suggests a better option.

2. Maintain our own Markdown-to-Telegram-entity abstraction
- Do not depend on a library that directly renders Telegram entities for arbitrary Markdown as the core design.
- Build this as a dedicated, extensible abstraction in Kirbot.
- It should be easy to add more Markdown features later.

3. Remove all HTML construction code
- Delete the current HTML rendering path once replaced.

4. Remove Kirbot support for parse mode / HTML message injection
- Update all call sites and abstractions so Kirbot no longer exposes parse mode as a formatting control surface.
- Messages should be plain text or text + entities only.

## Specific Deliverables For Your Plan

Produce a concrete plan that includes:

1. A current-state analysis
- Identify the files and functions currently responsible for:
  - formatting Codex text for Telegram
  - carrying rendered messages through the bridge
  - sending drafts and final messages through Telegram
  - tests that currently assert HTML or `parse_mode`

2. A proposed architecture
- Recommend the module layout for:
  - the Markdown parsing integration
  - the Telegram entity renderer
  - any shared builders/helpers needed for UTF-16 offset tracking and chunking
- Explain how the renderer should be exposed so it is easy to extend.

3. A syntax mapping table
- Create a table mapping:
  - Markdown syntax
  - micromark representation or parsing hook
  - Telegram entity representation
  - support status / notes
- Cover everything Telegram supports where there is a sensible Markdown source.
- Explicitly call out Telegram entity types that do not have a natural Markdown source and how Kirbot should treat them.

4. A streaming strategy
- Explain exactly how draft rendering should work when assistant text streams in incrementally.
- Address incomplete trailing Markdown.
- Address performance tradeoffs versus correctness.

5. A migration plan
- Break the work into implementation phases with file-level detail.
- Include test updates and new tests required.
- Include chunking/entity-offset concerns.
- Include how to remove HTML and `parse_mode` support safely.

6. Risks and edge cases
- Include UTF-16 entity offsets.
- Include chunk splitting with entities.
- Include nested formatting.
- Include fenced code blocks with language.
- Include how Telegram-supported entities that are not parser-generated should be handled.

## Important Constraints

- Base your plan on the code as it exists in this repository now.
- Do not assume the abstractions are cleaner than they are; inspect them.
- Prefer the simplest robust architecture that will survive future extension.
- If `micromark` alone is not the right level of abstraction, say so explicitly and justify whether Kirbot should use `micromark` directly or use it via a related syntax-tree package.
- Keep the final plan concrete, not aspirational.

## Things To Verify During Analysis

- Whether Telegram drafts in the current stack support `entities`
- Where Kirbot currently stores parse mode / rendered message state
- Where HTML assumptions leak into tests
- Whether commentary rendering should use the same Markdown-to-entities path or a separate path
- Whether chunking currently happens before or after formatting, and what that means for entity migration

## Output Format

Return:

1. A short current-state summary
2. A concrete phased implementation plan
3. A syntax mapping table
4. A risk list / open questions

When referencing code, cite exact files and relevant functions.
