import type { ModelOverrides } from "./bridgeCore";
import type { Origin } from "./commandTracing";

export interface CommandExecutionContext {
  clientTraceId: string | undefined;
  resolvedClientTraceId: string | undefined;
  origin: Origin;
  modelOverrides: ModelOverrides | undefined;
  client: string | undefined;
}
