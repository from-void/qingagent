import type { ReviewType } from "./ReviewTemplates";

export type DraftTemplateScene =
  | { kind: "review"; type: ReviewType; label: string }
  | {
      kind: "derivative";
      dtype: "gzh" | "xhs" | "translate";
      slot: "writing" | "layout";
      label: string;
    };

export interface DraftTemplateIntent {
  name: string;
  prompt: string;
}

export interface DraftTemplate {
  sessionId: string;
  scene: DraftTemplateScene;
  intent: DraftTemplateIntent;
}

export interface DraftTemplateResult {
  name: string;
  prompt: string;
}
