import { describe, expect, it } from "vitest";

import {
  buildCommentaryArtifactButton,
  buildPlanArtifactMessage,
  buildRenderedCompletionFooter,
  buildStatusDraft,
  renderTelegramStatusDraft,
  TOPIC_IMPLEMENT_CALLBACK_DATA
} from "../src/bridge/presentation";
import { decodeMiniAppArtifact, getEncodedMiniAppArtifactFromHash, MiniAppArtifactType } from "../src/mini-app/url";
import type { ActivityLogEntry } from "../src/turn-runtime";

describe("status presentation", () => {
  it("renders status drafts as state plus elapsed time only", () => {
    expect(renderTelegramStatusDraft(buildStatusDraft("running"), 2000)).toEqual({
      text: "running · 2s"
    });
    expect(renderTelegramStatusDraft(buildStatusDraft("editing"), 3000)).toEqual({
      text: "editing · 3s"
    });
    expect(renderTelegramStatusDraft(buildStatusDraft("using tool"), 1000)).toEqual({
      text: "using tool · 1s"
    });
    expect(renderTelegramStatusDraft(buildStatusDraft("planning"), 4000)).toEqual({
      text: "planning · 4s"
    });
    expect(renderTelegramStatusDraft(buildStatusDraft("searching"), 5000)).toEqual({
      text: "searching · 5s"
    });
    expect(renderTelegramStatusDraft(buildStatusDraft("waiting"), 6000)).toEqual({
      text: "waiting · 6s"
    });
    expect(renderTelegramStatusDraft(buildStatusDraft("thinking"), 3000)).toEqual({
      text: "thinking · 3s"
    });
  });

  it("renders elapsed minutes without leading zero padding", () => {
    expect(renderTelegramStatusDraft(buildStatusDraft("thinking"), 69_000)).toEqual({
      text: "thinking · 1m 9s"
    });
    expect(
      buildRenderedCompletionFooter({
        model: "gpt-5",
        reasoningEffort: null,
        durationMs: 60_000,
        changedFiles: 0,
        contextLeftPercent: 100,
        cwd: "/workspace",
        branch: "main"
      })
    ).toEqual({
      text: "gpt-5 • 1m 0s • 0 files • 100% left • /workspace • main",
      entities: [
        {
          type: "pre",
          offset: 0,
          length: "gpt-5 • 1m 0s • 0 files • 100% left • /workspace • main".length,
          language: "status"
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
