const UNSUPPORTED_LINK_PROTOCOLS = new Set(["data:", "file:", "javascript:"]);
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;
const RELATIVE_PATH_PREFIX = /^(?:\.{1,2}\/|~\/)/;
const REPO_RELATIVE_FILE_PATH = /^(?:[^/\s]+\/)+[^/\s]+\.[A-Za-z0-9]+$/;

type MdastNode = {
  type?: unknown;
  value?: unknown;
  lang?: unknown;
  url?: unknown;
  alt?: unknown;
  label?: unknown;
  identifier?: unknown;
  start?: unknown;
  ordered?: unknown;
  children?: unknown;
};

export function renderMdastToHtml(mdast: unknown, markdownText: string): string {
  if (!isMdastRoot(mdast)) {
    return renderMarkdownFallback(markdownText);
  }

  return renderRoot(mdast);
}

function renderRoot(node: MdastNode): string {
  return renderBlockSequence(asChildren(node.children), "\n");
}

function renderBlockSequence(nodes: MdastNode[], separator: string): string {
  return nodes
    .filter((node) => node.type !== "definition")
    .map((node) => renderBlock(node))
    .join(separator);
}

function renderBlock(node: MdastNode): string {
  switch (node.type) {
    case "paragraph":
      return `<p>${renderInlineSequence(asChildren(node.children))}</p>`;
    case "heading":
      return `<h${headingLevel(node)}>${renderInlineSequence(asChildren(node.children))}</h${headingLevel(node)}>`;
    case "blockquote":
      return `<blockquote>${renderBlockSequence(asChildren(node.children), "\n")}</blockquote>`;
    case "code":
      return `<pre><code${renderLanguageAttr(node.lang)}>${escapeHtml(asString(node.value))}</code></pre>`;
    case "list":
      return renderList(node);
    case "thematicBreak":
      return "<hr />";
    case "html":
      return `<p>${escapeHtml(asString(node.value))}</p>`;
    default:
      return renderFallback(node);
  }
}

function renderList(node: MdastNode): string {
  const tag = node.ordered ? "ol" : "ul";
  const start =
    node.ordered && typeof node.start === "number" && node.start > 1 ? ` start="${escapeHtml(String(node.start))}"` : "";
  const items = asChildren(node.children).map((child) => `<li>${renderListItem(child)}</li>`).join("");
  return `<${tag}${start}>${items}</${tag}>`;
}

function renderListItem(node: MdastNode): string {
  const children = asChildren(node.children);
  if (children.length === 0) {
    return "";
  }

  if (children.length === 1 && children[0]?.type === "paragraph") {
    return renderInlineSequence(asChildren(children[0].children));
  }

  return renderBlockSequence(children, "\n");
}

function renderInlineSequence(nodes: MdastNode[]): string {
  return nodes.map((node) => renderInline(node)).join("");
}

function renderInline(node: MdastNode): string {
  switch (node.type) {
    case "text":
      return escapeHtml(asString(node.value));
    case "strong":
      return `<strong>${renderInlineSequence(asChildren(node.children))}</strong>`;
    case "emphasis":
      return `<em>${renderInlineSequence(asChildren(node.children))}</em>`;
    case "delete":
      return `<del>${renderInlineSequence(asChildren(node.children))}</del>`;
    case "inlineCode":
      return `<code>${escapeHtml(asString(node.value))}</code>`;
    case "link":
      return renderLink(node);
    case "break":
      return "<br />";
    case "html":
      return escapeHtml(asString(node.value));
    case "linkReference":
      return renderInlineSequence(asChildren(node.children));
    case "image":
      return escapeHtml(asString(node.alt) || asString(node.url));
    case "imageReference":
      return escapeHtml(asString(node.alt) || asString(node.label));
    case "footnoteReference":
      return escapeHtml(`[^${asString(node.identifier)}]`);
    default:
      return renderFallback(node);
  }
}

function renderLink(node: MdastNode): string {
  const label = renderInlineSequence(asChildren(node.children));
  const url = asString(node.url);

  if (isPathLikeLinkTarget(url)) {
    return `<code>${label || escapeHtml(url)}</code>`;
  }

  if (!isSafeLinkUrl(url)) {
    return label;
  }

  return `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${label}</a>`;
}

function renderFallback(node: MdastNode): string {
  if (Array.isArray(node.children)) {
    const children = asChildren(node.children);
    if (children.some((child) => isBlockNode(child.type))) {
      return renderBlockSequence(children, "\n");
    }
    return renderInlineSequence(children);
  }

  if (typeof node.value === "string") {
    return escapeHtml(node.value);
  }

  return "";
}

function renderMarkdownFallback(markdownText: string): string {
  return `<pre>${escapeHtml(markdownText || "(empty plan)")}</pre>`;
}

function headingLevel(node: MdastNode): number {
  const depth = typeof (node as { depth?: unknown }).depth === "number" ? (node as { depth: number }).depth : 1;
  return Math.min(6, Math.max(1, depth));
}

function renderLanguageAttr(lang: unknown): string {
  return typeof lang === "string" && lang.length > 0 ? ` data-language="${escapeHtml(lang)}"` : "";
}

function isMdastRoot(value: unknown): value is MdastNode {
  return Boolean(value && typeof value === "object" && (value as MdastNode).type === "root" && Array.isArray((value as MdastNode).children));
}

function asChildren(value: unknown): MdastNode[] {
  return Array.isArray(value) ? value.filter((child): child is MdastNode => Boolean(child && typeof child === "object")) : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isBlockNode(type: unknown): boolean {
  return (
    type === "paragraph" ||
    type === "heading" ||
    type === "blockquote" ||
    type === "code" ||
    type === "list" ||
    type === "thematicBreak" ||
    type === "html"
  );
}

function isSafeLinkUrl(url: string): boolean {
  if (!/^[A-Za-z][A-Za-z\d+.-]*:/.test(url)) {
    return false;
  }

  try {
    const parsed = new URL(url);
    return !UNSUPPORTED_LINK_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

function isPathLikeLinkTarget(url: string): boolean {
  if (url.startsWith("/")) {
    return true;
  }

  if (WINDOWS_ABSOLUTE_PATH.test(url) || RELATIVE_PATH_PREFIX.test(url)) {
    return true;
  }

  if (url.startsWith("file:")) {
    return true;
  }

  return REPO_RELATIVE_FILE_PATH.test(url);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
