import type { RequestContext } from "@mastra/core/request-context";

const counters = new WeakMap<object, Map<string, number>>();

/**
 * 同一请求上下文内按 callSite/lane 连续编号；不能把 runId 放进 key：
 * 主 Agent 首次 provider 请求开始后 Mastra 才返回 runId，终态前补写 runId 不应让下一 step 归 1。
 */
export function nextUsageAttempt(
  requestContext: RequestContext | undefined,
  callSite: string,
  lane?: number | null,
): number {
  if (!requestContext) return 1;
  let perContext = counters.get(requestContext);
  if (!perContext) {
    perContext = new Map();
    counters.set(requestContext, perContext);
  }
  const key = `${callSite}|${lane ?? "none"}`;
  const next = (perContext.get(key) ?? 0) + 1;
  perContext.set(key, next);
  return next;
}
