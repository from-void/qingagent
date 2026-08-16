import { TRAILING_NODE_NOT_AFTER } from "./tiptap/createQingagentExtensions";
import { qingagentSchema } from "./tiptap/qingagentSchema";
import { normalizePmDoc } from "./validators";
import type { PmDoc } from "./types";

type MaterializedPmDocument = {
  eq(other: MaterializedPmDocument): boolean;
};

export interface PmPersistenceSchemaMaterializer {
  nodeFromJSON(value: unknown): MaterializedPmDocument;
}

// paragraph 是 trailingNode 自身补出的节点类型；其余类型来自 StarterKit 的 notAfter。
const trailingNodeDisabledTypes = new Set(["paragraph", ...TRAILING_NODE_NOT_AFTER]);

/**
 * 判断两份已通过 wire 校验的 PM 文档是否只存在编辑器表示差异。
 *
 * TipTap 会物化 schema 默认属性，并在列表、表格等块后补一个空段落；这些变化不应
 * 单独生成持久版本。blockId 则是落库身份的一部分，必须保留在比较中，避免吞掉块 ID
 * 自愈。任何 schema 物化异常都按“不等价”处理，让提交路径安全失败而不是漏写。
 */
export function arePmDocsPersistenceEquivalent(
  left: PmDoc,
  right: PmDoc,
  schema: PmPersistenceSchemaMaterializer = qingagentSchema,
): boolean {
  try {
    const leftVariants = persistenceVariants(left);
    const rightVariants = persistenceVariants(right);
    for (const leftVariant of leftVariants) {
      const leftNode = schema.nodeFromJSON(leftVariant);
      for (const rightVariant of rightVariants) {
        if (leftNode.eq(schema.nodeFromJSON(rightVariant))) return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

function persistenceVariants(doc: PmDoc): PmDoc[] {
  const normalized = normalizePmDoc(doc);
  const withoutScaffold = withoutTrailingNodeScaffold(normalized);
  return withoutScaffold ? [normalized, withoutScaffold] : [normalized];
}

function withoutTrailingNodeScaffold(doc: PmDoc): PmDoc | null {
  if (doc.content.length < 2) return null;
  const trailing = doc.content.at(-1);
  const previous = doc.content.at(-2);
  if (
    trailing?.type !== "paragraph" ||
    (trailing.content?.length ?? 0) > 0 ||
    !previous ||
    trailingNodeDisabledTypes.has(previous.type)
  ) {
    return null;
  }
  return { ...doc, content: doc.content.slice(0, -1) };
}
