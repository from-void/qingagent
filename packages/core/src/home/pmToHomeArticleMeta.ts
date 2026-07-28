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
    const src = findLocalImageSrc(node);
    if (src) return src;
  }
  return null;
}

function findLocalImageSrc(node: PmNode): string | null {
  if (node.type === "image") {
    return node.attrs.src.startsWith("/api/v1/files/") ? node.attrs.src : null;
  }
  if (!("content" in node) || !Array.isArray(node.content)) return null;
  for (const child of node.content) {
    const src = findLocalImageSrc(child);
    if (src) return src;
  }
  return null;
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
