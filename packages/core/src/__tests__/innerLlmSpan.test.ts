import { describe, expect, it, vi } from "vitest";

const observabilityMocks = vi.hoisted(() => ({
  startSpan: vi.fn(),
  end: vi.fn(),
}));

vi.mock("../observability/runtime.js", () => ({
  getObservability: () => ({
    getDefaultInstance: () => ({
      startSpan: observabilityMocks.startSpan.mockReturnValue({ end: observabilityMocks.end }),
    }),
  }),
}));

import { startInnerLlmSpan } from "../observability/innerLlmSpan.js";

describe("innerLlmSpan 失败输出脱敏", () => {
  it("不持久化 outputText，仅保留字符数与结构诊断", () => {
    observabilityMocks.startSpan.mockClear();
    observabilityMocks.end.mockClear();
    const span = startInnerLlmSpan({
      name: "inner_llm:writeDraft",
      sessionId: "abcdef12-3456-7890-abcd-ef1234567890",
      toolName: "writeDraft",
      modelName: "deepseek-v4-flash",
      system: "system",
      user: "user",
      attempt: 1,
      maxAttempts: 4,
    });

    const rawOutput = "不得进入 span 的敏感正文";
    span.end({
      ok: false,
      outputText: rawOutput,
      error: "unsupported-nested-table",
      diagnostic: {
        failureKind: "unsupported-nested-table",
        warningKinds: ["unsupported-nested-table"],
        tagSkeleton: "<table><tr><td><table></table></td></tr></table>",
        errorLocations: [{ kind: "unsupported-nested-table", startOffset: 11 }],
      },
    });

    expect(observabilityMocks.end).toHaveBeenCalledTimes(1);
    const ended = observabilityMocks.end.mock.calls[0]![0];
    expect(ended.output).toMatchObject({
      ok: false,
      outputCharCount: rawOutput.length,
      diagnostic: {
        failureKind: "unsupported-nested-table",
        tagSkeleton: expect.stringContaining("<table>"),
      },
    });
    expect(JSON.stringify(ended)).not.toContain(rawOutput);
  });
});
