import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false
});

export function renderMarkdownToHtml(markdownText: string): string {
  return markdown.render(markdownText || "(empty plan)");
}
