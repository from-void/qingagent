export interface ActionCardLine {
  label: string;
  value: string;
}

/** sent:纯快照卡——「消息已发出」这一事件的记录,不携带任务进度语义(用户裁定
 *  发起审查卡不做 loading/完成态,与 DSH 插件气泡卡一致)。 */
export type ActionCardStatus = "sent" | "running" | "done" | "aborted" | "failed";

export interface ActionCardData {
  icon?: string;
  title: string;
  lines: ActionCardLine[];
  status: ActionCardStatus;
}
