import { beforeEach, describe, expect, it, vi } from "vitest";
import { legacySectionsToPm } from "@qingagent/pm-schema";
import { RequestContext } from "@mastra/core/request-context";
import { createSession } from "../session/sessionState.js";

const mocks = vi.hoisted(() => ({
  branchCall: vi.fn(),
  getSessionSnapshot: vi.fn(),
}));

vi.mock("../llm/modelConfig.js", () => ({
  branchCall: mocks.branchCall,
  getSessionSnapshot: mocks.getSessionSnapshot,
}));

import {
  buildTitleSource,
  generateTitleAfterFirstDraft,
  normalizeGeneratedTitle,
} from "../session/titleGeneration.js";

function draftedState(id: string) {
  const state = createSession(id);
  state.legacySections = [
    { id: "h1", kind: "h1", data: { text: "旧 H1 标题" } },
    { id: "p1", kind: "p", data: { text: "正文讨论城市更新中的公共空间与社区参与。" } },
  ] as never;
  state.doc = legacySectionsToPm(state.legacySections as never);
  return state;
}

describe("首稿后 BranchCall 标题", () => {
  beforeEach(() => {
    mocks.branchCall.mockReset();
    mocks.getSessionSnapshot.mockReset().mockReturnValue({ sessionId: "s" });
  });

  it("只在首次调用生成并清洗标题，第二次重写不再起题", async () => {
    mocks.branchCall.mockResolvedValueOnce({
      ok: true,
      text: "《城市更新：公共空间与社区共治》。\n解释",
      attempts: 1,
      toolCallRetries: 0,
    });
    const state = draftedState("title-once");

    await expect(generateTitleAfterFirstDraft(state)).resolves.toBe("城市更新：公共空间与社区共治");
    await expect(generateTitleAfterFirstDraft(state)).resolves.toBeNull();

    expect(state.branchTitleGenerated).toBe(true);
    expect(mocks.branchCall).toHaveBeenCalledTimes(1);
    expect(mocks.branchCall).toHaveBeenCalledWith(expect.objectContaining({
      callSite: "generateTitle",
      maxTokens: 96,
      steeringTail: expect.stringContaining("正文讨论城市更新"),
    }));
  });

  it("快照不可用时降级文档 H1，正文落地不受影响", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.getSessionSnapshot.mockReturnValue(null);
    const state = draftedState("title-fallback");

    await expect(generateTitleAfterFirstDraft(state)).resolves.toBe("旧 H1 标题");
    expect(mocks.branchCall).not.toHaveBeenCalled();
    expect(state.branchTitleGenerated).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      "[sideChannel] site=generateTitle fallback engaged reason=snapshot_unavailable snapshot=false",
    );
    warn.mockRestore();
  });

  it("标题清洗去掉 Markdown、书名号与句号，并限制长度", () => {
    expect(normalizeGeneratedTitle("## 《一个标题》。\n说明")).toBe("一个标题");
    expect(normalizeGeneratedTitle("  ")).toBeNull();
    expect(normalizeGeneratedTitle("长".repeat(80))).toHaveLength(48);
  });

  it("用户已手动指定标题时首稿起题让路且不结算 once 标记", async () => {
    const state = draftedState("title-pinned");
    state.title = "我的标题";
    state.titlePinned = true;

    await expect(generateTitleAfterFirstDraft(state)).resolves.toBeNull();
    expect(state.title).toBe("我的标题");
    expect(state.branchTitleGenerated).toBe(false);
    expect(mocks.branchCall).not.toHaveBeenCalled();
  });

  it("当前 turn 取消时丢弃迟到标题且不结算 once 标记", async () => {
    const controller = new AbortController();
    let resolveBranch!: (value: unknown) => void;
    mocks.branchCall.mockReturnValueOnce(new Promise((resolve) => { resolveBranch = resolve; }));
    const state = draftedState("title-abort");
    const requestContext = new RequestContext([
      ["abortSignal", controller.signal],
    ] as never) as RequestContext;
    const pending = generateTitleAfterFirstDraft(state, requestContext);
    controller.abort();
    resolveBranch({ ok: true, text: "迟到标题", attempts: 1, toolCallRetries: 0 });

    await expect(pending).resolves.toBeNull();
    expect(state.branchTitleGenerated).toBe(false);
  });
});

describe("buildTitleSource 输入压缩", () => {
  it("优先给大纲 + 开头引子，不再灌全文", () => {
    const doc = {
      type: "doc" as const,
      content: [
        { type: "heading" as const, attrs: { level: 1 as const }, content: [{ type: "text" as const, text: "城市更新总纲" }] },
        { type: "paragraph" as const, attrs: {}, content: [{ type: "text" as const, text: "开篇交代背景。" }] },
        { type: "heading" as const, attrs: { level: 2 as const }, content: [{ type: "text" as const, text: "公共空间" }] },
        // 正文很长,但只应被算进「开头」预算,不该整篇进去
        { type: "paragraph" as const, attrs: {}, content: [{ type: "text" as const, text: "尾".repeat(4000) }] },
      ],
    };
    const source = buildTitleSource(doc as never);

    expect(source).toContain("# 城市更新总纲");
    expect(source).toContain("## 公共空间");
    expect(source).toContain("开篇交代背景。");
    // 关键:总长受预算约束,不是原来的 12000
    expect(source.length).toBeLessThanOrEqual(1_600);
  });

  it("纯图表文档退回带媒体口径 —— 否则 skipMedia 下拿到空串,只能瞎猜标题", () => {
    const doc = {
      type: "doc" as const,
      content: [
        { type: "diagram" as const, attrs: { source: "graph TD; 采集-->处理-->归档" } },
      ],
    };
    const source = buildTitleSource(doc as never);

    expect(source).toContain("采集");
    expect(source).not.toBe("");
  });

  it("空文档给空串，交给调用方走 H1 兜底、不浪费模型请求", () => {
    expect(buildTitleSource({ type: "doc", content: [] } as never)).toBe("");
  });
});
