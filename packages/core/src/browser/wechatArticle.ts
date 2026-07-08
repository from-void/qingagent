import * as cheerio from "cheerio";

export interface WechatArticleExtraction {
  title: string;
  author: string;
  markdown: string;
  images: Array<{ src: string; alt: string | null }>;
}

const WECHAT_NOISE_SELECTOR = [
  ".rich_media_tool",
  ".qr_code_pc",
  ".rich_media_area_extra",
  ".rich_media_meta_list",
  ".reward_area",
  "#js_profile_qrcode",
  ".video_iframe",
  "mp-common-mpaudio",
  "mpvoice",
  ".weapp_text_link",
  ".qqmusic_area",
  "script",
  "style",
].join(",");

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "div",
  "figure",
  "figcaption",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

export function isWechatArticleUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    return hostname === "mp.weixin.qq.com" || hostname.endsWith(".mp.weixin.qq.com");
  } catch {
    return false;
  }
}

export function extractWechatArticle(html: string, baseUrl: string): WechatArticleExtraction {
  const $ = cheerio.load(html);
  const title = normalizeInline($("h1.rich_media_title").first().text());
  const author = normalizeInline($("#js_name").first().text());
  const root = $("#js_content").first().length
    ? $("#js_content").first()
    : $(".rich_media_content").first();

  if (root.length === 0) {
    throw new Error("Could not find WeChat article body root.");
  }

  root.find(WECHAT_NOISE_SELECTOR).remove();

  const imageMap = new Map<string, { src: string; alt: string | null }>();
  const context: RenderContext = { baseUrl, images: imageMap };
  const markdown = cleanupMarkdown(renderFlow(context, root.contents().toArray() as HtmlNode[]));

  return {
    title,
    author,
    markdown,
    images: Array.from(imageMap.values()),
  };
}

interface RenderContext {
  baseUrl: string;
  images: Map<string, { src: string; alt: string | null }>;
}

interface HtmlNode {
  type: string;
  data?: string;
  children?: HtmlNode[];
}

interface HtmlElement extends HtmlNode {
  tagName?: string;
  name?: string;
  attribs?: Record<string, string>;
}

function renderFlow(context: RenderContext, nodes: HtmlNode[]): string {
  const blocks: string[] = [];
  let inline = "";

  const flushInline = () => {
    const text = normalizeInline(inline);
    if (isUsefulBlock(text)) blocks.push(text);
    inline = "";
  };

  for (const node of nodes) {
    if (isElement(node) && BLOCK_TAGS.has(tagName(node))) {
      flushInline();
      const block = renderBlock(context, node);
      if (isUsefulBlock(block)) blocks.push(block.trim());
      continue;
    }
    inline += renderInline(context, node);
  }

  flushInline();
  return blocks.join("\n\n");
}

function renderBlock(context: RenderContext, element: HtmlElement): string {
  const tag = tagName(element);
  const children = element.children ?? [];

  if (/^h[1-6]$/.test(tag)) {
    const level = Math.min(Number(tag.slice(1)), 4);
    const text = normalizeInline(renderChildrenInline(context, children));
    return text ? `${"#".repeat(level)} ${text}` : "";
  }

  if (tag === "p" || tag === "figcaption" || tag === "td" || tag === "th") {
    return normalizeInline(renderChildrenInline(context, children));
  }

  if (tag === "pre") {
    const code = textContent(element).replace(/\n{3,}/g, "\n\n").trim();
    return code ? "```\n" + code + "\n```" : "";
  }

  if (tag === "blockquote") {
    const body = renderFlow(context, children);
    return body
      .split("\n")
      .map((line) => (line.trim() ? `> ${line}` : ">"))
      .join("\n");
  }

  if (tag === "table") {
    return renderTable(context, element);
  }

  if (tag === "ul" || tag === "ol") {
    return renderList(context, element, tag === "ol");
  }

  if (tag === "li") {
    return normalizeInline(renderChildrenInline(context, children));
  }

  if (tag === "hr") {
    return "---";
  }

  return renderFlow(context, children);
}

function renderList(context: RenderContext, element: HtmlElement, ordered: boolean): string {
  const items = (element.children ?? []).filter((child): child is HtmlElement => {
    return isElement(child) && tagName(child) === "li";
  });

  return items
    .map((item, index) => {
      const marker = ordered ? `${index + 1}. ` : "- ";
      const body = renderFlow(context, item.children ?? []);
      if (!body.trim()) return "";
      const lines = body.trim().split("\n");
      return [marker + lines[0], ...lines.slice(1).map((line) => "  " + line)].join("\n");
    })
    .filter(Boolean)
    .join("\n");
}

