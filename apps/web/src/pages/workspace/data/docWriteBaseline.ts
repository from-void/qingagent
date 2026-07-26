import type { PmDoc } from "@qingagent/pm-schema";
import { pmDocHasSubstantiveContent } from "./pageExitSave";

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
