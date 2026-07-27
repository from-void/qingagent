import { getPmContentHash, normalizePmDoc, type PmDoc } from "@qingagent/pm-schema";
import { pmDocHasSubstantiveContent } from "./pageExitSave";
import type { ViewDocumentSnapshot } from "./protocol";

/**
 * 编辑事务产生时的 canonical 基线。它必须跟待保存正文一起冻结，不能在真正发包时
 * 从全局 ref 重新读取；否则 agent/外标签先推进版本后，陈旧正文会被误绑到新基线。
 */
export interface DocWriteBaseline {
  expectedDocumentSnapshot: number;
  baseContentHash: string;
  baseHasSubstantiveContent: boolean;
}

export type EditorDocChange = (
  doc: PmDoc,
  baseline?: DocWriteBaseline,
) => void | Promise<void>;

/**
 * 服务端首写时构造的空文档:version 0 的乐观锁基线以它为准(与 commitDocumentOp 的 emptyPmDoc 同形)。
 */
export const EMPTY_PM_DOC: PmDoc = {
  type: "doc",
  attrs: { schemaVersion: 1 },
  content: [],
} as unknown as PmDoc;

export const EMPTY_PM_DOC_CONTENT_HASH = getPmContentHash(EMPTY_PM_DOC);

/**
 * 乐观锁基线只能按【服务端 canonical 原样】计算。装载侧安全网(把伪装成代码块的 Mermaid
 * 升级回图表块、展平嵌套表格)改的是编辑器里看到的正文,并不代表服务端已经存成那样;
 * 拿变换后的正文算 baseContentHash,会与服务端 contentHash 永远对不上——该文档的任何一次
 * 写入都被判冲突,而重载拿回的还是同一份 canonical,冲突永远复现(纯读也会因图表块回写
 * attrs.svg 触发一次写入而弹提示)。
 */
export function canonicalBaselinePmDoc(
  doc: ViewDocumentSnapshot,
  fallback: (doc: ViewDocumentSnapshot) => PmDoc,
): PmDoc {
  return normalizePmDoc(doc.pmDoc ?? fallback(doc));
}

export function canonicalDocWriteBaseline(
  doc: ViewDocumentSnapshot,
  fallback: (doc: ViewDocumentSnapshot) => PmDoc,
): DocWriteBaseline {
  // version 0 = 服务端还没有这份文档,它首写时拿来比对的是空文档;
  // 而本地这时通常已经摆着一个带 blockId 的空段落脚手架,拿脚手架算 hash 与服务端对不上
  // → 首写必冲突,文档永远建不出来,之后每一笔(含图表块回写 attrs.svg)都跟着冲突。
  if (doc.version === 0) {
    return {
      expectedDocumentSnapshot: 0,
      baseContentHash: EMPTY_PM_DOC_CONTENT_HASH,
      baseHasSubstantiveContent: false,
    };
  }
  const canonical = canonicalBaselinePmDoc(doc, fallback);
  return {
    expectedDocumentSnapshot: doc.version,
    baseContentHash: getPmContentHash(canonical),
    baseHasSubstantiveContent: pmDocHasSubstantiveContent(canonical),
  };
}

/**
 * 仅“空基线 → 空提交，且没有排队中的实质输入”可静默丢弃并拉权威快照。
 * 用户从有内容的正文执行删除，或冲突期间又输入了正文，都必须留在既有冲突保留路径。
 */
export function isEmptyScaffoldConflict(input: {
  baseline: DocWriteBaseline | null;
  submittedDoc: PmDoc | null;
  queuedDoc: PmDoc | null;
}): boolean {
  return Boolean(
    input.baseline &&
    !input.baseline.baseHasSubstantiveContent &&
    input.submittedDoc &&
    !pmDocHasSubstantiveContent(input.submittedDoc) &&
    (!input.queuedDoc || !pmDocHasSubstantiveContent(input.queuedDoc)),
  );
}
