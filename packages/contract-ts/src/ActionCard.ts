export interface ActionCardLine {
  label: string;
  value: string;
}

export interface ActionCardData {
  icon?: string;
  title: string;
  lines: ActionCardLine[];
}
