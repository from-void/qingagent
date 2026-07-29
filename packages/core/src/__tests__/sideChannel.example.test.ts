import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  branchCall: vi.fn(),
  getSessionSnapshot: vi.fn(),
}));

vi.mock("../llm/modelConfig.js", () => ({
  branchCall: mocks.branchCall,
  getSessionSnapshot: mocks.getSessionSnapshot,
}));

import { runSideChannel } from "../llm/sideChannel.js";

describe("runSideChannel 新站点接入模板", () => {
  beforeEach(() => {
    mocks.branchCall.mockReset();
    mocks.getSessionSnapshot.mockReset().mockReturnValue({ sessionId: "example" });
  });

  // 新站点抄这里：业务侧只需提供 callSite / steeringTail / parse / fallback 四样。
  const recommendQuery = () => runSideChannel({
    callSite: "planDraft",
    steeringTail: "不要调用工具，只输出一个推荐 query。",
    parse: (text) => text.trim() || null,
    fallback: async () => "默认推荐",
  });

  it("快照借道成功，branchCall 即自动获得缓存借道与账本记录", async () => {
    mocks.branchCall.mockResolvedValue({
      ok: true,
      text: "  城市更新案例  ",
      attempts: 1,
      toolCallRetries: 0,
    });

    await expect(recommendQuery()).resolves.toEqual({
      value: "城市更新案例",
      transport: "branch",
      branchFailure: null,
      toolCallRetries: 0,
    });
    expect(mocks.getSessionSnapshot).toHaveBeenCalledOnce();
    expect(mocks.branchCall).toHaveBeenCalledWith(expect.objectContaining({
      callSite: "planDraft",
      sessionSnapshot: { sessionId: "example" },
    }));
  });

  it("解析失败自动降级并输出统一可 grep 日志", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.branchCall.mockResolvedValue({
      ok: true,
      text: "   ",
      attempts: 1,
      toolCallRetries: 0,
    });

    await expect(recommendQuery()).resolves.toMatchObject({
      value: "默认推荐",
      transport: "fallback",
      branchFailure: "parse_failed",
    });
    expect(warn).toHaveBeenCalledWith(
      "[sideChannel] site=planDraft fallback engaged reason=parse_failed snapshot=true",
    );
    warn.mockRestore();
  });
});
