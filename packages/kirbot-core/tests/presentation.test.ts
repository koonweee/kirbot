import { describe, expect, it } from "vitest";

import {
  buildCommentaryArtifactButton,
  buildPlanArtifactMessage,
  buildRenderedCommandApprovalPrompt,
  buildRenderedFileChangeApprovalPrompt,
  buildRenderedCompletedItemMessage,
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
      { kind: "activity", label: "Command", detail: "npm test", detailStyle: "codeBlock" },
      { kind: "activity", label: "Web Search", detail: "markdown-it details support", detailStyle: "text" }
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
        "Inspecting the renderer.\n\n:::details Logs (2)\n- **Command**\n```\nnpm test\n```\n\n- **Web Search:** markdown\\-it details support\n:::"
    });
  });

  it("preserves chronology by interleaving prose with collapsible log sections", () => {
    const entries: ActivityLogEntry[] = [
      { kind: "commentary", text: "Inspecting the renderer." },
      { kind: "activity", label: "Web Search", detail: "markdown-it details support", detailStyle: "text" },
      { kind: "commentary", text: "Applying the patch." },
      { kind: "activity", label: "Command", detail: "npm test", detailStyle: "codeBlock" }
    ];

    const button = buildCommentaryArtifactButton("https://example.com/mini-app", entries);
    const url = "web_app" in button ? button.web_app.url : null;
    const encoded = getEncodedMiniAppArtifactFromHash(new URL(url!).hash);

    expect(decodeMiniAppArtifact(encoded!)).toEqual({
      v: 1,
      type: MiniAppArtifactType.Commentary,
      title: "Commentary",
      markdownText:
        "Inspecting the renderer.\n\n:::details Logs (1)\n- **Web Search:** markdown\\-it details support\n:::\n\nApplying the patch.\n\n:::details Logs (1)\n- **Command**\n```\nnpm test\n```\n:::"
    });
  });

  it("renders failed commands with structured metadata and error blocks", () => {
    const entries: ActivityLogEntry[] = [
      {
        kind: "structuredFailure",
        title: "Command failed",
        subject: {
          value: "npm test -- --runInBand",
          style: "codeBlock"
        },
        metadata: [
          { label: "CWD", value: "/workspace/packages/kirbot-core", code: true },
          { label: "Exit code", value: "1", code: true },
          { label: "Duration", value: "12s", code: true }
        ],
        detail: {
          title: "Error",
          value: 'FAIL bridge.test.ts\nError: expected "waiting · 6s" to equal "waiting · 5s"',
          style: "quoteBlock"
        }
      }
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
        ':::details Logs (1)\n**Command failed**\n```\nnpm test -- --runInBand\n```\n\nCWD: `/workspace/packages/kirbot-core`  \nExit code: `1`  \nDuration: `12s`\n\nError\n> FAIL bridge.test.ts\n> Error: expected "waiting · 6s" to equal "waiting · 5s"\n:::'
    });
  });

  it("renders failed file changes with a file list preview", () => {
    const entries: ActivityLogEntry[] = [
      {
        kind: "structuredFailure",
        title: "File changes failed",
        subject: {
          value: "src/app.ts\nsrc/server.ts",
          style: "codeBlock"
        },
        metadata: [{ label: "Files", value: "2", code: true }],
        detail: null
      }
    ];

    const button = buildCommentaryArtifactButton("https://example.com/mini-app", entries);
    const url = "web_app" in button ? button.web_app.url : null;
    const encoded = getEncodedMiniAppArtifactFromHash(new URL(url!).hash);

    expect(decodeMiniAppArtifact(encoded!)).toEqual({
      v: 1,
      type: MiniAppArtifactType.Commentary,
      title: "Commentary",
      markdownText:
        ":::details Logs (1)\n**File changes failed**\n```\nsrc/app.ts\nsrc/server.ts\n```\n\nFiles: `2`\n:::"
    });
  });
});

