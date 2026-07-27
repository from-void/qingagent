import type { AskUserAnswer } from "./AskUserAnswer";

export type ResumeAskUser = {
  sessionId: string;
  /** 前端实际提交的 askUser toolCall id；服务端据此校验当前挂起问卷所有权。 */
  toolCallId?: string;
  answers: { [key in string]?: AskUserAnswer };
};
