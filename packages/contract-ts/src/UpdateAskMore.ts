import type { AskUserOption } from "./AskUserOption";

export interface AskMoreQuestion {
  id: string;
  label: string;
  kind: { kind: "single" | "multi" | "text" };
  options: AskUserOption[];
  placeholder: string | null;
}

export type UpdateAskMore =
  | {
      phase: "started";
      sessionId: string;
      toolCallId: string;
    }
  | {
      phase: "completed";
      sessionId: string;
      toolCallId: string;
      questions: AskMoreQuestion[];
    };
