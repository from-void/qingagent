import { RequestContext } from "@mastra/core/request-context";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionState } from "../session/sessionState.js";

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
}));

vi.mock("ai-v5", async (importOriginal) => ({
  ...await importOriginal<typeof import("ai-v5")>(),
  generateText: mocks.generateText,
}));

vi.mock("../llm/modelConfig.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../llm/modelConfig.js")>(),
  getDeepseekModel: vi.fn(() => ({})),
  resolveModelParams: vi.fn(() => ({})),
}));

import {
  buildDraftTemplateSteeringTail,
  draftTemplate,
  parseDraftTemplate,
} from "../session/draftTemplate.js";

const reviewScene = { kind: "review", type: "role", label: "角色审查" } as const;

describe("draftTemplate 旁支站点", () => {
  beforeEach(() => {
    mocks.generateText.mockReset();
  });

  it("表单有内容时原样表达名称主题与提示词续写意图", () => {
    const tail = buildDraftTemplateSteeringTail(reviewScene, {
      name: "投资人挑刺",
      prompt: "重点检查商业闭环",
    });
    expect(tail).toContain("名称原文：\"投资人挑刺\"");
    expect(tail).toContain("提示词原文：\"重点检查商业闭环\"");
    expect(tail).toContain("已有草稿");
  });

  it("表单全空时只要求从主链当前文档与对话推断，不重复拼正文", () => {
    const tail = buildDraftTemplateSteeringTail(reviewScene, { name: "  ", prompt: "" });
    expect(tail).toContain("根据当前文档内容与此前对话推断");
    expect(tail).not.toContain("当前文档纯文本");
  });

  it("容忍围栏、前导/尾随散文及字符串内括号，并拒绝截断 JSON", () => {
    expect(parseDraftTemplate("好的：\n```json\n{\"name\":\"风控审查\",\"prompt\":\"逐项检查 ] 与 }，最后给建议\"}\n```\n完成。"))
      .toEqual({ name: "风控审查", prompt: "逐项检查 ] 与 }，最后给建议" });
    expect(parseDraftTemplate('{"name":"风控审查","prompt":"未闭合"')).toBeNull();
  });

  it("无可用快照时触发独立 generateText fallback 并解析结果", async () => {
    mocks.generateText.mockResolvedValue({
      text: '{"name":"投资人审查","prompt":"以投资人立场逐项检查市场、壁垒与回报，并按问题—证据—建议格式输出。"}',
    });
    const requestContext = new RequestContext([["sessionId", "draft-template-no-snapshot"]] as never);
    const result = await draftTemplate({ doc: null } as unknown as SessionState, {
      scene: reviewScene,
      intent: { name: "", prompt: "" },
    }, requestContext);
    expect(result.name).toBe("投资人审查");
    expect(mocks.generateText).toHaveBeenCalledOnce();
    expect(mocks.generateText.mock.calls[0]?.[0]).toMatchObject({
      maxOutputTokens: 800,
      maxRetries: 0,
      toolChoice: "none",
    });
  });

  it("已取消时不进入 fallback", async () => {
    const controller = new AbortController();
    controller.abort();
    const requestContext = new RequestContext([
      ["sessionId", "draft-template-aborted"],
      ["abortSignal", controller.signal],
    ] as never);
    await expect(draftTemplate({ doc: null } as unknown as SessionState, {
      scene: reviewScene,
      intent: { name: "", prompt: "" },
    }, requestContext)).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.generateText).not.toHaveBeenCalled();
  });
});
