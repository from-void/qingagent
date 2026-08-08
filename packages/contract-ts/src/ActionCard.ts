export interface ActionCardLine {
  label: string;
  value: string;
}

export type ActionCardStatus = "running" | "done" | "aborted" | "failed";

export interface ActionCardData {
  icon?: string;
  title: string;
  lines: ActionCardLine[];
  status: ActionCardStatus;
}
