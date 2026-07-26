const PROMISED_ACTION_AT_END =
  /(?:让我(?:先)?(?:去)?(?:查|看|改|搜)(?:一下)?|接下来我(?:会|来)|我(?:这就|马上)去)[^。！？\n]{0,60}[。！？…]*\s*$/u;

export const PROMISE_CONTINUATION_LIMIT = 1;

export const PROMISE_CONTINUATION_SYSTEM_MESSAGE =
  "[系统·继续执行]你刚才只宣布了本轮要执行的动作，却尚未调用工具完成。现在立即继续本轮：调用合适的工具把已承诺的动作做完，再向用户汇报实际结果；不要再次只说计划。";

export interface PromiseContinuationCandidate {
  finishReason: string | null;
  sawToolCall: boolean;
  streamWasUserAborted: boolean;
  finalText: string;
  continuationCount: number;
}

/**
 * 仅拦截无工具、正常 stop、且正文尾部明确承诺马上执行的窄集合。
 * 每条用户消息最多续推一次；中止、工具轮和其它 finish reason 一律不碰。
 */
export function shouldContinuePromisedAction(
  candidate: PromiseContinuationCandidate,
): boolean {
  if (candidate.continuationCount >= PROMISE_CONTINUATION_LIMIT) return false;
  if (candidate.streamWasUserAborted) return false;
  if (candidate.finishReason !== "stop" || candidate.sawToolCall) return false;
  return PROMISED_ACTION_AT_END.test(candidate.finalText.trim());
}
