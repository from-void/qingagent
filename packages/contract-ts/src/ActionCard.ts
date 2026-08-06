export interface ActionCardLine {
  label: string;
  value: string;
}

export type ActionCardStatus = "running" | "done" | "aborted" | "failed";

export interface ActionCardData {
  icon?: string;
  title: string;
  lines: ActionCardLine[];
  /** 可选的任务终态；旧动作卡无此字段时保持“已提交”语义。 */
  status?: ActionCardStatus;
}
