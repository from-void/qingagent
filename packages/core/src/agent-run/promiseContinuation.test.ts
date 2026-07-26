import { describe, expect, it } from "vitest";
import {
  PROMISE_CONTINUATION_LIMIT,
  shouldContinuePromisedAction,
} from "./promiseContinuation.js";

function candidate(overrides: Partial<Parameters<typeof shouldContinuePromisedAction>[0]> = {}) {
  return {
    finishReason: "stop",
    sawToolCall: false,
    streamWasUserAborted: false,
    finalText: "你说得对。让我先查一下当前衍生稿的配置，然后重新改。",
    continuationCount: 0,
    ...overrides,
  };
}

describe("shouldContinuePromisedAction", () => {
  it.each([
    "让我先查一下当前配置。",
    "接下来我会重新修改标题",
    "我这就去搜索相关资料。",
    "我马上去看当前稿件！",
  ])("命中承诺式收尾并触发续推：%s", (finalText) => {
    expect(shouldContinuePromisedAction(candidate({ finalText }))).toBe(true);
  });

  it.each([
    candidate({ finalText: "需要你提供衍生稿链接，我才能继续。" }),
    candidate({ finishReason: "length" }),
    candidate({ sawToolCall: true }),
    candidate({ streamWasUserAborted: true }),
  ])("普通收尾、非 stop、已有工具或用户中止时不触发", (input) => {
    expect(shouldContinuePromisedAction(input)).toBe(false);
  });

  it("每条用户消息最多续推一次", () => {
    expect(
      shouldContinuePromisedAction(
        candidate({ continuationCount: PROMISE_CONTINUATION_LIMIT }),
      ),
    ).toBe(false);
  });
});
