import type { MessageEntity } from "grammy/types";
import { describe, expect, it } from "vitest";

import {
  buildCommentaryArtifactButton,
  buildCommentaryArtifactPublication,
  buildRenderedMcpListing,
  buildRenderedSkillsListing,
  buildPlanArtifactMessage,
  buildPlanArtifactMessages,
  buildRenderedAssistantMessage,
  buildRenderedCommandApprovalPrompt,
  buildRenderedFileChangeApprovalPrompt,
  buildRenderedCompletionFooter,
  buildRenderedCompletionNotification,
  buildRenderedThreadStartFooter,
  buildTopicCommandKeyboard,
  buildResponseArtifactPublication,
  buildStatusDraft,
  renderQueuePreview,
  renderTelegramStatusDraft,
  TOPIC_IMPLEMENT_CALLBACK_DATA
} from "../src/bridge/presentation";
import { prefixTelegramUsernameMention } from "../src/bridge/telegram-mention-prefix";
import { decodeMiniAppArtifact, getEncodedMiniAppArtifactFromHash, MiniAppArtifactType } from "../src/mini-app/url";
import type { TelegramInlineKeyboardButton } from "../src/telegram-messenger";
import type { ActivityLogEntry } from "../src/turn-runtime";

function getButtonUrl(entry: {
  replyMarkup: {
    inline_keyboard: Array<Array<TelegramInlineKeyboardButton>>;
  };
}): string {
  const url = entry.replyMarkup.inline_keyboard
    .flatMap((row) => row)
    .find((button): button is Extract<TelegramInlineKeyboardButton, { url: string }> => "url" in button)?.url;
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

  it("renders a live subagent snapshot block in the same status bubble", () => {
    expect(
      renderTelegramStatusDraft(
        buildStatusDraft("waiting", {
          subagentSnapshot: {
            summary: "waiting for 2 agents",
            agents: [
              { label: "explorer", state: "running", detail: null },
              { label: "worker", state: "completed", detail: null }
            ]
          }
        }),
        14_000
      )
    ).toEqual({
      text: "waiting · 14s\n\nwaiting for 2 agents\n- explorer: running\n- worker: completed"
    });
  });

  it("limits the live subagent snapshot to three rows plus overflow", () => {
    expect(
      renderTelegramStatusDraft(
        buildStatusDraft("waiting", {
          subagentSnapshot: {
            summary: "waiting for 5 agents",
            agents: [
              { label: "agent 1", state: "running", detail: null },
              { label: "agent 2", state: "running", detail: null },
              { label: "agent 3", state: "completed", detail: null },
              { label: "agent 4", state: "pending", detail: null },
              { label: "agent 5", state: "failed", detail: "timeout" }
            ]
          }
        }),
        9_000
      )
    ).toEqual({
      text:
        "waiting · 9s\n\nwaiting for 5 agents\n- agent 1: running\n- agent 2: running\n- agent 3: completed\n- ...and 2 more"
    });
  });

  it("renders brief failure detail in the live subagent snapshot", () => {
    expect(
      renderTelegramStatusDraft(
        buildStatusDraft("using tool", {
          subagentSnapshot: {
            summary: "checking agent status",
            agents: [{ label: "explorer", state: "failed", detail: "timeout" }]
          }
        }),
        3_000
      )
    ).toEqual({
      text: "using tool · 3s\n\nchecking agent status\n- explorer: failed - timeout"
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
      text: "1m 0s • 100% left • /workspace • main • gpt-5",
      entities: [
        {
          type: "pre",
          offset: 0,
          length: "1m 0s • 100% left • /workspace • main • gpt-5".length,
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
      text: "2s • 88% left • 1 file • /workspace • main • gpt-5 high • planning",
      entities: [
        {
          type: "pre",
          offset: 0,
          length: "2s • 88% left • 1 file • /workspace • main • gpt-5 high • planning".length,
          language: "status"
        }
      ]
    });
  });

  it("omits missing branches and orders footer metadata as time, context, files, path, branch, model", () => {
    expect(
      buildRenderedCompletionFooter({
        mode: "default",
        model: "gpt-5",
        reasoningEffort: "high",
        serviceTier: null,
        durationMs: 60_000,
        changedFiles: 2,
        contextLeftPercent: 75,
        cwd: "/workspace",
        branch: null
      })
    ).toEqual({
      text: "1m 0s • 75% left • 2 files • /workspace • gpt-5 high",
      entities: [
        {
          type: "pre",
          offset: 0,
          length: "1m 0s • 75% left • 2 files • /workspace • gpt-5 high".length,
          language: "status"
        }
      ]
    });
  });

  it("shows both reasoning effort and fast mode in completion footers", () => {
    expect(
      buildRenderedCompletionFooter({
        mode: "default",
        model: "gpt-5",
        reasoningEffort: "high",
        serviceTier: "fast",
        durationMs: 60_000,
        changedFiles: 0,
        contextLeftPercent: 75,
        cwd: "/workspace",
        branch: "main"
      })
    ).toEqual({
      text: "1m 0s • 75% left • /workspace • main • gpt-5 high fast",
      entities: [
        {
          type: "pre",
          offset: 0,
          length: "1m 0s • 75% left • /workspace • main • gpt-5 high fast".length,
          language: "status"
        }
      ]
    });
  });

  it("renders the completion notification as inline code", () => {
    expect(buildRenderedCompletionNotification()).toEqual({
      text: "> done",
      entities: [
        {
          type: "code",
          offset: 0,
          length: 6
        }
      ]
    });
  });

  it("renders queued follow-ups with actor labels and user-id fallback", () => {
    expect(
      renderQueuePreview({
        chatId: -1001,
        topicId: 777,
        pendingSteers: ["Re-run the last check"],
        queuedFollowUps: [
          { actorLabel: "Jeremy", text: "Inspect the deploy logs" },
          { actorLabel: "User 42", text: "Post the failing test output" }
        ]
      })
    ).toBe(
      [
        "Queued for current turn:",
        "- Re-run the last check",
        "",
        "Queued for next turn:",
        "- Jeremy: Inspect the deploy logs",
        "- User 42: Post the failing test output"
      ].join("\n")
    );
  });

  it("renders a thread-start footer as a plain status line", () => {
    expect(
      buildRenderedThreadStartFooter({
        mode: "default",
        model: "gpt-5",
        reasoningEffort: null,
        serviceTier: null,
        cwd: "/workspace",
        branch: "main"
      })
    ).toEqual({
      text: "<1s • 100% left • /workspace • main • gpt-5",
      entities: [
        {
          type: "pre",
          offset: 0,
          length: "<1s • 100% left • /workspace • main • gpt-5".length,
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
    expect(viewButton && "url" in viewButton ? viewButton.text : null).toBe("Plan");
    expect(implementButton && "callback_data" in implementButton ? implementButton : null).toEqual({
      text: "Implement",
      callback_data: TOPIC_IMPLEMENT_CALLBACK_DATA
    });

    const url = viewButton && "url" in viewButton ? viewButton.url : null;
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
  it("builds a reply keyboard with all visible built-in commands followed by custom commands", () => {
    expect(
      buildTopicCommandKeyboard(
        [
          { command: "stop" },
          { command: "plan" },
          { command: "thread" },
          { command: "restart" },
          { command: "implement" },
          { command: "cmd" },
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
        ["/thread", "/restart"],
        ["/implement", "/cmd"],
        ["/model", "/fast"],
        ["/compact", "/clear"],
        ["/permissions", "/commands"],
        ["/standup", "/triage"]
      ],
      is_persistent: true,
      resize_keyboard: true,
      one_time_keyboard: false,
      input_field_placeholder: "Commands"
    });
  });

  it("keeps custom commands appended after an odd number of visible built-ins", () => {
    expect(
      buildTopicCommandKeyboard(
        [
          { command: "stop" },
          { command: "plan" },
          { command: "thread" },
          { command: "restart" },
          { command: "implement" },
          { command: "cmd" },
          { command: "model" },
          { command: "fast" },
          { command: "compact" },
          { command: "clear" },
          { command: "permissions" },
          { command: "commands" }
        ],
        [{ command: "standup" }]
      )
    ).toEqual({
      keyboard: [
        ["/stop", "/plan"],
        ["/thread", "/restart"],
        ["/implement", "/cmd"],
        ["/model", "/fast"],
        ["/compact", "/clear"],
        ["/permissions", "/commands"],
        ["/standup"]
      ],
      is_persistent: true,
      resize_keyboard: true,
      one_time_keyboard: false,
      input_field_placeholder: "Commands"
    });
  });
});

describe("skills and mcp listing presentation", () => {
  it("renders a compact skills listing", () => {
    expect(
      buildRenderedSkillsListing({
        cwd: "/home/dev/coding",
        skills: [
          {
            name: "brainstorming",
            description: "Explore intent before implementation",
            shortDescription: "Explore intent before implementation",
            path: "/home/dev/kirbot/skills/brainstorming/SKILL.md",
            scope: "user",
            enabled: true
          }
        ],
        errors: []
      })
    ).toEqual({
      text: [
        "/skills",
        "",
        "CWD: /home/dev/coding",
        "",
        "• brainstorming [enabled]",
        "  Explore intent before implementation"
      ].join("\n")
    });
  });

  it("renders a compact skills warning block when scan errors are present", () => {
    expect(
      buildRenderedSkillsListing({
        cwd: "/home/dev/coding",
        skills: [],
        errors: [
          {
            path: "/home/dev/kirbot/skills/bad/SKILL.md",
            message: "invalid frontmatter"
          }
        ]
      })
    ).toEqual({
      text: [
        "/skills",
        "",
        "CWD: /home/dev/coding",
        "",
        "No skills available for /home/dev/coding",
        "",
        "Warnings:",
        "- /home/dev/kirbot/skills/bad/SKILL.md: invalid frontmatter"
      ].join("\n")
    });
  });

  it("sorts skills alphabetically and caps warning output", () => {
    expect(
      buildRenderedSkillsListing({
        cwd: "/home/dev/coding",
        skills: [
          {
            name: "zeta",
            description: "last",
            path: "/tmp/zeta/SKILL.md",
            scope: "user",
            enabled: false
          },
          {
            name: "alpha",
            description: "first",
            path: "/tmp/alpha/SKILL.md",
            scope: "user",
            enabled: true
          }
        ],
        errors: [
          { path: "/tmp/1", message: "one" },
          { path: "/tmp/2", message: "two" },
          { path: "/tmp/3", message: "three" },
          { path: "/tmp/4", message: "four" }
        ]
      })
    ).toEqual({
      text: [
        "/skills",
        "",
        "CWD: /home/dev/coding",
        "",
        "• alpha [enabled]",
        "  first",
        "• zeta [disabled]",
        "  last",
        "",
        "Warnings:",
        "- /tmp/1: one",
        "- /tmp/2: two",
        "- /tmp/3: three",
        "...and 1 more"
      ].join("\n")
    });
  });

  it("renders a compact mcp listing with auth and transport summary", () => {
    expect(
      buildRenderedMcpListing({
        statuses: [
          {
            name: "openaiDeveloperDocs",
            authStatus: "oAuth",
            tools: {
              search: {
                name: "search",
                inputSchema: { type: "object" }
              }
            },
            resources: [],
            resourceTemplates: []
          }
        ],
        transportSummaries: {
          openaiDeveloperDocs: "URL: https://developers.openai.com/mcp"
        }
      })
    ).toEqual({
      text: [
        "/mcp",
        "",
        "• openaiDeveloperDocs",
        "  Auth: oauth",
        "  URL: https://developers.openai.com/mcp",
        "  Tools: search",
        "  Resources: (none)",
        "  Resource templates: (none)"
      ].join("\n")
    });
  });

  it("sorts mcp servers alphabetically and caps verbose inventory sections", () => {
    expect(
      buildRenderedMcpListing({
        statuses: [
          {
            name: "zeta",
            authStatus: "unsupported",
            tools: {
              delta: { name: "delta", inputSchema: { type: "object" } },
              beta: { name: "beta", inputSchema: { type: "object" } },
              gamma: { name: "gamma", inputSchema: { type: "object" } },
              alpha: { name: "alpha", inputSchema: { type: "object" } }
            },
            resources: [
              { name: "res-d", uri: "file://d" },
              { name: "res-b", uri: "file://b" },
              { name: "res-c", uri: "file://c" },
              { name: "res-a", uri: "file://a" }
            ],
            resourceTemplates: [
              { name: "tpl-d", uriTemplate: "file://d/{id}" },
              { name: "tpl-b", uriTemplate: "file://b/{id}" },
              { name: "tpl-c", uriTemplate: "file://c/{id}" },
              { name: "tpl-a", uriTemplate: "file://a/{id}" }
            ]
          },
          {
            name: "alpha",
            authStatus: "notLoggedIn",
            tools: {},
            resources: [],
            resourceTemplates: []
          }
        ]
      })
    ).toEqual({
      text: [
        "/mcp",
        "",
        "• alpha",
        "  Auth: notLoggedIn",
        "  Tools: (none)",
        "  Resources: (none)",
        "  Resource templates: (none)",
        "",
        "• zeta",
        "  Auth: unsupported",
        "  Tools: alpha, beta, delta, ...and 1 more",
        "  Resources: res-a, res-b, res-c, ...and 1 more",
        "  Resource templates: tpl-a, tpl-b, tpl-c, ...and 1 more"
      ].join("\n")
    });
  });

  it("caps oversized listing messages to Telegram-safe text lengths", () => {
    const rendered = buildRenderedSkillsListing({
      cwd: "/home/dev/coding",
      skills: Array.from({ length: 300 }, (_, index) => ({
        name: `skill-${index.toString().padStart(3, "0")}`,
        description: `Description ${"token ".repeat(10)}`.trim(),
        path: `/tmp/skill-${index}/SKILL.md`,
        scope: "user",
        enabled: index % 2 === 0
      })),
      errors: []
    });

    expect(rendered.text.length).toBeLessThanOrEqual(4000);
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
    const url = "url" in button ? button.url : null;
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
    const url = "url" in button ? button.url : null;
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
    const url = "url" in button ? button.url : null;
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
    const url = "url" in button ? button.url : null;
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
        const encoded = getEncodedMiniAppArtifactFromHash(new URL(getButtonUrl(message)).hash);
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
        const encoded = getEncodedMiniAppArtifactFromHash(new URL(getButtonUrl(message)).hash);
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
        const encoded = getEncodedMiniAppArtifactFromHash(new URL(getButtonUrl(message)).hash);
        return decodeMiniAppArtifact(encoded!).markdownText;
      })
      .join("\n");

    expect(reassembled).toBe(markdownText);
  });
});

describe("command presentation", () => {
  it("returns the original payload unchanged when the telegram username is missing or blank", () => {
    const message = {
      text: "Hello there",
      entities: [{ type: "bold", offset: 0, length: 5 }] satisfies MessageEntity[]
    };

    expect(prefixTelegramUsernameMention(message, undefined)).toBe(message);
    expect(prefixTelegramUsernameMention(message, null)).toBe(message);
    expect(prefixTelegramUsernameMention(message, "   ")).toBe(message);
  });

  it("prefixes plain text payloads with a normalized mention", () => {
    expect(prefixTelegramUsernameMention({ text: "Please review this" }, "  jeremy  ")).toEqual({
      text: "@jeremy Please review this"
    });
  });

  it("shifts entity offsets for rendered assistant and approval messages", () => {
    const assistantMessage = buildRenderedAssistantMessage("Use `npm test` and **keep going**");
    expect(assistantMessage.entities?.length).toBeGreaterThan(0);

    const prefixedAssistantMessage = prefixTelegramUsernameMention(assistantMessage, "jeremy");
    expect(prefixedAssistantMessage.text).toBe(`@jeremy ${assistantMessage.text}`);
    expect(prefixedAssistantMessage.entities).toEqual(
      assistantMessage.entities?.map((entity) => ({
        ...entity,
        offset: entity.offset + "@jeremy ".length
      }))
    );

    const approvalMessage = buildRenderedCommandApprovalPrompt({
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

    const prefixedApprovalMessage = prefixTelegramUsernameMention(approvalMessage, " jeremy ");
    expect(prefixedApprovalMessage.text).toBe(`@jeremy ${approvalMessage.text}`);
    expect(prefixedApprovalMessage.entities).toEqual(
      approvalMessage.entities?.map((entity) => ({
        ...entity,
        offset: entity.offset + "@jeremy ".length
      }))
    );
  });

  it("keeps the prefix-boundary entity aligned when the entity begins at the old text start", () => {
    const message = {
      text: "Command approval needed",
      entities: [{ type: "bold", offset: 0, length: 7 }] satisfies MessageEntity[]
    };

    expect(prefixTelegramUsernameMention(message, "jeremy")).toEqual({
      text: "@jeremy Command approval needed",
      entities: [{ type: "bold", offset: "@jeremy ".length, length: 7 }]
    });
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
