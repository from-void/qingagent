import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DiagSpan } from "@qingagent/contract-ts";
import { applyL1SpanPrivacy, collectSpans } from "../diagnostics/collect";

// 回归:round-trip 实测发现 L1 包 spans.jsonl 的 input/output summary 残留
// 生成正文(模型回答/用户消息),违反 PRD F1 验收「L1 无文档正文/对话内容」。
// L1 必须把截断原文置换为 [redacted:len=N],只留长度;L2 保留截断摘要。

function makeSpan(overrides: Partial<DiagSpan> = {}): DiagSpan {
  return {
    key: "trace123::llm_response::generic::1",
    traceId: "trace1234567890",
    parentKey: null,
    sessionId: "s1",
    clientTraceId: null,
    layer: "model",
    name: "llm_response",
    spanType: "generic",
    startedAt: Date.now(),
    endedAt: Date.now(),
    durMs: 10,
    status: "ok",
    input: { summary: "请介绍宋代山水画的特点", bytes: 33, truncated: false },
    output: { summary: "宋代山水画讲究气韵生动……", bytes: 4096, truncated: true, usage: { totalTokens: 42 } },
    error: null,
    meta: {},
    ...overrides,
  };
}

describe("diagnostics L1 span privacy", () => {
  it("applyL1SpanPrivacy 置换 input/output 正文为占位并保留长度/usage", () => {
    const redacted = applyL1SpanPrivacy(makeSpan());
    expect(redacted.input?.summary).toBe("[redacted:len=33]");
    expect(redacted.output?.summary).toBe("[redacted:len=4096]");
    expect(redacted.output?.bytes).toBe(4096);
    expect(redacted.output?.truncated).toBe(true);
    expect(redacted.output?.usage).toEqual({ totalTokens: 42 });
    const text = JSON.stringify(redacted);
    expect(text).not.toContain("山水");
  });

  it("collectSpans L1 无正文、L2 保留截断摘要(jsonl 路径四象限)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "diag-priv-"));
    const day = new Date().toISOString().slice(0, 10);
    await writeFile(
      path.join(dir, `spans-${day}.jsonl`),
      `${JSON.stringify(makeSpan())}\n`,
      "utf8",
    );

    const l1 = await collectSpans({ logsDir: dir, privacyLevel: "L1" });
    expect(l1).toHaveLength(1);
    expect(JSON.stringify(l1)).not.toContain("山水");
    expect(l1[0]?.output?.summary).toMatch(/^\[redacted:len=\d+\]$/);

    const l2 = await collectSpans({ logsDir: dir, privacyLevel: "L2" });
    expect(l2).toHaveLength(1);
    expect(l2[0]?.output?.summary).toContain("山水");
  });
});
