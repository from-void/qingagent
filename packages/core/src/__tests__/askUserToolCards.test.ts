import { describe, expect, it } from "vitest";
import {
  askUserRenderModeFromSpec,
  buildAskUserToolCallSpec,
} from "../agent-run/toolCards.js";

const questions = [{
  id: "q1",
  header: "语气",
  label: "你偏好的语气？",
  kind: "single" as const,
  options: [
    { value: "formal", label: "正式", description: null, preview: null },
    { value: "casual", label: "轻松", description: null, preview: null },
  ],
  placeholder: null,
}];

describe("buildAskUserToolCallSpec", () => {
  it("保留 direct 工具名、overlay 渲染和 header，purpose 缺省为 null", () => {
    const spec = buildAskUserToolCallSpec({
      toolCallId: "direct-1",
      toolName: "askUserQuestion",
      renderMode: "overlay",
      questions,
    });
    expect(spec.name).toBe("askUserQuestion");
    expect(spec.render).toEqual({ kind: "rightOverlay" });
    expect(spec.body).toEqual({
      kind: "askUser",
      data: {
        id: "direct-1",
        mode: { kind: "overlay" },
        purpose: null,
        source: null,
        rationale: null,
        questions: [{
          ...questions[0],
          kind: { kind: "single" },
        }],
      },
    });
  });

  it("planDraft 固定为 fullpage 且保留可选 purpose", () => {
    const spec = buildAskUserToolCallSpec({
      toolCallId: "plan-1",
      toolName: "planDraft",
      renderMode: "fullpage",
      purpose: "directionChange",
      questions,
    });
    expect(spec.name).toBe("planDraft");
    expect(spec.render).toEqual({ kind: "rightForm" });
    expect(spec.body.kind === "askUser" && spec.body.data.purpose).toEqual({ kind: "directionChange" });
  });

  it("脏恢复 spec 缺 mode 时 helper 不抛错并返回 null", () => {
    const spec = buildAskUserToolCallSpec({
      toolCallId: "legacy-1",
      toolName: "askUser",
      renderMode: "fullpage",
      questions,
    });
    if (spec.body.kind === "askUser") {
      delete (spec.body.data as unknown as { mode?: unknown }).mode;
    }
    expect(askUserRenderModeFromSpec(spec)).toBeNull();
  });
});
