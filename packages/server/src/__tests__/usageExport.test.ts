import { beforeEach, describe, expect, it, vi } from "vitest";

const REVISION = "b".repeat(64);
const rows = [
  { created_at: "2026-08-08T00:00:00.000Z", session_id: "s", run_id: "r1", call_site: "agent", model_id: "zero", key_origin: "env", input_tokens: 10, output_tokens: 1, cache_hit_tokens: 0, cache_miss_tokens: 10, cache_creation_tokens: 999, cache_accounting_state: "known", usage_state: "recorded", reason: null, lane: null, attempt: 1 },
  { created_at: "2026-08-08T01:00:00.000Z", session_id: "s", run_id: "r2", call_site: "agent", model_id: "peak", key_origin: "env", input_tokens: 20, output_tokens: 2, cache_hit_tokens: 5, cache_miss_tokens: 15, cache_creation_tokens: 0, cache_accounting_state: "known", usage_state: "estimated", reason: "aborted", lane: 0, attempt: 1 },
  { created_at: "2026-08-08T02:00:00.000Z", session_id: "s", run_id: "r3", call_site: "agent", model_id: "unknown", key_origin: "env", input_tokens: 30, output_tokens: 3, cache_hit_tokens: 0, cache_miss_tokens: 30, cache_creation_tokens: 0, cache_accounting_state: "unknown", usage_state: "recorded", reason: null, lane: null, attempt: 1 },
  { created_at: "2026-08-08T03:00:00.000Z", session_id: "s", run_id: "r4", call_site: "agent", model_id: "peak", key_origin: "env", input_tokens: 0, output_tokens: 0, cache_hit_tokens: 0, cache_miss_tokens: 0, cache_creation_tokens: 0, cache_accounting_state: "unknown", usage_state: "missing", reason: "no_usage", lane: null, attempt: 1 },
  { created_at: "2026-08-08T04:00:00.000Z", session_id: "s", run_id: "r5", call_site: "agent", model_id: "peak", key_origin: "env", input_tokens: 0, output_tokens: 0, cache_hit_tokens: 0, cache_miss_tokens: 0, cache_creation_tokens: 0, cache_accounting_state: "unknown", usage_state: "billing_unknown", reason: "no_response", lane: null, attempt: 1 },
];

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  compute: vi.fn((_schedule: unknown, modelId: string) => {
    if (modelId === "zero") return { costCny: 0, pricingTier: "standard", pricingMultiplier: 1 };
    if (modelId === "peak") return { costCny: 0.25, pricingTier: "peak", pricingMultiplier: 2 };
    return null;
  }),
}));

vi.mock("@qingagent/core", () => ({
  PRICING_SCHEDULE: { revision: "b".repeat(64), epochs: [] },
  computeCostCnyAt: mocks.compute,
  getDocumentsClient: () => ({ execute: mocks.execute }),
  listSessionThreads: vi.fn(async () => ({ threads: [] })),
}));
vi.mock("@qingagent/db", () => ({ resolveDbUrl: () => "file:/tmp/test.db" }));
vi.mock("../lib/debugGate", () => ({ isDebugEndpointEnabled: () => true }));
vi.mock("../lib/trustedOrigin", () => ({ requireTrustedOrigin: () => null }));

async function loadApp() {
  const { Hono } = await import("hono");
  const { dataAdminRoutes } = await import("../routes/dataAdmin");
  const app = new Hono();
  app.route("/api/v1", dataAdminRoutes);
  return app;
}

describe("usage CSV 派生计价", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execute.mockResolvedValue({ rows, rowsAffected: 0 });
  });

  it("完整 revision 与四状态/unpriced/零价/peak 三列逐行输出", async () => {
    const app = await loadApp();
    const response = await app.request("/api/v1/data/usage/export");
    expect(response.status).toBe(200);
    const csv = await response.text();
    const lines = csv.split("\n");
    expect(lines[0]).toBe(`# schedule_revision=${REVISION}`);
    expect(lines[1]).toContain("derived_cost_cny,derived_pricing_tier,derived_pricing_multiplier");
    expect(lines[2]).toMatch(/,"0","standard","1"$/);
    expect(lines[3]).toMatch(/,"0.25","peak","2"$/);
    expect(lines[4]).toMatch(/,"","unpriced",""$/);
    expect(lines[5]).toMatch(/,"","",""$/);
    expect(lines[6]).toMatch(/,"","",""$/);
    expect(mocks.compute).toHaveBeenCalledTimes(3);
    const sql = String(mocks.execute.mock.calls[0]?.[0]);
    expect(sql).toContain("FROM llm_usage_events");
    expect(sql).not.toContain("cost_cny");
    expect(mocks.execute).toHaveBeenCalledOnce();
  });
});
