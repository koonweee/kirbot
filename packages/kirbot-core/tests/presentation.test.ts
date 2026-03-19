import { describe, expect, it } from "vitest";

import {
  buildCommentaryArtifactButton,
  buildPlanArtifactMessage,
  buildRenderedCommandApprovalPrompt,
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
        "## Activity Log\n\n**Commentary**\n\nInspecting the renderer.\n\n- **Command**\n```\nnpm test\n```\n\n- **Web Search:** markdown\\-it details support"
    });
  });

  it("renders failed commands with structured metadata and error blocks", () => {
    const entries: ActivityLogEntry[] = [
      {
        kind: "commandFailure",
        title: "Command failed",
        command: "npm test -- --runInBand",
        cwd: "/workspace/packages/kirbot-core",
        exitCode: 1,
        durationMs: 12_000,
        errorOutput: 'FAIL bridge.test.ts\nError: expected "waiting · 6s" to equal "waiting · 5s"'
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
        '## Activity Log\n\n**Command failed**\n\n```\nnpm test -- --runInBand\n```\n\nCWD: `/workspace/packages/kirbot-core`  \nExit code: `1`  \nDuration: `12s`\n\nError\n\n```\nFAIL bridge.test.ts\nError: expected "waiting · 6s" to equal "waiting · 5s"\n```'
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
        'Command failed\n\nnpm test -- --runInBand\n\nCWD: /workspace/packages/kirbot-core\nExit code: 1\nDuration: 12s\n\nError\n\nFAIL bridge.test.ts\nError: expected "waiting · 6s" to equal "waiting · 5s"'
    });
    expect(rendered?.entities?.map((entity) => entity.type)).toEqual(["pre", "code", "code", "code", "pre"]);
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
});
