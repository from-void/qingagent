export type IgnoreAnnotationGroups = {
  sessionId: string;
  /** 仅用于诊断，不参与幂等键；重复调用始终把当前 open 批次置 ignored。 */
  reason: "tab_changed" | "message_sent" | "doc_committed" | "discard_all" | "item_ignored";
  /** 缺省表示清理全部；批注卡单条忽略时只传当前组。 */
  groupIds?: string[];
};
