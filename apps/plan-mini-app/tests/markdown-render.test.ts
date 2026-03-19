import { describe, expect, it } from "vitest";

import { renderMarkdownToHtml } from "../src/lib/markdown-render";

describe("renderMarkdownToHtml", () => {
  it("renders markdown lists", () => {
    expect(renderMarkdownToHtml("1. Draft the rollout\n2. Ship it")).toContain("<ol>");
  });

  it("renders commentary details directives when enabled", () => {
    const html = renderMarkdownToHtml(
      "Inspecting the renderer.\n\n:::details Logs (2)\n- npm test\n- web search\n:::",
      { allowDetailsDirective: true }
    );

    expect(html).toContain("<p>Inspecting the renderer.</p>");
    expect(html).toContain('<details class="artifact-details">');
    expect(html).toContain("<summary>Logs (2)</summary>");
    expect(html).toContain("<li>npm test</li>");
    expect(html).toContain("<li>web search</li>");
  });

  it("does not render details directives unless explicitly enabled", () => {
    const html = renderMarkdownToHtml(":::details Logs (1)\n- npm test\n:::");

    expect(html).not.toContain("<details");
    expect(html).toContain(":::details Logs (1)");
  });

  it("falls back safely when a details directive is not closed", () => {
    const html = renderMarkdownToHtml(":::details Logs (1)\n- npm test", { allowDetailsDirective: true });

    expect(html).not.toContain("<details");
    expect(html).toContain(":::details Logs (1)");
  });

  it("escapes raw html", () => {
    expect(renderMarkdownToHtml("<script>alert('x')</script>")).toContain("&lt;script&gt;");
  });
});
