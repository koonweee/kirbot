import { describe, expect, it } from "vitest";

import { renderMarkdownToHtml } from "./markdown-render";

describe("renderMarkdownToHtml", () => {
  it("renders markdown lists", () => {
    expect(renderMarkdownToHtml("1. Draft the rollout\n2. Ship it")).toContain("<ol>");
  });

  it("escapes raw html", () => {
    expect(renderMarkdownToHtml("<script>alert('x')</script>")).toContain("&lt;script&gt;");
  });
});
