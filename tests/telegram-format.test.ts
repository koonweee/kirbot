import { describe, expect, it } from "vitest";

import { parseMarkdownToMdast } from "../src/markdown/ast";
import { chunkFormattedText, prependText } from "../src/telegram-format/chunk";
import { buildFormattedText, TelegramEntityBuilder } from "../src/telegram-format/entity-builder";
import { boldFormattedText, renderLinkedText, renderSpoilerText } from "../src/telegram-format/formatters";
import { renderMdastToFormattedText } from "../src/telegram-format/mdast";
import { renderMarkdownToFormattedText } from "../src/telegram-format/markdown";
import { renderPreformattedText, renderQuotedText } from "../src/telegram-format/preformatted";

describe("telegram-format", () => {
  it("supports manual entity annotations over plain text", () => {
    const builder = new TelegramEntityBuilder();
    builder.appendText("Hello ");
    const range = builder.appendText("world");
    builder.annotate(range, { type: "bold" });

    expect(builder.build()).toEqual({
      text: "Hello world",
      entities: [
        {
          type: "bold",
          offset: 6,
          length: 5
        }
      ]
    });
  });

  it("renders markdown to text plus entities with nested formatting", () => {
    expect(renderMarkdownToFormattedText("# Title\n\nUse **bold _mix_** and ~~strike~~ plus [docs](https://example.com).")).toEqual({
      text: "Title\n\nUse bold mix and strike plus docs.",
      entities: [
        {
          type: "bold",
          offset: 0,
          length: 5
        },
        {
          type: "bold",
          offset: 11,
          length: 8
        },
        {
          type: "italic",
          offset: 16,
          length: 3
        },
        {
          type: "strikethrough",
          offset: 24,
          length: 6
        },
        {
          type: "text_link",
          offset: 36,
          length: 4,
          url: "https://example.com"
        }
      ]
    });
  });

  it("renders parsed mdast to the same Telegram output as the markdown convenience entrypoint", () => {
    const markdown = "# Title\n\nUse **bold** with [docs](https://example.com).";
    expect(renderMdastToFormattedText(parseMarkdownToMdast(markdown))).toEqual(renderMarkdownToFormattedText(markdown));
  });

  it("drops markdown links whose targets are not valid Telegram URLs", () => {
    expect(
      renderMarkdownToFormattedText(
        "In plans there is [plan-mode-telegram-ux-prompt.md](/home/jtkw/kirbot/plans/plan-mode-telegram-ux-prompt.md)."
      )
    ).toEqual({
      text: "In plans there is plan-mode-telegram-ux-prompt.md.",
      entities: [
        {
          type: "code",
          offset: 18,
          length: 31
        }
      ]
    });
  });

  it("renders repo-relative markdown link targets as inline code", () => {
    expect(renderMarkdownToFormattedText("Open [telegram-format docs](src/telegram-format/README.md).")).toEqual({
      text: "Open telegram-format docs.",
      entities: [
        {
          type: "code",
          offset: 5,
          length: 20
        }
      ]
    });
  });

  it("drops malformed markdown link targets that are not path-like", () => {
    expect(renderMarkdownToFormattedText("Open [broken](javascript:alert(1)).")).toEqual({
      text: "Open broken."
    });
  });

  it("renders blockquotes and fenced code blocks", () => {
    expect(renderMarkdownToFormattedText("> quoted **text**\n\n```ts\nconst answer = 42;\n```")).toEqual({
      text: "quoted text\n\nconst answer = 42;",
      entities: [
        {
          type: "expandable_blockquote",
          offset: 0,
          length: 11
        },
        {
          type: "bold",
          offset: 7,
          length: 4
        },
        {
          type: "pre",
          offset: 13,
          length: 18,
          language: "ts"
        }
      ]
    });
  });

  it("renders markdown spoilers as spoiler entities", () => {
    expect(renderMarkdownToFormattedText("Use ||spoiler|| later")).toEqual({
      text: "Use spoiler later",
      entities: [
        {
          type: "spoiler",
          offset: 4,
          length: 7
        }
      ]
    });
  });

  it("preserves nested entities inside spoilers", () => {
    expect(renderMarkdownToFormattedText("**||bold||**")).toEqual({
      text: "bold",
      entities: [
        {
          type: "bold",
          offset: 0,
          length: 4
        },
        {
          type: "spoiler",
          offset: 0,
          length: 4
        }
      ]
    });
  });

  it("keeps spoiler markers literal inside inline code", () => {
    expect(renderMarkdownToFormattedText("`||code||`")).toEqual({
      text: "||code||",
      entities: [
        {
          type: "code",
          offset: 0,
          length: 8
        }
      ]
    });
  });

  it("tracks UTF-16 offsets around emoji", () => {
    expect(renderMarkdownToFormattedText("🙂 **bold**")).toEqual({
      text: "🙂 bold",
      entities: [
        {
          type: "bold",
          offset: 3,
          length: 4
        }
      ]
    });
  });

  it("renders literal preformatted text without markdown parsing", () => {
    expect(renderPreformattedText("`literal`", "kirbot")).toEqual({
      text: "`literal`",
      entities: [
        {
          type: "pre",
          offset: 0,
          length: 9,
          language: "kirbot"
        }
      ]
    });
  });

  it("preserves spaced labels for manual preformatted text", () => {
    expect(renderPreformattedText("prompt", "user prompt")).toEqual({
      text: "prompt",
      entities: [
        {
          type: "pre",
          offset: 0,
          length: 6,
          language: "user prompt"
        }
      ]
    });
  });

  it("renders manual quotes as expandable by default", () => {
    expect(renderQuotedText("Queue preview")).toEqual({
      text: "Queue preview",
      entities: [
        {
          type: "expandable_blockquote",
          offset: 0,
          length: 13
        }
      ]
    });
  });

  it("renders manual quotes as regular blockquotes when requested", () => {
    expect(renderQuotedText("Queue preview", { kind: "blockquote" })).toEqual({
      text: "Queue preview",
      entities: [
        {
          type: "blockquote",
          offset: 0,
          length: 13
        }
      ]
    });
  });

  it("reuses shared wrappers to nest manual formatting over existing entities", () => {
    expect(
      boldFormattedText({
        text: "mix",
        entities: [
          {
            type: "italic",
            offset: 1,
            length: 2
          }
        ]
      })
    ).toEqual({
      text: "mix",
      entities: [
        {
          type: "bold",
          offset: 0,
          length: 3
        },
        {
          type: "italic",
          offset: 1,
          length: 2
        }
      ]
    });
  });

  it("renders manual links through the shared formatter path", () => {
    expect(renderLinkedText("docs", "https://example.com")).toEqual({
      text: "docs",
      entities: [
        {
          type: "text_link",
          offset: 0,
          length: 4,
          url: "https://example.com"
        }
      ]
    });
  });

  it("drops manual links whose targets are not valid Telegram URLs", () => {
    expect(renderLinkedText("plan-mode-telegram-ux-prompt.md", "/home/jtkw/kirbot/plans/plan-mode-telegram-ux-prompt.md")).toEqual({
      text: "plan-mode-telegram-ux-prompt.md",
      entities: [
        {
          type: "code",
          offset: 0,
          length: 31
        }
      ]
    });
  });

  it("drops malformed manual links that are not path-like", () => {
    expect(renderLinkedText("broken", "not a valid target")).toEqual({
      text: "broken"
    });
  });

  it("renders manual spoilers through the shared formatter path", () => {
    expect(renderSpoilerText("hidden")).toEqual({
      text: "hidden",
      entities: [
        {
          type: "spoiler",
          offset: 0,
          length: 6
        }
      ]
    });
  });

  it("chunks formatted text and preserves clipped entities", () => {
    const formatted = buildFormattedText("alpha beta gamma delta", [
      {
        type: "bold",
        offset: 6,
        length: 10
      }
    ]);

    expect(chunkFormattedText(formatted, 12)).toEqual([
      {
        text: "alpha beta",
        entities: [
          {
            type: "bold",
            offset: 6,
            length: 4
          }
        ]
      },
      {
        text: "gamma delta",
        entities: [
          {
            type: "bold",
            offset: 0,
            length: 5
          }
        ]
      }
    ]);
  });

  it("shifts entity offsets when prefixing chunk headers", () => {
    expect(
      prependText(
        "Part 1/2\n\n",
        buildFormattedText("bold", [
          {
            type: "bold",
            offset: 0,
            length: 4
          }
        ])
      )
    ).toEqual({
      text: "Part 1/2\n\nbold",
      entities: [
        {
          type: "bold",
          offset: 10,
          length: 4
        }
      ]
    });
  });
});
