import { normalizePmDoc } from "@qingagent/pm-schema";

type MaterializedPmDocument = {
  eq(other: MaterializedPmDocument): boolean;
};

export interface PmDocumentSchemaMaterializer {
  nodeFromJSON(value: unknown): MaterializedPmDocument;
}

export type PmDocumentComparison =
  | "equivalent"
  | "different"
  | "unavailable";

type PreparedDocument = {
  json: unknown;
  key: string;
};

/**
 * 比较正文结构与持久内容，不把 blockId 当正文语义。
 *
 * 审阅揭示会经 HTML 短暂重建 live PM；这条投影可能丢失块身份，但不会改变正文。
 * 两侧先走同一 normalize + 当前编辑器 schema 默认属性物化，避免表格默认 attrs、
 * 图片默认对齐等表示差异制造假分叉。StarterKit 自动补的无身份末尾空段也在两侧
 * 对称枚举，只有移除后全文仍等价才会命中。
 *
 * schema 物化若异常，不把“无法比较”冒充“正文不同”：逐字相同的无身份规范形仍可
 * 直接证明等价；其余返回 unavailable，由调用方只在同版本审阅基线下静默保留现场。
 */
export function comparePmDocumentSemantics(
  schema: PmDocumentSchemaMaterializer,
  left: unknown,
  right: unknown,
): PmDocumentComparison {
  const leftPrepared = prepareDocumentVariants(left);
  const rightPrepared = prepareDocumentVariants(right);
  if (!leftPrepared || !rightPrepared) return "unavailable";

  for (const leftVariant of leftPrepared.variants) {
    for (const rightVariant of rightPrepared.variants) {
      if (leftVariant.key === rightVariant.key) return "equivalent";
    }
  }

  let comparisonUnavailable =
    leftPrepared.variantFailed || rightPrepared.variantFailed;
  const leftMaterialized = materializeVariants(schema, leftPrepared.variants);
  const rightMaterialized = materializeVariants(schema, rightPrepared.variants);
  comparisonUnavailable ||= leftMaterialized.failed || rightMaterialized.failed;

  for (const leftVariant of leftMaterialized.documents) {
    for (const rightVariant of rightMaterialized.documents) {
      try {
        if (leftVariant.eq(rightVariant)) return "equivalent";
      } catch {
        comparisonUnavailable = true;
      }
    }
  }

  return comparisonUnavailable ? "unavailable" : "different";
}

function prepareDocumentVariants(value: unknown): {
  variants: PreparedDocument[];
  variantFailed: boolean;
} | null {
  const rawVariants = [value];
  const withoutScaffold = withoutUnpersistedTrailingParagraph(value);
  if (withoutScaffold) rawVariants.push(withoutScaffold);

  const variants: PreparedDocument[] = [];
  let variantFailed = false;
  for (const raw of rawVariants) {
    try {
      const json = stripBlockIds(normalizePmDoc(raw));
      const key = JSON.stringify(json);
      if (!variants.some((variant) => variant.key === key)) {
        variants.push({ json, key });
      }
    } catch {
      variantFailed = true;
    }
  }

  if (variants.length === 0) return null;
  return { variants, variantFailed };
}

function materializeVariants(
  schema: PmDocumentSchemaMaterializer,
  variants: readonly PreparedDocument[],
): { documents: MaterializedPmDocument[]; failed: boolean } {
  const documents: MaterializedPmDocument[] = [];
  let failed = false;
  for (const variant of variants) {
    try {
      documents.push(schema.nodeFromJSON(variant.json));
    } catch {
      failed = true;
    }
  }
  return { documents, failed };
}

function withoutUnpersistedTrailingParagraph(value: unknown): unknown | null {
  if (!value || typeof value !== "object") return null;
  const doc = value as {
    type?: unknown;
    content?: unknown;
    [key: string]: unknown;
  };
  if (doc.type !== "doc" || !Array.isArray(doc.content) || doc.content.length === 0) {
    return null;
  }
  const trailing = doc.content.at(-1);
  if (!trailing || typeof trailing !== "object") return null;
  const node = trailing as {
    type?: unknown;
    attrs?: unknown;
    content?: unknown;
  };
  const attrs = node.attrs && typeof node.attrs === "object"
    ? node.attrs as { blockId?: unknown }
    : null;
  if (
    node.type !== "paragraph" ||
    (Array.isArray(node.content) && node.content.length > 0) ||
    attrs?.blockId != null
  ) {
    return null;
  }
  return { ...doc, content: doc.content.slice(0, -1) };
}

function stripBlockIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripBlockIds);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (key === "blockId") continue;
    output[key] = stripBlockIds(child);
  }
  return output;
}
