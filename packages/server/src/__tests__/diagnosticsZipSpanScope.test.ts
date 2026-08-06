import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiagSpan } from "@qingagent/contract-ts";

const bridgeMocks = vi.hoisted(() => ({
  sessionManager: {
    frameLog: { readFrom: vi.fn(() => ({ frames: [], epoch: 1 })) },
    listSessionIds: vi.fn(() => []),
  },
  collectRestoreFrames: vi.fn(async () => []),
}));

vi.mock("../gateway/bridgeHandler.js", () => bridgeMocks);
vi.mock("../diagnostics/snapshot.js", () => ({
  collectEnvSnapshot: vi.fn(() => ({})),
  collectSettingsSnapshot: vi.fn(async () => ({})),
}));

import { buildDiagnosticsZip } from "../diagnostics/exporter";

describe("diagnostics zip span scope", () => {
  const dirs: string[] = [];
  const savedLogsDir = process.env.QINGAGENT_LOG_DIR;
  const savedRuntime = process.env.QINGAGENT_RUNTIME;

  afterEach(async () => {
    if (savedLogsDir === undefined) delete process.env.QINGAGENT_LOG_DIR;
    else process.env.QINGAGENT_LOG_DIR = savedLogsDir;
    if (savedRuntime === undefined) delete process.env.QINGAGENT_RUNTIME;
    else process.env.QINGAGENT_RUNTIME = savedRuntime;
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("勾选一份文档后 spans.jsonl 只含该会话", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "diag-zip-scope-"));
    dirs.push(dir);
    process.env.QINGAGENT_LOG_DIR = dir;
    process.env.QINGAGENT_RUNTIME = "desktop";
    const day = new Date().toISOString().slice(0, 10);
    await writeFile(
      path.join(dir, `spans-${day}.jsonl`),
      `${[
        makeSpan("s-picked", "勾选文档正文"),
        makeSpan("s-unpicked", "未勾选文档正文"),
        makeSpan("s-deleted", "已删除稿件正文 手机号13800138000 银行卡6222021234567890123"),
      ].map((span) => JSON.stringify(span)).join("\n")}\n`,
      "utf8",
    );

    const result = await buildDiagnosticsZip({ privacyLevel: "L2", sessionIds: ["s-picked"] });
    const zip = await JSZip.loadAsync(result.buffer);
    const spansJsonl = await zip.file("spans.jsonl")!.async("string");
    const spans = spansJsonl.trim().split("\n").map((line) => JSON.parse(line) as DiagSpan);

    expect(spans.map((span) => span.sessionId)).toEqual(["s-picked"]);
    expect(spansJsonl).toContain("勾选文档正文");
    expect(spansJsonl).not.toContain("未勾选文档正文");
    expect(spansJsonl).not.toContain("已删除稿件正文");
  });
});

function makeSpan(sessionId: string, summary: string): DiagSpan {
  const now = Date.now();
  return {
    key: `trace-${sessionId}::llm_response::generic::1`,
    traceId: `trace-${sessionId}`,
    parentKey: null,
    sessionId,
    clientTraceId: null,
    layer: "model",
    name: "llm_response",
    spanType: "generic",
    startedAt: now,
    endedAt: now + 10,
    durMs: 10,
    status: "ok",
    input: { summary: `问题：${summary}`, bytes: summary.length, truncated: false },
    output: { summary, bytes: summary.length, truncated: false },
    error: null,
    meta: {},
  };
}
