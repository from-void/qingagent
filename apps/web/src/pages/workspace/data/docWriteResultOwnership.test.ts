import { describe, expect, it } from "vitest";
import { shouldHandleDocWriteResult } from "./docWriteResultOwnership";

describe("shouldHandleDocWriteResult", () => {
  it("忽略外标签广播的成功/冲突回执，不推进本标签旧正文的版本基线", () => {
    expect(shouldHandleDocWriteResult({
      isLatestOwnMutation: false,
      hasMatchingWaiter: false,
    })).toBe(false);
  });

  it("本标签匹配 latest mutation 或 waiter 时消费回执", () => {
    expect(shouldHandleDocWriteResult({
      isLatestOwnMutation: true,
      hasMatchingWaiter: false,
    })).toBe(true);
    expect(shouldHandleDocWriteResult({
      isLatestOwnMutation: false,
      hasMatchingWaiter: true,
    })).toBe(true);
  });
});
