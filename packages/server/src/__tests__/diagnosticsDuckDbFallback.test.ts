import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectSpans } from "../diagnostics/collect";
import { buildDiagnosticsZip } from "../diagnostics/exporter";
import {
  registerObservabilityStore,
  type ObservabilityDuckDbConnection,
} from "../observabilityStore";

describe("diagnostics DuckDB fallback", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("独立实例建连失败时 spans 降级为空且整包仍可导出", async () => {
    const invalidDuckDbPath = await mkdtemp(path.join(tmpdir(), "diag-duckdb-dir-"));
    const logsDir = await mkdtemp(path.join(tmpdir(), "diag-logs-"));
    dirs.push(invalidDuckDbPath, logsDir);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(collectSpans({
      logsDir,
      duckdbPath: invalidDuckDbPath,
      privacyLevel: "L2",
      sessionIds: ["s1"],
    })).resolves.toEqual([]);

    const oldLogsDir = process.env.QINGAGENT_LOG_DIR;
    const oldDuckDbPath = process.env.OBSERVABILITY_DUCKDB_PATH;
    process.env.QINGAGENT_LOG_DIR = logsDir;
    process.env.OBSERVABILITY_DUCKDB_PATH = invalidDuckDbPath;
    try {
      const result = await buildDiagnosticsZip({ privacyLevel: "L2" });
      expect(result.buffer.byteLength).toBeGreaterThan(0);
      expect(result.manifest.sections.find((section) => section.name === "spans")?.count).toBe(0);
    } finally {
      if (oldLogsDir === undefined) delete process.env.QINGAGENT_LOG_DIR;
      else process.env.QINGAGENT_LOG_DIR = oldLogsDir;
      if (oldDuckDbPath === undefined) delete process.env.OBSERVABILITY_DUCKDB_PATH;
      else process.env.OBSERVABILITY_DUCKDB_PATH = oldDuckDbPath;
    }

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("spans 采集失败，已降级为空"));
  });

  it("常驻 store 可用时复用其连接，不创建独立实例", async () => {
    const duckdbPath = path.join(tmpdir(), `diag-runtime-${crypto.randomUUID()}.duckdb`);
    const closeConnection = vi.fn();
    const connection: ObservabilityDuckDbConnection = {
      runAndReadAll: vi.fn(async () => ({ getRowObjects: () => [] })),
    };
    const getConnection = vi.fn(async () => connection);
    registerObservabilityStore(duckdbPath, {
      db: { getConnection, closeConnection },
    });

    await expect(collectSpans({
      duckdbPath,
      privacyLevel: "L2",
      sessionIds: ["s1"],
    })).resolves.toEqual([]);

    expect(getConnection).toHaveBeenCalledTimes(1);
    expect(closeConnection).toHaveBeenCalledWith(connection);
  });

  it("DuckDB 路径同样只保留勾选会话并排除已删除会话", async () => {
    const duckdbPath = path.join(tmpdir(), `diag-runtime-scope-${crypto.randomUUID()}.duckdb`);
    const closeConnection = vi.fn();
    const connection: ObservabilityDuckDbConnection = {
      runAndReadAll: vi.fn(async () => ({
        getRowObjects: () => [
          duckRow("picked", "s-picked", "勾选会话正文"),
          duckRow("deleted", "s-deleted", "已删除会话正文"),
        ],
      })),
    };
    registerObservabilityStore(duckdbPath, {
      db: { getConnection: vi.fn(async () => connection), closeConnection },
    });

    const spans = await collectSpans({
      duckdbPath,
      privacyLevel: "L2",
      sessionIds: ["s-picked"],
    });

    expect(spans.map((span) => span.sessionId)).toEqual(["s-picked"]);
    expect(JSON.stringify(spans)).toContain("勾选会话正文");
    expect(JSON.stringify(spans)).not.toContain("已删除会话正文");
    expect(closeConnection).toHaveBeenCalledWith(connection);
  });

  it("DuckDB 的 L1 保留勾选与全局结构 span，排除已删除会话", async () => {
    const duckdbPath = path.join(tmpdir(), `diag-runtime-l1-scope-${crypto.randomUUID()}.duckdb`);
    const closeConnection = vi.fn();
    const connection: ObservabilityDuckDbConnection = {
      runAndReadAll: vi.fn(async () => ({
        getRowObjects: () => [
          duckRow("picked", "s-picked", "勾选会话正文"),
          duckRow("deleted", "s-deleted", "已删除会话正文"),
          duckRow("global", null, "全局诊断载荷"),
        ],
      })),
    };
    registerObservabilityStore(duckdbPath, {
      db: { getConnection: vi.fn(async () => connection), closeConnection },
    });

    const spans = await collectSpans({
      duckdbPath,
      privacyLevel: "L1",
      sessionIds: ["s-picked"],
    });

    expect(spans.map((span) => span.sessionId)).toEqual(["s-picked", null]);
    expect(JSON.stringify(spans)).not.toContain("已删除会话正文");
    expect(spans.every((span) => span.output?.summary.startsWith("[redacted:len="))).toBe(true);
    expect(closeConnection).toHaveBeenCalledWith(connection);
  });
});

function duckRow(id: string, sessionId: string | null, output: string): Record<string, unknown> {
  return {
    traceId: `trace-${id}`,
    spanId: `span-${id}`,
    parentSpanId: null,
    name: "llm_response",
    spanType: "generic",
    startedAt: new Date(),
    endedAt: new Date(),
    sessionId,
    requestContext: null,
    attributes: null,
    metadata: null,
    input: null,
    output: JSON.stringify(output),
    error: null,
  };
}