describe("command presentation", () => {
  it("renders failed command completions with code blocks and inline metadata", () => {
    const rendered = buildRenderedCompletedItemMessage({
      type: "commandExecution",
      id: "cmd-1",
      command: "npm test -- --runInBand",
      cwd: "/workspace/packages/kirbot-core",
      processId: null,
      status: "failed",
      commandActions: [],
      aggregatedOutput: 'FAIL bridge.test.ts\nError: expected "waiting · 6s" to equal "waiting · 5s"',
      exitCode: 1,
      durationMs: 12_000
    });

    expect(rendered).toMatchObject({
      text:
        'Command failed\nnpm test -- --runInBand\n\nCWD: /workspace/packages/kirbot-core\nExit code: 1\nDuration: 12s\n\nError\nFAIL bridge.test.ts\nError: expected "waiting · 6s" to equal "waiting · 5s"'
    });
    expect(rendered?.entities?.map((entity) => entity.type)).toEqual([
      "pre",
      "code",
      "code",
      "code",
      "expandable_blockquote"
    ]);
  });

  it("renders failed file changes with a code-block file list", () => {
    const rendered = buildRenderedCompletedItemMessage({
      type: "fileChange",
      id: "patch-1",
      status: "failed",
      changes: [
        { path: "src/app.ts", kind: { type: "update", move_path: null }, diff: "" },
        { path: "src/server.ts", kind: { type: "update", move_path: null }, diff: "" }
      ]
    });

    expect(rendered).toMatchObject({
      text: "File changes failed\nsrc/app.ts\nsrc/server.ts\n\nFiles: 2"
    });
    expect(rendered?.entities?.map((entity) => entity.type)).toEqual(["pre", "code"]);
  });

  it("renders failed tool calls with metadata and error output when available", () => {
    const rendered = buildRenderedCompletedItemMessage({
      type: "mcpToolCall",
      id: "tool-1",
      server: "github",
      tool: "search_code",
      status: "failed",
      arguments: {},
      result: null,
      error: { message: "rate limited by upstream" },
      durationMs: 10_000
    });

    expect(rendered).toMatchObject({
      text: "Tool failed\ngithub.search_code\n\nDuration: 10s\n\nError\nrate limited by upstream"
    });
    expect(rendered?.entities?.map((entity) => entity.type)).toEqual(["code", "code", "expandable_blockquote"]);
  });

  it("renders command approval cards with code-block commands and inline CWD", () => {
    const rendered = buildRenderedCommandApprovalPrompt({
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      command: "npm install",
      cwd: "/workspace",
      reason: "network access required",
      commandActions: [{ type: "read", command: "npm", name: "package metadata", path: "package.json" }],
      networkApprovalContext: { host: "registry.npmjs.org", protocol: "https" },
      additionalPermissions: {
        network: { enabled: true },
        fileSystem: { read: ["/workspace/package.json"], write: ["/workspace/package-lock.json"] },
        macos: null
      },
      skillMetadata: { pathToSkillsMd: "/skills/npm/SKILL.md" },
      proposedExecpolicyAmendment: ["npm", "install"],
      proposedNetworkPolicyAmendments: null,
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"]
    });

    expect(rendered).toMatchObject({
      text:
        "Command approval needed\n\nReason: network access required\n\nnpm install\n\nCWD: /workspace\nIntent: read package metadata from package.json\nNetwork: https://registry.npmjs.org\nPermissions: network, filesystem read (1), filesystem write (1)\nSkill: /skills/npm/SKILL.md\nScope: allow only this run, or all matching runs for this session"
    });
    expect(rendered.entities?.map((entity) => entity.type)).toEqual(["pre", "code", "code", "code"]);
  });

  it("renders file approval cards with reason, requested root, and scope", () => {
    const rendered = buildRenderedFileChangeApprovalPrompt({
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      reason: "needs write access outside the current sandbox root",
      grantRoot: "/workspace/packages/kirbot-core"
    });

    expect(rendered).toMatchObject({
      text:
        "File change approval needed\n\nReason: needs write access outside the current sandbox root\nRequested root: /workspace/packages/kirbot-core\nScope: this approval is for this change; accepting also proposes this write root for the session"
    });
    expect(rendered.entities?.map((entity) => entity.type)).toEqual(["code"]);
  });
});
