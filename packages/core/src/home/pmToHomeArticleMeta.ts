import { pmToPlainText, type PmBlockNode, type PmDoc, type PmNode } from "@qingagent/pm-schema";

export interface HomeArticleMetaInput {
  fallbackTitle?: string | null;
  category?: string | null;
  tags?: string[];
  descriptionLength?: number;
}

export interface HomeArticleMeta {
  title: string;
  description: string;
  imageUrl: string | null;
  category?: string;
  tags: string[];
}

export function pmToHomeArticleMeta(doc: PmDoc, input: HomeArticleMetaInput = {}): HomeArticleMeta {
  const plainText = compactWhitespace(pmToPlainText(doc));
  return {
    title: firstHeadingText(doc) || normalizeTitle(input.fallbackTitle) || "未命名草稿",
    description: truncate(plainText, input.descriptionLength ?? 42) || "未开始",
    imageUrl: firstImageUrl(doc),
    ...(input.category ? { category: input.category } : {}),
    tags: input.tags ?? [],
  };
}

function firstHeadingText(doc: PmDoc): string | null {
  for (const node of doc.content) {
    if (node.type !== "heading") continue;
    const text = compactWhitespace(inlineText(node));
    if (text) return text;
  }
  return null;
}

function firstImageUrl(doc: PmDoc): string | null {
  for (const node of doc.content) {
    const src = findImageSrc(node);
    if (src?.startsWith("/api/v1/files/")) return src;
  }
  return null;
}

function findImageSrc(node: PmNode): string | null {
  switch (node.type) {
    case "image":
      return node.attrs.src;
    case "blockquote":
    case "bulletList":
    case "orderedList":
    case "listItem":
    case "table":
    case "tableRow":
    case "tableCell":
    case "tableHeader":
    case "columnList":
    case "column":
      for (const child of "content" in node ? node.content : []) {
        const src = findImageSrc(child);
        if (src) return src;
      }
      return null;
    default:
      return null;
  }
}

function inlineText(node: Extract<PmBlockNode, { type: "heading" }>): string {
  return (node.content ?? []).map((child) => child.type === "text" ? child.text : "\n").join("");
}

function normalizeTitle(value: string | null | undefined): string | null {
  const title = value?.trim();
  return title ? title : null;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}
