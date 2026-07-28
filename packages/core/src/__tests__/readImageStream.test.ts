import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";

// 回归:readImage 早期用 result.textStream 迭代,上游 API 报错(限流 1305 / 鉴权)时
// textStream 静默结束、不抛 → 把错误当成"空文本的成功"返回 ok:true。改用 fullStream
// 显式处理 error part,并对空文本兜底 ok:false。本测试锁死这三条行为。

const streamTextMock = vi.hoisted(() => vi.fn());
const getVisionModelMock = vi.hoisted(() => vi.fn());
const resolveImageInputMock = vi.hoisted(() => vi.fn());

vi.mock("ai", () => ({ streamText: streamTextMock }));
vi.mock("../llm/modelConfig.js", () => ({ getVisionModel: getVisionModelMock }));
// 注意:mock 路径必须是 readImage.ts 实际 import 的模块(src/tools/imageInput.js),
// 即从本测试文件(src/__tests__/)算的 ../tools/imageInput.js,不能写成 ./imageInput.js。
vi.mock("../tools/imageInput.js", async (importActual) => {
  const actual = await importActual<typeof import("../tools/imageInput.js")>();
  return { ...actual, resolveImageInput: resolveImageInputMock };
});

const { readImageTool } = await import("../tools/readImage.js");

type Part =
  | { type: "text-delta"; textDelta: string }
  | { type: "finish"; finishReason: string }
  | { type: "error"; error: unknown };

function fullStream(parts: Part[]): AsyncIterable<Part> {
  return (async function* () {
    for (const p of parts) yield p;
  })();
}

function visionText(text: string): { fullStream: AsyncIterable<Part> } {
  return {
    fullStream: fullStream([
      { type: "text-delta", textDelta: text },
      { type: "finish", finishReason: "stop" },
    ]),
  };
}

function rateLimitError(message = "too many requests"): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 429 });
}

interface ReadImageResult {
  ok: boolean;
  text: string;
  error: string | null;
  materialId: string | null;
}

async function run(
  image = "00000000-0000-4000-8000-000000000abc",
  context: unknown = {},
  prompt = "描述图片",
  includeConversation: boolean | null | undefined = false,
): Promise<ReadImageResult> {
  return (await readImageTool.execute!(
    { image, prompt, includeConversation },
    context as never,
  )) as ReadImageResult;
}

/** 构造带素材库的 requestContext(materials 是 Map,见 runAgentTurn RequestContext)。 */
function contextWithMaterials(map: Map<string, unknown>): unknown {
  return { requestContext: { get: (k: string) => (k === "materials" ? map : undefined) } };
}

