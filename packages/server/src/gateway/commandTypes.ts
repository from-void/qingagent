import type { ModelOverrides } from "./bridgeCore";
import type { Origin } from "./commandTracing";

export interface CommandExecutionContext {
  /** SessionActor 的路由键；无 sessionId 的 review 命令靠它做冷恢复。 */
  sessionId: string | undefined;
  clientTraceId: string | undefined;
  resolvedClientTraceId: string | undefined;
  origin: Origin;
  modelOverrides: ModelOverrides | undefined;
  client: string | undefined;
}
