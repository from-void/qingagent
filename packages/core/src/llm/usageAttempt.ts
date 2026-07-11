import type { RequestContext } from "@mastra/core/request-context";

const counters = new WeakMap<object, Map<string, number>>();

/** 同一请求上下文内按 run/callSite/lane 连续编号；model resolver 重建包装也不会归 1。 */
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
  const runId = requestContext.get("runId");
  const key = `${typeof runId === "string" ? runId : "no-run"}|${callSite}|${lane ?? "none"}`;
  const next = (perContext.get(key) ?? 0) + 1;
  perContext.set(key, next);
  return next;
}
