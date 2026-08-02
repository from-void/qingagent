import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FAKE_TOOL_EXECUTION_WARN_SIGNATURE,
  ToolTranscriptOutputGuard,
} from "../toolTranscriptOutputGuard.js";

const REPROCESS_PART_KEY = "__mastraReprocessPart";

function textPart(text: string) {
  return {
    type: "text-delta" as const,
    payload: { id: "text-1", text },
    runId: "run-1",
  };
}

function finishPart() {
  return {
    type: "finish" as const,
    payload: { finishReason: "stop" },
    runId: "run-1",
  };
}

async function processParts(
  guard: ToolTranscriptOutputGuard,
  state: Record<string, unknown>,
  parts: Array<ReturnType<typeof textPart> | ReturnType<typeof finishPart>>,
): Promise<string> {
  const queue = [...parts];
  let visible = "";
  while (queue.length > 0) {
    const part = queue.shift()!;
    const output = await guard.processOutputStream({
      part,
      state,
      streamParts: [],
      retryCount: 0,
      abort: (reason?: string): never => {
        throw new Error(reason ?? "aborted");
      },
    } as never);
    if (output?.type === "text-delta") visible += output.payload.text;
    const reprocessPart = state[REPROCESS_PART_KEY];
    if (reprocessPart) {
      delete state[REPROCESS_PART_KEY];
      queue.unshift(reprocessPart as ReturnType<typeof finishPart>);
    }
  }
  return visible;
}

const fakeTranscript = [
  "[tool-result]",
  "toolName: readDraft",
  "toolCallId: call-read-1",
  'args: {"mode":"full"}',
  'result: {"docVersion":9}',
].join("\n");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ToolTranscriptOutputGuard", () => {
  it("跨 delta 拦截精确工具回放块及其后的假完成文案", async () => {
    const guard = new ToolTranscriptOutputGuard();
    const state: Record<string, unknown> = {};
    const visible = await processParts(guard, state, [
      textPart("[tool-"),
      textPart(fakeTranscript.slice("[tool-".length)),
      textPart("\n已经按要求修改完成。"),
      finishPart(),
    ]);

    expect(visible).toBe("");
    expect(JSON.stringify(state)).not.toContain("docVersion");
  });

  it("放行正常讨论及不符合完整回放格式的标记文本", async () => {
    const guard = new ToolTranscriptOutputGuard();
    const state: Record<string, unknown> = {};
    const normal = [
      "代码里的 [tool-result] 只是标记，不代表工具真的执行。",
      "\n[tool-result]\n这里只是在讨论格式。",
      "\n[tool-result]\n\ntoolName: readDraft\ntoolCallId: example\nargs: {}\nresult: {}",
    ].join("");

    const visible = await processParts(guard, state, [
      textPart(normal.slice(0, 18)),
      textPart(normal.slice(18)),
      finishPart(),
    ]);

    expect(visible).toBe(normal);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const abort = vi.fn((): never => {
      throw new Error("should not retry");
    });
    expect(() => guard.processOutputStep({
      state,
      text: "如何判断文档是否已修改完成？代码里的 [tool-result] 又是什么？",
      toolCalls: [],
      retryCount: 0,
      stepNumber: 0,
      messages: [],
      abort,
    } as never)).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
  });

  it("零真实工具调用时记录稳定 WARN 签名并让该 attempt 重试一次", async () => {
    const guard = new ToolTranscriptOutputGuard();
    const state: Record<string, unknown> = {};
    await processParts(guard, state, [textPart(fakeTranscript), finishPart()]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const abort = vi.fn((): never => {
      throw new Error("processor retry");
    });

    expect(() => guard.processOutputStep({
      state,
      text: fakeTranscript,
      toolCalls: [],
      retryCount: 0,
      stepNumber: 0,
      messages: [],
      abort,
    } as never)).toThrow("processor retry");
    expect(warn).toHaveBeenCalledWith(
      `[${FAKE_TOOL_EXECUTION_WARN_SIGNATURE}]`,
      expect.objectContaining({
        signature: FAKE_TOOL_EXECUTION_WARN_SIGNATURE,
        stepNumber: 0,
        retryCount: 0,
        actualToolCallCount: 0,
      }),
    );
    expect(abort).toHaveBeenCalledWith(
      expect.stringContaining("实际调用"),
      {
        retry: true,
        metadata: { signature: FAKE_TOOL_EXECUTION_WARN_SIGNATURE },
      },
    );
  });

  it("没有回放块但谎称文档修改完成时也按零工具假执行告警", () => {
    const guard = new ToolTranscriptOutputGuard();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const abort = vi.fn((): never => {
      throw new Error("processor retry");
    });

    expect(() => guard.processOutputStep({
      state: {},
      text: "已经按你的要求把第一段修改完成，其他内容未动。",
      toolCalls: [],
      retryCount: 0,
      stepNumber: 0,
      messages: [],
      abort,
    } as never)).toThrow("processor retry");
    expect(warn).toHaveBeenCalledWith(
      `[${FAKE_TOOL_EXECUTION_WARN_SIGNATURE}]`,
      expect.objectContaining({
        signature: FAKE_TOOL_EXECUTION_WARN_SIGNATURE,
        evidence: "completion_claim",
        actualToolCallCount: 0,
      }),
    );
  });

  it("重试额度耗尽后不循环重试，存在真实工具调用时不报假执行", async () => {
    const guard = new ToolTranscriptOutputGuard();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const exhaustedState: Record<string, unknown> = {};
    await processParts(guard, exhaustedState, [textPart(fakeTranscript), finishPart()]);
    const exhaustedAbort = vi.fn((): never => {
      throw new Error("should not retry");
    });

    expect(() => guard.processOutputStep({
      state: exhaustedState,
      text: fakeTranscript,
      toolCalls: [],
      retryCount: 1,
      stepNumber: 0,
      messages: [],
      abort: exhaustedAbort,
    } as never)).not.toThrow();
    expect(exhaustedAbort).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockClear();
    const realToolState: Record<string, unknown> = {};
    await guard.processOutputStream({
      part: {
        type: "tool-call",
        payload: {
          toolName: "editDraft",
          toolCallId: "real-call-1",
          args: {},
        },
      },
      state: realToolState,
      streamParts: [],
      retryCount: 0,
      abort: exhaustedAbort,
    } as never);
    await processParts(guard, realToolState, [textPart(fakeTranscript), finishPart()]);

    expect(() => guard.processOutputStep({
      state: realToolState,
      text: fakeTranscript,
      toolCalls: [{
        toolName: "editDraft",
        toolCallId: "real-call-1",
        args: {},
      }],
      retryCount: 0,
      stepNumber: 1,
      messages: [],
      abort: exhaustedAbort,
    } as never)).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
    expect(exhaustedAbort).not.toHaveBeenCalled();
  });
});
