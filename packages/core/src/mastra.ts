import { Mastra } from "@mastra/core";
import type { ObservabilityEntrypoint } from "@mastra/core/observability";
import type { MastraCompositeStore } from "@mastra/core/storage";
import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import { setDocRenderLogger } from "@qingagent/doc-render";
import { qingagentAgent } from "./agents/qingagent.js";
import { registerObservabilityEntrypoint } from "./observability/runtime.js";

export { getObservability } from "./observability/runtime.js";

/**
 * Central Mastra instance -- registers the qingagent agent with LibSQL storage.
 *
 * Observability (DuckDB-backed tracing / structured logging) is configured
 * externally by the server package via `configureObservability()` so that
 * native `.node` bindings from @mastra/duckdb never leak into the Electron
 * desktop bundle.
 */

/**
 * Create LibSQL storage from DATABASE_URL.
 */
function createStorage(): LibSQLStore {
  const dbUrl = process.env.DATABASE_URL ?? "file:./qingagent.db";

  return new LibSQLStore({
    id: "qingagent-storage",
    url: dbUrl,
  });
}

// Storage is determined once at startup from env vars — no runtime swapping.
const store = createStorage();

const memory = new Memory({
  storage: store,
  options: {
    lastMessages: 40,
    semanticRecall: false,
    // 标题改在首稿成功落地后由 BranchCall 生成；关闭首条消息暗渠。
    generateTitle: false,
  },
});

export const mastra = new Mastra({
  agents: { qingagent: qingagentAgent },
  storage: store,
  memory: { default: memory },
});

setDocRenderLogger(mastra.getLogger());

/** Convenience accessor for the default Memory instance. */
export function getMemory(): Memory {
  return mastra.getMemory("default");
}

/**
 * Attach observability (tracing, structured logging, sensitive-data filtering)
 * to the shared Mastra instance. Call this once at server startup -- before any
 * agent invocations -- to wire in DuckDB-backed composite storage and the
 * observability entrypoint.
 *
 * The desktop app simply never calls this, so DuckDB is never imported.
 */
export function configureObservability(opts: {
  storage?: MastraCompositeStore;
  observability: ObservabilityEntrypoint;
}): void {
  if (opts.storage) {
    mastra.setStorage(opts.storage);
  }

  // Expose the entrypoint to the rest of the backend (e.g. agentSpans'
  // llm_response span) via getObservability().
  registerObservabilityEntrypoint(opts.observability);

  // The Mastra instance above is constructed WITHOUT observability so that
  // @mastra/duckdb's native bindings never enter core's dependency tree (they
  // would break the Electron desktop bundle, which never calls this function).
  // `registerExporter` is purpose-built for this case: its JSDoc states it is
  // "primarily used to bootstrap observability when the Mastra instance was
  // constructed without it (e.g. when the entrypoint and its native exporters
  // must stay out of certain bundles)". When the current observability is the
  // constructor's no-op, the first call replaces it with `entrypoint` and
  // registers `instance` as default; subsequent exporters are added to it.
  //
  // Everything needed is reachable from `opts.observability`, which is typed as
  // ObservabilityEntrypoint (the server's `new Observability(...)`), so no
  // DuckDB-specific type ever crosses into core.
  const entrypoint = opts.observability;
  const instance = entrypoint.getDefaultInstance();
  if (!instance) {
    // No default tracing instance means there is nothing to export through.
    // Surface this loudly rather than silently dropping every span (the exact
    // failure mode this wiring fix exists to eliminate).
    throw new Error(
      "configureObservability: observability entrypoint has no default " +
        "instance; cannot register exporters (tracing would be dropped).",
    );
  }

  for (const exporter of instance.getExporters()) {
    mastra.registerExporter(exporter, instance, entrypoint);
  }
}
