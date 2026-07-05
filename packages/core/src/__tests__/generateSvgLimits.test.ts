import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GENERATE_SVG_MAX_OUTPUT_TOKENS,
  GENERATE_SVG_RAW_MAX_BYTES,
  SVG_IDLE_TIMEOUT_MS,
  generateSvgTool,
} from "../tools/generateSvg.js";

const callDeepseekDraftMock = vi.hoisted(() => vi.fn());
const mkdirMock = vi.hoisted(() => vi.fn());
const writeFileMock = vi.hoisted(() => vi.fn());

vi.mock("../tools/deepseekDraftClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/deepseekDraftClient.js")>();
  return { ...actual, callDeepseekDraft: (...args: unknown[]) => callDeepseekDraftMock(...args) };
});

vi.mock("node:fs/promises", () => ({
  mkdir: mkdirMock,
  writeFile: writeFileMock,
}));

interface GenerateSvgResult {
  ok: boolean;
  error: string | null;
  svg: string;
}

async function executeGenerateSvg(
  description: string,
  context?: Parameters<NonNullable<typeof generateSvgTool.execute>>[1],
): Promise<GenerateSvgResult> {
  return await generateSvgTool.execute!({
    description,
    style: null,
    aspect: "16:9",
  }, context as never) as GenerateSvgResult;
}

function progressWriter() {
  const writes: Array<Record<string, unknown>> = [];
  return {
    writes,
    context: {
      writer: {
        write: vi.fn((chunk: Record<string, unknown>) => {
          writes.push(chunk);
        }),
      },
    },
  };
}

describe("generateSvg direct DeepSeek path", () => {
  beforeEach(() => {
    vi.useRealTimers();
    callDeepseekDraftMock.mockReset();
    mkdirMock.mockReset();
    writeFileMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("通过 callDeepseekDraft 关闭 thinking,禁用工具层重试,并保持 16k maxTokens", async () => {
    const { writes, context } = progressWriter();
    callDeepseekDraftMock.mockImplementationOnce(async (input) => {
      input.onContentStart?.(3);
      input.onContentDelta?.(
        `<svg><rect width="10" height="10" fill="#ff0000"/></svg>`,
        `<svg><rect width="10" height="10" fill="#ff0000"/></svg>`,
      );
      return {
        raw: `<svg><rect width="10" height="10" fill="#ff0000"/></svg>`,
        contentStartMs: 3,
      };
    });

    const result = await executeGenerateSvg("红色方块", context as never);

    expect(result.ok).toBe(true);
    expect(callDeepseekDraftMock).toHaveBeenCalledTimes(1);
    expect(callDeepseekDraftMock.mock.calls[0]![0]).toMatchObject({
      thinking: false,
      stream: true,
      maxRetries: 0,
      maxTokens: GENERATE_SVG_MAX_OUTPUT_TOKENS,
    });
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    expect(writes.some((w) => w.type === "generatesvg-progress")).toBe(true);
    expect(writes.map((w) => (w.progress as { stage?: string } | undefined)?.stage)).toEqual(
      expect.arrayContaining(["starting", "streaming", "sanitizing", "done"]),
    );
  });

  it("把调用方 maxOutputTokens 上限夹到 generateSvg 的 16k,不砍默认输出预算", async () => {
    callDeepseekDraftMock.mockResolvedValueOnce({
      raw: `<svg><rect width="10" height="10" fill="#00ff00"/></svg>`,
      contentStartMs: 0,
    });
    const requestContext = {
      get: (key: string) => key === "modelOverrides"
        ? { params: { maxOutputTokens: GENERATE_SVG_MAX_OUTPUT_TOKENS + 1 } }
        : undefined,
    };

    await executeGenerateSvg("绿色方块", { requestContext } as never);

    expect(callDeepseekDraftMock.mock.calls[0]![0].maxTokens).toBe(GENERATE_SVG_MAX_OUTPUT_TOKENS);
  });

  it("长时间无输出(空闲超时)后返回中文失败文案,不暴露裸 abort 错误", async () => {
    vi.useFakeTimers();
    callDeepseekDraftMock.mockImplementationOnce((input) =>
      new Promise((_resolve, reject) => {
        input.abortSignal?.addEventListener("abort", () => {
          reject(input.abortSignal.reason ?? new DOMException("This operation was aborted", "AbortError"));
        });
      }),
    );

    const pending = executeGenerateSvg("复杂海报");
    // 全程没有 onContentDelta(无输出)→ 空闲看门狗到点掐断。
    await vi.advanceTimersByTimeAsync(SVG_IDLE_TIMEOUT_MS + 1);
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.error).toContain("长时间无响应已停止");
    expect(result.error).not.toContain("This operation was aborted");
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("持续吐字时空闲看门狗被重置,不会在 idle 阈值处误杀正在画的大图", async () => {
    vi.useFakeTimers();
    callDeepseekDraftMock.mockImplementationOnce(async (input) => {
      // 每隔 idle 阈值的一半吐一段,累计远超 idle 阈值仍不应被掐。
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(SVG_IDLE_TIMEOUT_MS / 2);
        input.onContentDelta?.(
          `<rect x="${i}" y="0" width="10" height="10" fill="#111111"/>`,
          `<svg><rect x="${i}" y="0" width="10" height="10" fill="#111111"/></svg>`,
        );
      }
      return {
        raw: `<svg><rect width="10" height="10" fill="#111111"/></svg>`,
        contentStartMs: 1,
      };
    });

    const result = await executeGenerateSvg("一直在画的大图");

    expect(result.ok).toBe(true);
    expect(writeFileMock).toHaveBeenCalledTimes(1);
  });

  it("抽取 markdown fence 内 SVG 并消毒脚本和事件属性", async () => {
    callDeepseekDraftMock.mockResolvedValueOnce({
      raw: [
        "前导说明",
        "```svg",
        `<svg><script>alert(1)</script><rect width="10" height="10" fill="#00ff00" onclick="evil()"/></svg>`,
        "```",
        "收尾散文",
      ].join("\n"),
      contentStartMs: 0,
    });

    const result = await executeGenerateSvg("脏 SVG");

    expect(result.ok).toBe(true);
    expect(result.svg).toContain("<rect");
    expect(result.svg).not.toContain("<script");
    expect(result.svg).not.toContain("onclick");
    expect(writeFileMock).toHaveBeenCalledTimes(1);
  });

  it("空 SVG 或消毒后无可见内容时失败,不写文件", async () => {
    callDeepseekDraftMock.mockResolvedValueOnce({
      raw: `<svg><script>alert(1)</script></svg>`,
      contentStartMs: 0,
    });

    const result = await executeGenerateSvg("空图");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("没有可见内容");
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("流式输出超过原始字节上限时中止并失败", async () => {
    callDeepseekDraftMock.mockImplementationOnce(async (input) => {
      input.onContentDelta?.("a".repeat(GENERATE_SVG_RAW_MAX_BYTES + 1), "");
      return { raw: "", contentStartMs: 0 };
    });

    const result = await executeGenerateSvg("超大输出");

    expect(result.ok).toBe(false);
    expect(result.error).toContain(`${GENERATE_SVG_RAW_MAX_BYTES} 字节上限`);
    expect(writeFileMock).not.toHaveBeenCalled();
  });
});
