import type { AskUserAnswer } from "./AskUserAnswer";

export type ResumeAskUser = {
  sessionId: string;
  /** 前端实际提交的 askUser toolCall id；服务端用它兜底修正恢复态里的 stale id。 */
  toolCallId?: string;
  answers: { [key in string]?: AskUserAnswer };
};
