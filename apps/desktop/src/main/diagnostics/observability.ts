import { SpanType } from "@mastra/core/observability";
import { Observability } from "@mastra/observability";
import { configureObservability } from "@qingagent/core";
import { JsonlSpanSink } from "./jsonlSpanSink.js";

export function installDesktopObservability(logDir: string): void {
  try {
    const observability = new Observability({
      configs: {
        local: {
          serviceName: "qingagent-desktop",
          exporters: [new JsonlSpanSink(logDir)],
          logging: { enabled: false },
          excludeSpanTypes: [SpanType.MODEL_CHUNK],
        },
      },
      sensitiveDataFilter: true,
    });

    configureObservability({ observability });
  } catch (err) {
    console.warn("[diagnostics] desktop observability install failed (non-fatal):", err);
  }
}