// 递归收集某标签的后代元素(用于从 table 里捞出所有 tr,不管包在 thead/tbody 里)。
function collectDescendantsByTag(element: HtmlElement, target: string): HtmlElement[] {
  const out: HtmlElement[] = [];
  const walk = (nodes: HtmlNode[]) => {
    for (const node of nodes) {
      if (!isElement(node)) continue;
      if (tagName(node) === target) out.push(node);
      else walk(node.children ?? []);
    }
  };
  walk(element.children ?? []);
  return out;
}

// 表格 → Markdown 表:第一行作表头,补分隔行,单元格内换行/竖线转义。
function renderTable(context: RenderContext, element: HtmlElement): string {
  const rows = collectDescendantsByTag(element, "tr")
    .map((tr) =>
      (tr.children ?? [])
        .filter((c): c is HtmlElement => isElement(c) && (tagName(c) === "td" || tagName(c) === "th"))
        .map((cell) =>
          normalizeInline(renderChildrenInline(context, cell.children ?? []))
            .replace(/\|/g, "\\|")
            .replace(/\n+/g, " "),
        ),
    )
    .filter((cells) => cells.length > 0);
  if (rows.length === 0) return "";

  const cols = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]): string[] => {
    const a = [...r];
    while (a.length < cols) a.push("");
    return a;
  };
  const fmt = (r: string[]): string => `| ${pad(r).join(" | ")} |`;
  const header = fmt(rows[0] ?? []);
  const sep = `| ${Array(cols).fill("---").join(" | ")} |`;
  const body = rows.slice(1).map(fmt);
  return [header, sep, ...body].join("\n");
}

function renderChildrenInline(context: RenderContext, nodes: HtmlNode[]): string {
  return nodes.map((node) => renderInline(context, node)).join("");
}

function renderInline(context: RenderContext, node: HtmlNode): string {
  if (node.type === "text") {
    return node.data ?? "";
  }
  if (!isElement(node)) {
    return "";
  }

  const tag = tagName(node);
  const children = node.children ?? [];

  if (tag === "br") return "\n";
  if (tag === "img") return renderImage(context, node);
  if (tag === "strong" || tag === "b") return wrapInline("**", renderChildrenInline(context, children));
  if (tag === "em" || tag === "i") return wrapInline("*", renderChildrenInline(context, children));
  if (tag === "code") return renderInlineCode(textContent(node));
  if (tag === "sup") return normalizeInline(textContent(node));
  if (tag === "a") return renderLink(context, node);
  if (tag === "pre") return "\n\n" + renderBlock(context, node) + "\n\n";
  if (BLOCK_TAGS.has(tag)) return "\n\n" + renderBlock(context, node) + "\n\n";

  return renderChildrenInline(context, children);
}

function renderLink(context: RenderContext, element: HtmlElement): string {
  const text = normalizeInline(renderChildrenInline(context, element.children ?? []));
  const href = resolveUrl(getAttr(element, "href"), context.baseUrl);
  if (!text) return "";
  return href ? `[${text}](${href})` : text;
}

function renderImage(context: RenderContext, element: HtmlElement): string {
  const rawSrc = getAttr(element, "data-src") || getAttr(element, "src");
  const src = resolveUrl(rawSrc, context.baseUrl);
  if (!src) return "";
  const rawAlt = getAttr(element, "alt") ?? null;
  const alt = rawAlt && rawAlt.trim() ? normalizeInline(rawAlt) : null;
  if (!context.images.has(src)) {
    context.images.set(src, { src, alt });
  }
  return `![${alt ?? ""}](${src})`;
}

function renderInlineCode(value: string): string {
  const text = normalizeInline(value).replace(/`/g, "\\`");
  return text ? "`" + text + "`" : "";
}

function wrapInline(wrapper: string, value: string): string {
  const text = normalizeInline(value);
  return text ? `${wrapper}${text}${wrapper}` : "";
}

function resolveUrl(value: string | undefined, baseUrl: string): string | null {
  if (!value) return null;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}

function normalizeInline(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/[ \t\r\f\v]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function cleanupMarkdown(markdown: string): string {
  return markdown
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(isUsefulBlock)
    .join("\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isUsefulBlock(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  if (text === "---") return true;
  if (/!\[[^\]]*]\([^)]+\)/.test(text)) return true;
  return /[\p{L}\p{N}\u4e00-\u9fff]/u.test(text);
}

function getAttr(element: HtmlElement, name: string): string | undefined {
  return element.attribs?.[name];
}

function textContent(node: HtmlNode): string {
  if (node.type === "text") return node.data ?? "";
  return (node.children ?? []).map(textContent).join("");
}

function isElement(node: HtmlNode): node is HtmlElement {
  return node.type === "tag" || node.type === "script" || node.type === "style";
}

function tagName(element: HtmlElement): string {
  return (element.tagName || element.name || "").toLowerCase();
}
