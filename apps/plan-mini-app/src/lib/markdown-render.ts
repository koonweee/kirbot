import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false
});

const DETAILS_DIRECTIVE_PREFIX = ":::details ";

type RenderMarkdownOptions = {
  allowDetailsDirective?: boolean;
};

type MarkdownSegment =
  | {
      type: "markdown";
      text: string;
    }
  | {
      type: "details";
      summary: string;
      body: string;
    };

export function renderMarkdownToHtml(markdownText: string, options: RenderMarkdownOptions = {}): string {
  const source = normalizeMarkdown(markdownText || "(empty plan)");
  if (!options.allowDetailsDirective) {
    return markdown.render(source);
  }

  return parseMarkdownSegments(source)
    .map((segment) => {
      if (segment.type === "markdown") {
        return markdown.render(segment.text);
      }

      return renderDetailsSegment(segment.summary, segment.body);
    })
    .join("");
}

function parseMarkdownSegments(source: string): MarkdownSegment[] {
  const lines = source.split("\n");
  const segments: MarkdownSegment[] = [];
  let cursor = 0;
  let markdownStart = 0;

  while (cursor < lines.length) {
    const summary = parseDetailsSummary(lines[cursor] ?? "");
    if (!summary) {
      cursor += 1;
      continue;
    }

    const closeIndex = findDetailsCloseLine(lines, cursor + 1);
    if (closeIndex === -1) {
      cursor += 1;
      continue;
    }

    pushMarkdownSegment(segments, lines.slice(markdownStart, cursor).join("\n"));
    segments.push({
      type: "details",
      summary,
      body: lines.slice(cursor + 1, closeIndex).join("\n")
    });
    cursor = closeIndex + 1;
    markdownStart = cursor;
  }

  pushMarkdownSegment(segments, lines.slice(markdownStart).join("\n"));
  return segments.length > 0 ? segments : [{ type: "markdown", text: source }];
}

function pushMarkdownSegment(segments: MarkdownSegment[], text: string): void {
  if (text.trim().length === 0) {
    return;
  }

  segments.push({ type: "markdown", text });
}

function parseDetailsSummary(line: string): string | null {
  if (!line.startsWith(DETAILS_DIRECTIVE_PREFIX)) {
    return null;
  }

  const summary = line.slice(DETAILS_DIRECTIVE_PREFIX.length).trim();
  return summary.length > 0 ? summary : null;
}

function findDetailsCloseLine(lines: string[], startIndex: number): number {
  for (let index = startIndex; index < lines.length; index += 1) {
    if ((lines[index] ?? "").trim() === ":::") {
      return index;
    }
  }

  return -1;
}

function renderDetailsSegment(summary: string, body: string): string {
  const renderedBody = body.trim().length > 0 ? markdown.render(body) : "";
  return [
    '<details class="artifact-details">',
    `<summary>${escapeHtml(summary)}</summary>`,
    `<div class="artifact-details-body">${renderedBody}</div>`,
    "</details>"
  ].join("");
}

function normalizeMarkdown(markdownText: string): string {
  return markdownText.replace(/\r\n?/g, "\n");
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
