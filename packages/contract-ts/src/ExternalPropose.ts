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
   * `line` 在该 op 执行时按整篇 Markdown 解释；同批较早操作可能令原行号失效。
   * 目标落在表格等多行块内部时会拒绝，调用方应拆批或改用块/内容锚点。
   */
  | { kind: "insertAfterLine"; line: number; markdown: string }
  | { kind: "appendSection"; markdown: string }
  | { kind: "deleteBlock"; blockId: string }
  | { kind: "deleteListItem"; blockId: string };