describe("readImage stream error handling", () => {
  let modelSeq = 0;

  beforeEach(() => {
    streamTextMock.mockReset();
    getVisionModelMock.mockReset();
    resolveImageInputMock.mockReset();
    getVisionModelMock.mockResolvedValue({ modelId: `vision-test-${++modelSeq}` });
    resolveImageInputMock.mockResolvedValue({ buffer: Buffer.from([0x89, 0x50]), mimeType: "image/png" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("有文本时返回 ok:true 与识别结果", async () => {
    streamTextMock.mockReturnValue({
      fullStream: fullStream([
        { type: "text-delta", textDelta: "这是一张" },
        { type: "text-delta", textDelta: "测试图片。" },
        { type: "finish", finishReason: "stop" },
      ]),
    });
    const r = await run();
    expect(r).toEqual({ ok: true, text: "这是一张测试图片。", error: null, materialId: null });
  });

  it("上游 error part(限流)不再被吞成成功,返回 ok:false 且带原因", async () => {
    streamTextMock.mockReturnValue({
      fullStream: fullStream([
        { type: "error", error: new Error("该模型当前访问量过大，请您稍后再试") },
      ]),
    });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.text).toBe("");
    expect(r.error).toContain("访问量过大");
  });

  it("只有 finish、无 text-delta(空输出)返回 ok:false 并给用户提示", async () => {
    streamTextMock.mockReturnValue({
      fullStream: fullStream([{ type: "finish", finishReason: "length" }]),
    });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.text).toBe("");
    expect(r.error).toContain("没有返回结果");
  });

  it("素材区图片(materialId)→ 折算成该素材的 fileId 再解析", async () => {
    streamTextMock.mockReturnValue({
      fullStream: fullStream([
        { type: "text-delta", textDelta: "素材里的图" },
        { type: "finish", finishReason: "stop" },
      ]),
    });
    const materials = new Map<string, unknown>([
      ["mat-1", { id: "mat-1", filename: "photo.png", mimeType: "image/png", fileId: "11111111-1111-4111-8111-111111111111" }],
    ]);
    const r = await run("mat-1", contextWithMaterials(materials));
    expect(r.ok).toBe(true);
    expect(r.materialId).toBe("mat-1");
    // resolveImageInput 应收到素材的 fileId,而不是 materialId
    expect(resolveImageInputMock).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
  });

  it("非图片素材(如 PDF)→ ok:false 且不去解析", async () => {
    const materials = new Map<string, unknown>([
      ["mat-pdf", { id: "mat-pdf", filename: "report.pdf", mimeType: "application/pdf", fileId: "x" }],
    ]);
    const r = await run("mat-pdf", contextWithMaterials(materials));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("不是图片");
    expect(resolveImageInputMock).not.toHaveBeenCalled();
  });

  it("流式 text-delta 经 writer 推 readimage-progress 进度(带 excerpt)", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const writer = { write: (c: Record<string, unknown>) => void writes.push(c) };
    streamTextMock.mockReturnValue({
      fullStream: fullStream([
        { type: "text-delta", textDelta: "这是" },
        { type: "text-delta", textDelta: "一幅古建筑图。" },
        { type: "finish", finishReason: "stop" },
      ]),
    });
    const r = (await readImageTool.execute!(
      { image: "00000000-0000-4000-8000-000000000abc", prompt: "描述", includeConversation: false },
      { writer } as never,
    )) as ReadImageResult;
    expect(r.ok).toBe(true);
    const progress = writes.filter((w) => w.type === "readimage-progress");
    expect(progress.length).toBeGreaterThan(0);
    expect(
      progress.some((p) => {
        const ex = (p.progress as { excerpt?: unknown } | undefined)?.excerpt;
        return typeof ex === "string" && ex.includes("这是");
      }),
    ).toBe(true);
  });

  it("readimage-progress 写入返回 rejected Promise 时不冒 unhandled rejection", async () => {
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);
    const write = vi.fn(() => Promise.reject(new Error("async writer boom")));
    streamTextMock.mockReturnValue(visionText("识别成功"));

    try {
      const result = await run("img-rejected-writer", { writer: { write } });
      expect(result.ok).toBe(true);
      expect(write).toHaveBeenCalledWith(expect.objectContaining({
        type: "readimage-progress",
      }));

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("素材无原始文件(fileId 为空)→ ok:false", async () => {
    const materials = new Map<string, unknown>([
      ["mat-scrape", { id: "mat-scrape", filename: "网页", mimeType: "image/png", fileId: null }],
    ]);
    const r = await run("mat-scrape", contextWithMaterials(materials));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("没有可识别的原始图片");
    expect(resolveImageInputMock).not.toHaveBeenCalled();
  });

  it("首调 429 → 等待 20s 后重试一次并成功", async () => {
    vi.useFakeTimers();
    streamTextMock
      .mockReturnValueOnce({ fullStream: fullStream([{ type: "error", error: rateLimitError() }]) })
      .mockReturnValueOnce(visionText("重试成功"));

    const pending = run("img-rate-limit-once");
    await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(20_000);
    const r = await pending;

    expect(r).toEqual({ ok: true, text: "重试成功", error: null, materialId: null });
    expect(streamTextMock).toHaveBeenCalledTimes(2);
  });

  it("两调均 429 → 返回限流文案且只调用 2 次", async () => {
    vi.useFakeTimers();
    streamTextMock
      .mockReturnValueOnce({ fullStream: fullStream([{ type: "error", error: rateLimitError("1305 rate limit") }]) })
      .mockReturnValueOnce({ fullStream: fullStream([{ type: "error", error: rateLimitError("当前使用人数过多") }]) });

    const pending = run("img-rate-limit-twice");
    await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(20_000);
    const r = await pending;

    expect(r.ok).toBe(false);
    expect(r.text).toBe("");
    expect(r.error).toBe(
      "图像识别模型限流(免费档常见)。已自动重试仍未成功;请等待至少 30 秒后再调 readImage,期间先继续其他写作步骤,不要立即重试。",
    );
    expect(streamTextMock).toHaveBeenCalledTimes(2);
  });

  it("首调 429 后重试遇到鉴权错误时返回鉴权提示而非伪装成限流", async () => {
    vi.useFakeTimers();
    streamTextMock
      .mockReturnValueOnce({ fullStream: fullStream([{ type: "error", error: rateLimitError() }]) })
      .mockReturnValueOnce({
        fullStream: fullStream([{
          type: "error",
          error: Object.assign(new Error("upstream unauthorized: invalid api key"), {
            statusCode: 401,
          }),
        }]),
      });

    const pending = run("img-rate-limit-then-auth");
    await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(20_000);
    const r = await pending;

    expect(r).toEqual({
      ok: false,
      text: "",
      error: "图像识别模型鉴权失败，请检查模型配置。",
      materialId: null,
    });
    expect(r.error).not.toContain("限流");
    expect(r.error).not.toContain("upstream");
    expect(streamTextMock).toHaveBeenCalledTimes(2);
  });

  it("非限流错误 → 不重试", async () => {
    streamTextMock.mockReturnValue({
      fullStream: fullStream([{ type: "error", error: new Error("模型鉴权失败") }]),
    });
    const r = await run("img-non-rate-limit");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("模型鉴权失败");
    expect(streamTextMock).toHaveBeenCalledTimes(1);
  });

  it("最外层捕获遇到父取消时重抛原始 reason，不吞成 ok:false", async () => {
    const controller = new AbortController();
    const reason = new DOMException("用户取消识图", "AbortError");
    controller.abort(reason);
    resolveImageInputMock.mockImplementation((_image: string, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      throw new Error("should not reach");
    });

    await expect(
      run("img-parent-aborted", { abortSignal: controller.signal }),
    ).rejects.toBe(reason);
  });

  it("限流等待期间强制 emitProgress 写入保活提示", async () => {
    vi.useFakeTimers();
    const writes: Array<Record<string, unknown>> = [];
    const writer = { write: (c: Record<string, unknown>) => void writes.push(c) };
    streamTextMock
      .mockReturnValueOnce({ fullStream: fullStream([{ type: "error", error: rateLimitError() }]) })
      .mockReturnValueOnce(visionText("重试后结果"));

    const pending = run("img-rate-limit-progress", { writer });
    await vi.waitFor(() =>
      expect(
        writes.some((w) => {
          const excerpt = (w.progress as { excerpt?: unknown } | undefined)?.excerpt;
          return typeof excerpt === "string" && excerpt.includes("等待 20 秒后自动重试");
        }),
      ).toBe(true),
    );
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;
  });

  it("同图同 prompt 二次调用命中缓存,streamText 只触发一次", async () => {
    streamTextMock.mockReturnValue(visionText("缓存结果"));

    const first = await run("img-cache-same", {}, "同一问题");
    const second = await run("img-cache-same", {}, "同一问题");

    expect(first).toEqual({ ok: true, text: "缓存结果", error: null, materialId: null });
    expect(second).toEqual(first);
    expect(streamTextMock).toHaveBeenCalledTimes(1);
  });

  it("素材输入命中缓存时仍返回同一 materialId", async () => {
    streamTextMock.mockReturnValue(visionText("素材缓存结果"));
    const materials = new Map<string, unknown>([
      ["mat-cache", { id: "mat-cache", filename: "cache.png", mimeType: "image/png", fileId: "22222222-2222-4222-8222-222222222222" }],
    ]);
    const context = contextWithMaterials(materials);

    const first = await run("mat-cache", context, "同一问题");
    const second = await run("mat-cache", context, "同一问题");

    expect(first).toEqual({ ok: true, text: "素材缓存结果", error: null, materialId: "mat-cache" });
    expect(second).toEqual(first);
    expect(streamTextMock).toHaveBeenCalledTimes(1);
  });

  it("同图不同 prompt → 不命中缓存", async () => {
    streamTextMock.mockReturnValueOnce(visionText("问题一")).mockReturnValueOnce(visionText("问题二"));

    const first = await run("img-cache-different-prompt", {}, "问题一");
    const second = await run("img-cache-different-prompt", {}, "问题二");

    expect(first.text).toBe("问题一");
    expect(second.text).toBe("问题二");
    expect(streamTextMock).toHaveBeenCalledTimes(2);
  });

  it("includeConversation:true 不读写缓存", async () => {
    streamTextMock.mockReturnValueOnce(visionText("上下文结果一")).mockReturnValueOnce(visionText("上下文结果二"));

    const first = await run("img-cache-with-context", {}, "同一问题", true);
    const second = await run("img-cache-with-context", {}, "同一问题", true);

    expect(first.text).toBe("上下文结果一");
    expect(second.text).toBe("上下文结果二");
    expect(streamTextMock).toHaveBeenCalledTimes(2);
  });

  it("第 51 个缓存键逐出最旧项", async () => {
    streamTextMock.mockImplementation(() => visionText(`结果 ${streamTextMock.mock.calls.length}`));

    for (let i = 0; i < 51; i += 1) {
      await run("img-cache-evict", {}, `问题 ${i}`);
    }
    expect(streamTextMock).toHaveBeenCalledTimes(51);

    const again = await run("img-cache-evict", {}, "问题 0");
    expect(again.text).toBe("结果 52");
    expect(streamTextMock).toHaveBeenCalledTimes(52);
  });
});
