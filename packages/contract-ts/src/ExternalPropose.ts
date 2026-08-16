import type { DraftTextMark } from "./DraftMutation";

export interface ExternalPropose {
  sessionId: string;
  expectedDocVersion: number;
  clientMutationId?: string;
  /** 结构操作的请求级幂等键；同一 opId 只能对应同一请求体。 */
  opId?: string;
  ops: ExternalProposeOp[];
}

export type ExternalProposeOp =
  | { kind: "fullDraft"; markdown: string }
  | { kind: "qingmlDraft"; qingml: string }
  | { kind: "setTitle"; title: string }
  | { kind: "strReplace"; old: string; new: string; nth?: number }
  /**
   * 为命中文本添加或移除行内标记。已知呈现限制：命中列表项时，审阅卡暂按
   * 顶层块粒度显示为整列表 replace；列表项级 hunk 由后续能力处理。
   */
  | {
      kind: "markText";
      find: string;
      mark: DraftTextMark;
      op: "add" | "remove";
      all?: boolean;
      isRegex?: boolean;
      withinRef?: string;
    }
  /**
   * `line` 在该 op 执行时按整篇 Markdown 解释；同批较早操作可能令原行号失效。
   * 目标落在表格等多行块内部时会拒绝，调用方应拆批或改用 insertAfterBlock。
   */
  | { kind: "insertAfterLine"; line: number; markdown: string }
  /**
   * 列表项锚点会在同一列表、同一深度插入一个同类项；其它顶层块锚点会在块后插入 Markdown 顶层块。
   * 暂不支持表格 cell 内锚点。
   */
  | { kind: "insertAfterBlock"; blockId: string; markdown: string }
  | { kind: "appendSection"; markdown: string }
  | { kind: "deleteBlock"; blockId: string }
  | { kind: "deleteListItem"; blockId: string };

/** 需要请求级 opId 与服务端 digest 幂等保护的外部结构操作。 */
export const EXTERNAL_STRUCTURAL_OP_KINDS = [
  "insertAfterBlock",
  "deleteBlock",
  "deleteListItem",
] as const satisfies readonly ExternalProposeOp["kind"][];
