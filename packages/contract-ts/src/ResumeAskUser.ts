import type { AskUserAnswer } from "./AskUserAnswer";

export type ResumeAskUser = {
  sessionId: string;
  answers: { [key in string]?: AskUserAnswer };
};
