import { describe, expect, it } from "vitest";

import {
  buildCommentaryArtifactButton,
  buildCommentaryArtifactPublication,
  buildPlanArtifactMessage,
  buildPlanArtifactMessages,
  buildRenderedCommandApprovalPrompt,
  buildRenderedFileChangeApprovalPrompt,
  buildRenderedCompletionFooter,
  buildTopicCommandKeyboard,
  buildResponseArtifactPublication,
  buildStatusDraft,
  renderTelegramStatusDraft,
  TOPIC_IMPLEMENT_CALLBACK_DATA
} from "../src/bridge/presentation";
import { decodeMiniAppArtifact, getEncodedMiniAppArtifactFromHash, MiniAppArtifactType } from "../src/mini-app/url";
import type { ActivityLogEntry } from "../src/turn-runtime";

function getWebAppUrl(entry: {
  replyMarkup: {
    inline_keyboard: Array<Array<{ web_app?: { url?: string }; callback_data?: string }>>;
  };
}): string {
  const url = entry.replyMarkup.inline_keyboard.flatMap((row) => row).find((button) => button.web_app?.url)?.web_app?.url;
  expect(url).toBeTruthy();
  return url!;
}

function buildOversizedCommentaryEntries(): ActivityLogEntry[] {
  for (let count = 240; count <= 1_200; count += 120) {
    const entries: ActivityLogEntry[] = Array.from({ length: count }, (_, index) => ({
      kind: "commentary",
      text: `Section ${index + 1}\n\n${Array.from({ length: 12 }, (__unused, wordIndex) => `token-${index}-${wordIndex}`).join(" ")}`
    }));
    const publication = buildCommentaryArtifactPublication("https://example.com/mini-app", entries, {
      attachToAssistant: true
    });
    if (publication.attachedButton === null && publication.standaloneMessages.length > 1) {
      return entries;
    }
  }

  throw new Error("Failed to build oversized commentary fixture");
}

function buildOversizedResponseMarkdown(): string {
  for (let count = 220; count <= 1_400; count += 120) {
    const markdownText = Array.from({ length: count }, (_, index) =>
      `Paragraph ${index + 1}\n\n${Array.from({ length: 12 }, (__unused, wordIndex) => `token-${index}-${wordIndex}`).join(" ")}`
    ).join("\n\n");
    const publication = buildResponseArtifactPublication("https://example.com/mini-app", markdownText);
    if (publication.attachedButton === null && publication.standaloneMessages.length > 1) {
      return markdownText;
    }
  }

  throw new Error("Failed to build oversized response fixture");
}

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
        mode: "default",
        model: "gpt-5",
        reasoningEffort: null,
        serviceTier: null,
        durationMs: 60_000,
        changedFiles: 0,
        contextLeftPercent: 100,
        cwd: "/workspace",
        branch: "main"
      })
    ).toEqual({
      text: "gpt-5 • 1m 0s • 100% left • /workspace • main",
      entities: [
        {
          type: "pre",
          offset: 0,
          length: "gpt-5 • 1m 0s • 100% left • /workspace • main".length,
          language: "status"
        }
      ]
    });
  });

  it("adds a plan-mode label to completion footers for plan turns", () => {
    expect(
      buildRenderedCompletionFooter({
        mode: "plan",
        model: "gpt-5",
        reasoningEffort: "high",
        serviceTier: null,
        durationMs: 2_000,
        changedFiles: 1,
        contextLeftPercent: 88,
        cwd: "/workspace",
        branch: "main"
      })
    ).toEqual({
      text: "gpt-5 high • 2s • 1 file • 88% left • /workspace • main • planning",
      entities: [
        {
          type: "pre",
          offset: 0,
          length: "gpt-5 high • 2s • 1 file • 88% left • /workspace • main • planning".length,
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

describe("topic command keyboard presentation", () => {
  it("builds a reply keyboard with built-in topic commands followed by custom commands", () => {
    expect(
      buildTopicCommandKeyboard(
        [
          { command: "stop" },
          { command: "plan" },
          { command: "implement" },
          { command: "model" },
          { command: "fast" },
          { command: "compact" },
          { command: "clear" },
          { command: "permissions" },
          { command: "commands" }
        ],
        [
          { command: "standup" },
          { command: "triage" }
        ]
      )
    ).toEqual({
      keyboard: [
        ["/stop", "/plan"],
        ["/implement", "/model"],
        ["/fast", "/compact"],
        ["/clear", "/permissions"],
        ["/commands", "/standup"],
        ["/triage"]
      ],
      is_persistent: true,
      resize_keyboard: true,
      one_time_keyboard: false,
      input_field_placeholder: "Commands"
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

  it("splits oversized commentary into multiple standalone messages", () => {
    const entries = buildOversizedCommentaryEntries();

    const publication = buildCommentaryArtifactPublication("https://example.com/mini-app", entries, {
      attachToAssistant: true
    });

    expect(publication.attachedButton).toBeNull();
    expect(publication.standaloneMessages.length).toBeGreaterThan(1);

    const reassembled = publication.standaloneMessages
      .map((message) => {
        const encoded = getEncodedMiniAppArtifactFromHash(new URL(getWebAppUrl(message)).hash);
        return decodeMiniAppArtifact(encoded!).markdownText;
      })
      .join("\n\n");

    expect(reassembled).toContain("Section 1");
    expect(reassembled).toContain("Section 240");
  });
});

describe("multipart artifact presentation", () => {
  it("splits oversized responses into multiple standalone messages", () => {
    const markdownText = buildOversizedResponseMarkdown();

    const publication = buildResponseArtifactPublication("https://example.com/mini-app", markdownText);

    expect(publication.attachedButton).toBeNull();
    expect(publication.standaloneMessages.length).toBeGreaterThan(1);

    const reassembled = publication.standaloneMessages
      .map((message) => {
        const encoded = getEncodedMiniAppArtifactFromHash(new URL(getWebAppUrl(message)).hash);
        return decodeMiniAppArtifact(encoded!).markdownText;
      })
      .join("\n\n");

    expect(reassembled).toBe(markdownText);
  });

  it("splits oversized plans and keeps Implement on the last stub only", () => {
    const markdownText = Array.from({ length: 320 }, (_, index) =>
      `${index + 1}. ${Array.from({ length: 8 }, (__unused, wordIndex) => `step-${index}-${wordIndex}`).join(" ")}`
    ).join("\n");

    const messages = buildPlanArtifactMessages("https://example.com/mini-app", markdownText);

    expect(messages.length).toBeGreaterThan(1);
    expect(messages.at(-1)?.replyMarkup.inline_keyboard[0]?.some((button) => "callback_data" in button)).toBe(true);
    expect(messages.slice(0, -1).every((message) => message.replyMarkup.inline_keyboard[0]?.every((button) => !("callback_data" in button)))).toBe(true);

    const reassembled = messages
      .map((message) => {
        const encoded = getEncodedMiniAppArtifactFromHash(new URL(getWebAppUrl(message)).hash);
        return decodeMiniAppArtifact(encoded!).markdownText;
      })
      .join("\n");

    expect(reassembled).toBe(markdownText);
  });
});

describe("command presentation", () => {
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
