import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// writeDraft 赛马:固定一轮 4 路并发生成,字数只参与 best-of 选优;
// 4 路全废直接返回 ok:false,由 agent 重新调用 writeDraft 做工具维度重试。
// mock 内层 DeepSeek AI SDK 流式适配层:各路按调用顺序吐不同长度的稿。

vi.mock("../mastra.js", () => ({
  mastra: {
    getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    getMemory: () => null,
  },
  getObservability: () => null,
}));

const streamInnerModelMock = vi.fn();
vi.mock("../llm/innerModelStream.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    streamInnerModel: (...args: unknown[]) => streamInnerModelMock(...args),
  };
});

function qingmlParagraph(text: string): string {
  return `<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`;
}

function mockGenerateReturning(...payloads: string[]) {
  for (const p of payloads) {
    streamInnerModelMock.mockImplementationOnce(async () => ({ raw: p, contentStartMs: 0, finishReason: "stop" }));
  }
}

type InnerModelCall = {
  abortSignal?: AbortSignal;
  onContentStart?: () => void;
  onContentDelta?: (delta: string, raw: string) => void;
};

function mockGenerateReturningDelayed(...payloads: Array<{ raw: string; delayMs: number; streamRaw?: boolean }>) {
  for (const payload of payloads) {
    streamInnerModelMock.mockImplementationOnce((input: InnerModelCall) =>
      new Promise((resolve, reject) => {
        if (payload.streamRaw) {
          input.onContentStart?.();
          input.onContentDelta?.(payload.raw, payload.raw);
        }
        const timer = setTimeout(() => {
          input.abortSignal?.removeEventListener("abort", onAbort);
          resolve({ raw: payload.raw, contentStartMs: 0, finishReason: "stop" });
        }, payload.delayMs);
        const onAbort = () => {
          clearTimeout(timer);
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        input.abortSignal?.addEventListener("abort", onAbort, { once: true });
      }),
    );
  }
}

async function makeTool() {
  const { createWriteDraftTool } = await import("../tools/writeDraft.js");
  const { createSession } = await import("../bridge/index.js");
  const state = createSession("wd-length");
  const tool = createWriteDraftTool({
    state,
    replaceDraftCandidateDoc: (s, doc, legacySections) => {
      s.docDraftCandidateDoc = doc;
      return legacySections ?? [];
    },
  });
  return { tool, state };
}

type ExecuteResult = {
  ok: boolean;
  wordCount?: number;
  firstVisibleCharCount?: number;
  revisionCount?: number;
  lengthStatus?: string;
};

async function run(tool: unknown, input: Record<string, unknown>): Promise<ExecuteResult> {
  const t = tool as { execute: (input: never, ctx?: never) => Promise<unknown> };
  return (await t.execute(input as never, undefined as never)) as ExecuteResult;
}

async function runWithContext(tool: unknown, input: Record<string, unknown>, ctx: Record<string, unknown>): Promise<ExecuteResult> {
  const t = tool as { execute: (input: never, ctx?: never) => Promise<unknown> };
  return (await t.execute(input as never, ctx as never)) as ExecuteResult;
}

function progressEvents(writes: Array<Record<string, unknown>>) {
  return writes
    .filter((w) => w.type === "writedraft-progress")
    .map((w) => w.progress as { phase: string; charCount: number; excerpt?: string | null });
}

describe("writeDraft 赛马式字数控制", () => {
  beforeEach(() => {
    streamInnerModelMock.mockReset();
    delete process.env.QINGAGENT_RACE_LANES;
    delete process.env.QINGAGENT_RACE_ROUNDS;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("带字数:固定一轮 4 路并发,选离验收区间最近且达标的一路", async () => {
    const { tool, state } = await makeTool();
    // 目标 100(±10% → 90-110):两路分别 200/95,第二路达标
    mockGenerateReturning(
      qingmlParagraph("a".repeat(200)),
      qingmlParagraph("b".repeat(95)),
      qingmlParagraph("c".repeat(140)),
      qingmlParagraph("d".repeat(160)),
    );

    const out = await run(tool, { title: "t", outline: "o", lengthTarget: 100 });

    expect(out.ok).toBe(true);
    expect(out.wordCount).toBe(95);
    expect(out.revisionCount).toBe(0);
    expect(out.lengthStatus).toBe("accepted_first_pass");
    expect(streamInnerModelMock).toHaveBeenCalledTimes(4);
    const { pmToPlainText } = await import("@qingagent/pm-schema");
    expect(pmToPlainText(state.docDraftCandidateDoc!).startsWith("b")).toBe(true);
  }, 10_000);

  it("最快候选未达标时不截停慢一点的达标候选", async () => {
    const { tool } = await makeTool();
    mockGenerateReturningDelayed(
      { raw: qingmlParagraph("a".repeat(200)), delayMs: 0 },
      { raw: qingmlParagraph("b".repeat(100)), delayMs: 25 },
      { raw: qingmlParagraph("c".repeat(95)), delayMs: 500 },
      { raw: qingmlParagraph("d".repeat(80)), delayMs: 500 },
    );

    const out = await run(tool, { title: "t", outline: "o", lengthTarget: 100 });

    expect(out.ok).toBe(true);
    expect(out.wordCount).toBe(100);
    expect(out.lengthStatus).toBe("accepted_first_pass");
    expect(streamInnerModelMock).toHaveBeenCalledTimes(4);
  }, 10_000);

  it("min bound 首轮全合格:count>=min 即接受,不启动第二轮", async () => {
    const { tool } = await makeTool();
    mockGenerateReturning(
      qingmlParagraph("a".repeat(120)),
      qingmlParagraph("b".repeat(125)),
      qingmlParagraph("c".repeat(140)),
      qingmlParagraph("d".repeat(160)),
    );

    const out = await run(tool, { title: "t", outline: "o", lengthTarget: 100, lengthBound: "min" });

    expect(out.ok).toBe(true);
    expect(out.wordCount).toBeGreaterThanOrEqual(100);
    expect(out.revisionCount).toBe(0);
    expect(out.lengthStatus).toBe("accepted_first_pass");
    expect(streamInnerModelMock).toHaveBeenCalledTimes(4);
  });

  it("一轮 4 路中有命中:不加赛,标 accepted_first_pass", async () => {
    const { tool } = await makeTool();
    mockGenerateReturning(
      qingmlParagraph("a".repeat(200)),
      qingmlParagraph("b".repeat(250)),
      qingmlParagraph("e".repeat(100)),
      qingmlParagraph("f".repeat(400)),
    );

    const out = await run(tool, { title: "t", outline: "o", lengthTarget: 100 });

    expect(out.wordCount).toBe(100);
    expect(out.firstVisibleCharCount).toBe(100);
    expect(out.revisionCount).toBe(0);
    expect(out.lengthStatus).toBe("accepted_first_pass");
    expect(streamInnerModelMock).toHaveBeenCalledTimes(4);
  });

  it("一轮 4 路全脱靶:不再加赛,如实吐出全场最近者并标硬上限失败", async () => {
    const { tool } = await makeTool();
    // 4 路全脱靶,全场最近 = 150
    mockGenerateReturning(
      ...["a", "b"].map((ch) => qingmlParagraph(ch.repeat(300))),
      ...["e", "f"].map((ch, i) => qingmlParagraph(ch.repeat(i === 0 ? 150 : 280))),
    );

    const out = await run(tool, { title: "t", outline: "o", lengthTarget: 100 });

    expect(out.wordCount).toBe(150); // best-of:未达标但最逼近
    expect(out.lengthStatus).toBe("above_hard_max");
    expect(streamInnerModelMock).toHaveBeenCalledTimes(4);
  });

  it("不带字数:也固定一轮 4 路,取首个可用候选", async () => {
    const { tool } = await makeTool();
    mockGenerateReturning(
      qingmlParagraph("随便写".repeat(50)),
      qingmlParagraph("第二路"),
      qingmlParagraph("第三路"),
      qingmlParagraph("第四路"),
    );

    const out = await run(tool, { title: "t", outline: "o" });

    expect(out.ok).toBe(true);
    expect(out.lengthStatus).toBe("not_requested");
    expect(out.revisionCount).toBeUndefined();
    expect(streamInnerModelMock).toHaveBeenCalledTimes(4);
  });

  it("赛马路数锁死 4:env 不再改变 lane 数", async () => {
    process.env.QINGAGENT_RACE_LANES = "2";
    process.env.QINGAGENT_RACE_ROUNDS = "1";
    const { tool } = await makeTool();
    mockGenerateReturning(
      qingmlParagraph("a".repeat(200)),
      qingmlParagraph("b".repeat(95)),
      qingmlParagraph("c".repeat(180)),
      qingmlParagraph("d".repeat(170)),
    );

    const out = await run(tool, { title: "t", outline: "o", lengthTarget: 100 });

    expect(out.wordCount).toBe(95);
    expect(streamInnerModelMock).toHaveBeenCalledTimes(4);
  });

  it("赛马全路解析失败:不串行兜底,快速返回 ok:false、发 failed 进度帧并提示重调 writeDraft", async () => {
    const { tool } = await makeTool();
    // 4 路全吐坏 QingML → 不再串行补救。
    mockGenerateReturning(
      ...Array.from({ length: 4 }, () => "<pre>text<p>block</p></pre>"),
    );
    const writes: Array<Record<string, unknown>> = [];
    const ctx = { writer: { write: (chunk: Record<string, unknown>) => void writes.push(chunk) } };

    const out = await runWithContext(tool, { title: "t", outline: "o", lengthTarget: 100 }, ctx);

    expect(out.ok).toBe(false);
    expect((out as { error?: string }).error).toContain("重新调用 writeDraft");
    expect(streamInnerModelMock).toHaveBeenCalledTimes(4);
    expect(progressEvents(writes).at(-1)).toMatchObject({ phase: "failed" });
  });

  it("流式展示粘滞:首个吐正文的 lane 获得展示权,其它 lane 字数反超也不切", async () => {
    const { tool } = await makeTool();
    mockGenerateReturningDelayed(
      { raw: qingmlParagraph("a".repeat(40)), delayMs: 40, streamRaw: true },
      { raw: qingmlParagraph("b".repeat(180)), delayMs: 45, streamRaw: true },
      { raw: qingmlParagraph("c".repeat(100)), delayMs: 60, streamRaw: true },
      { raw: qingmlParagraph("d".repeat(80)), delayMs: 80, streamRaw: true },
    );
    const writes: Array<Record<string, unknown>> = [];
    const ctx = { writer: { write: (chunk: Record<string, unknown>) => void writes.push(chunk) } };

    const out = await runWithContext(tool, { title: "t", outline: "o", lengthTarget: 100 }, ctx);

    expect(out.ok).toBe(true);
    const events = progressEvents(writes);
    const writingCounts = events.filter((e) => e.phase === "writing").map((e) => e.charCount);
    expect(writingCounts).toContain(40);
    expect(writingCounts).not.toContain(180);
    expect(events.at(-1)).toMatchObject({ phase: "finalizing", charCount: 100 });
    expect(events.at(-1)?.excerpt).toContain("c".repeat(20));
  });

  it("流式展示初选只认首个正文 lane,不被先注册的空 lane 锁住", async () => {
    const { tool } = await makeTool();
    streamInnerModelMock
      .mockImplementationOnce((input: InnerModelCall) =>
        new Promise((resolve, reject) => {
          const raw = qingmlParagraph("a".repeat(100));
          const timer = setTimeout(() => resolve({ raw, contentStartMs: 0, finishReason: "stop" }), 80);
          const onAbort = () => {
            clearTimeout(timer);
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          };
          input.abortSignal?.addEventListener("abort", onAbort, { once: true });
        }),
      )
      .mockImplementationOnce((input: InnerModelCall) =>
        new Promise((resolve) => {
          const raw = qingmlParagraph("b".repeat(90));
          input.onContentStart?.();
          input.onContentDelta?.(raw, raw);
          setTimeout(() => resolve({ raw, contentStartMs: 0, finishReason: "stop" }), 20);
        }),
      )
      .mockImplementationOnce((input: InnerModelCall) =>
        new Promise((resolve) => {
          const raw = qingmlParagraph("c".repeat(80));
          input.onContentStart?.();
          input.onContentDelta?.(raw, raw);
          setTimeout(() => resolve({ raw, contentStartMs: 0, finishReason: "stop" }), 40);
        }),
      )
      .mockImplementationOnce((input: InnerModelCall) =>
        new Promise((resolve) => {
          const raw = qingmlParagraph("d".repeat(70));
          input.onContentStart?.();
          input.onContentDelta?.(raw, raw);
          setTimeout(() => resolve({ raw, contentStartMs: 0, finishReason: "stop" }), 60);
        }),
      );
    const writes: Array<Record<string, unknown>> = [];
    const ctx = { writer: { write: (chunk: Record<string, unknown>) => void writes.push(chunk) } };

    const out = await runWithContext(tool, { title: "t", outline: "o", lengthTarget: 100 }, ctx);

    expect(out.ok).toBe(true);
    const events = progressEvents(writes);
    const writingEvents = events.filter((e) => e.phase === "writing");
    expect(writingEvents.some((e) => e.charCount === 90 && e.excerpt?.includes("b".repeat(20)))).toBe(true);
    expect(writingEvents.every((e) => e.charCount === 0 || e.excerpt?.includes("b".repeat(20)))).toBe(true);
  });

  it("展示 lane 死亡后切到存活 lane 中当前字数最多者", async () => {
    const { tool } = await makeTool();
    streamInnerModelMock
      .mockImplementationOnce((input: InnerModelCall) => {
        const raw = qingmlParagraph("a".repeat(40));
        input.onContentStart?.();
        input.onContentDelta?.(raw, raw);
        return new Promise((_resolve, reject) => setTimeout(() => reject(new Error("stream broke")), 20));
      })
      .mockImplementationOnce((input: InnerModelCall) => {
        const raw = qingmlParagraph("b".repeat(80));
        input.onContentStart?.();
        input.onContentDelta?.(raw, raw);
        return new Promise((resolve) => setTimeout(() => resolve({ raw, contentStartMs: 0, finishReason: "stop" }), 80));
      })
      .mockImplementationOnce((input: InnerModelCall) => {
        const raw = qingmlParagraph("c".repeat(100));
        return new Promise((resolve) => setTimeout(() => {
          input.onContentStart?.();
          input.onContentDelta?.(raw, raw);
          resolve({ raw, contentStartMs: 0, finishReason: "stop" });
        }, 120));
      })
      .mockImplementationOnce((input: InnerModelCall) => {
        const raw = qingmlParagraph("d".repeat(60));
        input.onContentStart?.();
        input.onContentDelta?.(raw, raw);
        return new Promise((resolve) => setTimeout(() => resolve({ raw, contentStartMs: 0, finishReason: "stop" }), 120));
      });
    const writes: Array<Record<string, unknown>> = [];
    const ctx = { writer: { write: (chunk: Record<string, unknown>) => void writes.push(chunk) } };

    const out = await runWithContext(tool, { title: "t", outline: "o", lengthTarget: 100 }, ctx);

    expect(out.ok).toBe(true);
    const events = progressEvents(writes);
    expect(events.filter((e) => e.phase === "writing").map((e) => e.charCount)).toEqual(
      expect.arrayContaining([40, 80]),
    );
    expect(events.at(-1)).toMatchObject({ phase: "finalizing", charCount: 100 });
  });

  it("正文 delta 进度按 200ms 或新增 24 字节流", async () => {
    vi.useFakeTimers();
    const { tool } = await makeTool();
    streamInnerModelMock.mockImplementation((input: InnerModelCall) =>
      new Promise((resolve) => {
        input.onContentStart?.();
        const raw10 = qingmlParagraph("a".repeat(10));
        input.onContentDelta?.(raw10, raw10);
        const raw20 = qingmlParagraph("a".repeat(20));
        input.onContentDelta?.(raw20, raw20);
        const raw35 = qingmlParagraph("a".repeat(35));
        input.onContentDelta?.(raw35, raw35);
        setTimeout(() => resolve({ raw: qingmlParagraph("a".repeat(100)), contentStartMs: 0, finishReason: "stop" }), 10);
      }),
    );
    const writes: Array<Record<string, unknown>> = [];
    const ctx = { writer: { write: (chunk: Record<string, unknown>) => void writes.push(chunk) } };

    const pending = runWithContext(tool, { title: "t", outline: "o", lengthTarget: 100 }, ctx);
    await vi.advanceTimersByTimeAsync(20);
    await pending;

    const writingCounts = progressEvents(writes)
      .filter((e) => e.phase === "writing")
      .map((e) => e.charCount);
    expect(writingCounts).toContain(10);
    expect(writingCounts).not.toContain(20);
    expect(writingCounts).toContain(35);
  });

  it("express 写稿期间发送工具心跳,避免 idle watchdog 误杀", async () => {
    vi.useFakeTimers();
    const { tool } = await makeTool();
    mockGenerateReturningDelayed(
      { raw: qingmlParagraph("a".repeat(100)), delayMs: 11_000 },
      { raw: qingmlParagraph("b".repeat(90)), delayMs: 11_000 },
      { raw: qingmlParagraph("c".repeat(95)), delayMs: 11_000 },
      { raw: qingmlParagraph("d".repeat(80)), delayMs: 11_000 },
    );
    const writes: Array<Record<string, unknown>> = [];
    const ctx = { writer: { write: (chunk: Record<string, unknown>) => void writes.push(chunk) } };
    const t = tool as unknown as { execute: (input: never, ctx?: never) => Promise<unknown> };

    const promise = t.execute({ title: "t", outline: "o", lengthTarget: 100 } as never, ctx as never);
    await vi.advanceTimersByTimeAsync(10_100);

    expect(writes.some((w) => w.type === "tool-heartbeat" && w.tool === "writeDraft")).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(promise).resolves.toMatchObject({ ok: true });
  });
});
