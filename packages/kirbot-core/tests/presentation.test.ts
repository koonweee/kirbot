import { describe, expect, it } from "vitest";

import {
  buildCommentaryArtifactButton,
  buildPlanArtifactMessage,
  buildStatusDraft,
  renderTelegramStatusDraft,
  TOPIC_IMPLEMENT_CALLBACK_DATA
} from "../src/bridge/presentation";
import { decodeMiniAppArtifact, getEncodedMiniAppArtifactFromHash, MiniAppArtifactType } from "../src/mini-app/url";
import type { ActivityLogEntry } from "../src/turn-runtime";

describe("status presentation", () => {
  it("renders command status details as a quoted second line", () => {
    expect(renderTelegramStatusDraft(buildStatusDraft("running", null, "npm test"), 2000)).toEqual({
      text: "running · 2s\n\nnpm test",
      entities: [
        {
          type: "blockquote",
          offset: "running · 2s\n\n".length,
          length: "npm test".length
        }
      ]
    });
  });

  it("renders editing status details as a quoted second line", () => {
    const path = "packages/kirbot-core/src/bridge/presentation.ts";

    expect(renderTelegramStatusDraft(buildStatusDraft("editing", null, path), 3000)).toEqual({
      text: `editing · 3s\n\n${path}`,
      entities: [
        {
          type: "blockquote",
          offset: "editing · 3s\n\n".length,
          length: path.length
        }
      ]
    });
  });

  it("renders tool status details as a quoted second line", () => {
    expect(renderTelegramStatusDraft(buildStatusDraft("using tool", null, "web.search"), 1000)).toEqual({
      text: "using tool · 1s\n\nweb.search",
      entities: [
        {
          type: "blockquote",
          offset: "using tool · 1s\n\n".length,
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

describe("plan artifact presentation", () => {
  it("renders view and implement buttons on completed plan stubs", () => {
    const message = buildPlanArtifactMessage("https://example.com/mini-app", "1. Draft the rollout");
    const [viewButton, implementButton] = message.replyMarkup.inline_keyboard[0] ?? [];

    expect(message.text).toBe("Plan is ready");
    expect(viewButton && "web_app" in viewButton ? viewButton.text : null).toBe("Plan");
    expect(implementButton && "callback_data" in implementButton ? implementButton : null).toEqual({
      text: "Implement",
      callback_data: TOPIC_IMPLEMENT_CALLBACK_DATA
    });

    const url = viewButton && "web_app" in viewButton ? viewButton.web_app.url : null;
    expect(url).toBeTruthy();
    const encoded = getEncodedMiniAppArtifactFromHash(new URL(url!).hash);
    expect(encoded).toBeTruthy();
    expect(decodeMiniAppArtifact(encoded!)).toEqual({
      v: 1,
      type: MiniAppArtifactType.Plan,
      title: "Plan",
      markdownText: "1. Draft the rollout"
    });
  });
});

describe("commentary artifact presentation", () => {
  it("renders commentary as mixed prose and activity bullets", () => {
    const entries: ActivityLogEntry[] = [
      { kind: "commentary", text: "Inspecting the renderer." },
      { kind: "activity", label: "Command Started", detail: "npm test", detailStyle: "inlineCode" },
      { kind: "activity", label: "Web Search Completed", detail: "markdown-it details support", detailStyle: "text" }
    ];

    const button = buildCommentaryArtifactButton("https://example.com/mini-app", entries);
    const url = "web_app" in button ? button.web_app.url : null;
    expect(url).toBeTruthy();

    const encoded = getEncodedMiniAppArtifactFromHash(new URL(url!).hash);
    expect(decodeMiniAppArtifact(encoded!)).toEqual({
      v: 1,
      type: MiniAppArtifactType.Commentary,
      title: "Commentary",
      markdownText:
        "## Activity Log\n\n**Commentary**\n\nInspecting the renderer.\n\n- **Command Started:** `npm test`\n\n- **Web Search Completed:** markdown\\-it details support"
    });
  });
});
