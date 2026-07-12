import type { ObservabilityEntrypoint } from "@mastra/core/observability";

// 由组合根在启动时注册；低层 observability 模块只读取可选运行时，避免回引 mastra.ts。
let observabilityEntrypoint: ObservabilityEntrypoint | null = null;

export function registerObservabilityEntrypoint(
  entrypoint: ObservabilityEntrypoint,
): void {
  observabilityEntrypoint = entrypoint;
}

export function getObservability(): ObservabilityEntrypoint | null {
  return observabilityEntrypoint;
}
