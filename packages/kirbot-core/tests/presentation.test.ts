import { describe, expect, it } from "vitest";

import { buildStatusDraft, renderTelegramStatusDraft } from "../src/bridge/presentation";

describe("status presentation", () => {
  it("renders command status details as inline code", () => {
    expect(renderTelegramStatusDraft(buildStatusDraft("running", "npm test"), 2000)).toEqual({
      text: "running: npm test · 2s",
      entities: [
        {
          type: "code",
          offset: "running: ".length,
          length: "npm test".length
        }
      ]
    });
  });

  it("renders editing status details as inline code", () => {
    const path = "packages/kirbot-core/src/bridge/presentation.ts";

    expect(renderTelegramStatusDraft(buildStatusDraft("editing", path), 3000)).toEqual({
      text: `editing: ${path} · 3s`,
      entities: [
        {
          type: "code",
          offset: "editing: ".length,
          length: path.length
        }
      ]
    });
  });

  it("renders tool status details as inline code", () => {
    expect(renderTelegramStatusDraft(buildStatusDraft("using tool", "web.search"), 1000)).toEqual({
      text: "using tool: web.search · 1s",
      entities: [
        {
          type: "code",
          offset: "using tool: ".length,
          length: "web.search".length
        }
      ]
    });
  });

  it("keeps planning, searching, and waiting details as plain text", () => {
    expect(renderTelegramStatusDraft(buildStatusDraft("planning", "Review the current flow"), 4000)).toEqual({
      text: "planning: Review the current flow · 4s"
    });
    expect(renderTelegramStatusDraft(buildStatusDraft("searching", "telegram inline code"), 5000)).toEqual({
      text: "searching: telegram inline code · 5s"
    });
    expect(renderTelegramStatusDraft(buildStatusDraft("waiting", "approval"), 6000)).toEqual({
      text: "waiting: approval · 6s"
    });
  });

  it("renders thinking summaries as quoted previews below the status line", () => {
    const summary = "Check the current status pipeline before changing the renderer.";

    expect(renderTelegramStatusDraft(buildStatusDraft("thinking", null, summary), 3000)).toEqual({
      text: `thinking · 3s\n\n${summary}`,
      entities: [
        {
          type: "blockquote",
          offset: "thinking · 3s\n\n".length,
          length: summary.length
        }
      ]
    });
  });
});
