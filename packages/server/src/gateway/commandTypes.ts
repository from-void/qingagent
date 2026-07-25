import type { ModelOverrides } from "./bridgeCore";
import type { Origin } from "./commandTracing";
import type { TurnPreemptionReason } from "./sessionActor";

export interface CommandExecutionContext {
  /** SessionActor 的路由键；无 sessionId 的 review 命令靠它做冷恢复。 */
  sessionId: string | undefined;
  clientTraceId: string | undefined;
  resolvedClientTraceId: string | undefined;
  origin: Origin;
  modelOverrides: ModelOverrides | undefined;
  client: string | undefined;
  commandAbortSignal: AbortSignal | undefined;
  /** Actor 已直接抢占旧轮时的原因；下一队列项据此走确定性清理。 */
  preemptionReason?: TurnPreemptionReason;
}
