import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const mocks = vi.hoisted(() => ({
  buildDiagnosticsZip: vi.fn(),
}));

vi.mock("../diagnostics/exporter", () => ({
  buildDiagnosticsZip: mocks.buildDiagnosticsZip,
}));

describe("diagnostics export route", () => {
  it("POST /diagnostics/export 返回 zip 附件", async () => {
    mocks.buildDiagnosticsZip.mockResolvedValueOnce({
      buffer: Buffer.from("zip-body"),
      manifest: { schemaVersion: 1 },
      filename: "qingagent-diag-v1-20260704-180000.zip",
    });
    const { diagnosticsRoutes } = await import("../routes/diagnostics");
    const app = new Hono();
    app.route("/api/v1", diagnosticsRoutes);

    const res = await app.request("/api/v1/diagnostics/export", {
      method: "POST",
      body: JSON.stringify({ privacyLevel: "L2", report: "卡住了" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain("qingagent-diag-v1-20260704-180000.zip");
    expect(Buffer.from(await res.arrayBuffer()).toString("utf8")).toBe("zip-body");
    expect(mocks.buildDiagnosticsZip).toHaveBeenCalledWith({
      privacyLevel: "L2",
      report: "卡住了",
    });
  });
});
