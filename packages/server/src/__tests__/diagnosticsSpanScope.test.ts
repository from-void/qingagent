import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DiagSpan } from "@qingagent/contract-ts";
import { collectSpans } from "../diagnostics/collect";

function makeSpan(sessionId: string, summary: string): DiagSpan {
  const traceId = `trace-${sessionId}`;
  return {
    key: `${traceId}::llm_response::generic::1`,
    traceId,
    parentKey: null,
    sessionId,
    clientTraceId: null,
    layer: "model",
    name: "llm_response",
    spanType: "generic",
    startedAt: Date.now(),
    endedAt: Date.now() + 10,
    durMs: 10,
    status: "ok",
    input: { summary: `问题：${summary}`, bytes: summary.length, truncated: false },
    output: { summary, bytes: summary.length, truncated: false },
    error: null,
    meta: {},
  };
}

describe("diagnostics L2 span scope", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("只导出勾选会话，未勾选及已删除会话的 span 正文不进包", async () => {
    const picked = makeSpan("s-picked", "勾选文档正文");
    const unpicked = makeSpan("s-unpicked", "未勾选文档正文");
    const deleted = makeSpan("s-deleted", "已删除稿件正文 手机号13800138000 银行卡6222021234567890123");
    const { dir } = await writeSpans([picked, unpicked, deleted]);
    dirs.push(dir);

    const spans = await collectSpans({
      logsDir: dir,
      privacyLevel: "L2",
      sessionIds: ["s-picked", "", "s-picked"],
    });

    expect(spans.map((span) => span.sessionId)).toEqual(["s-picked"]);
    const text = JSON.stringify(spans);
    expect(text).toContain("勾选文档正文");
    expect(text).not.toContain("未勾选文档正文");
    expect(text).not.toContain("已删除稿件正文");
    expect(text).not.toContain("13800138000");
    expect(text).not.toContain("6222021234567890123");
  });

  it("L2 未勾选任何会话时不导出 span", async () => {
    const { dir } = await writeSpans([makeSpan("s-existing", "不应无范围导出的正文")]);
    dirs.push(dir);

    await expect(collectSpans({ logsDir: dir, privacyLevel: "L2" })).resolves.toEqual([]);
    await expect(collectSpans({ logsDir: dir, privacyLevel: "L2", sessionIds: [] })).resolves.toEqual([]);
    await expect(collectSpans({ logsDir: dir, privacyLevel: "L2", sessionIds: [""] })).resolves.toEqual([]);
  });
});

async function writeSpans(spans: DiagSpan[]): Promise<{ dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "diag-span-scope-"));
  const day = new Date().toISOString().slice(0, 10);
  await writeFile(
    path.join(dir, `spans-${day}.jsonl`),
    `${spans.map((span) => JSON.stringify(span)).join("\n")}\n`,
    "utf8",
  );
  return { dir };
}
