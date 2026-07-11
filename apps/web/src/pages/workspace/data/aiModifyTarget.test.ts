import { describe, expect, it, vi } from "vitest";
import { runAiModifyTarget, type AiModifyTarget } from "./aiModifyTarget";

const textTarget: AiModifyTarget = {
  label: "正文",
  suffix: "批注",
  blockId: "p-1",
  from: 1,
  to: 3,
};

function deps(overrides: Partial<Parameters<typeof runAiModifyTarget>[0]> = {}) {
  return {
    target: textTarget,
    getBlockReason: () => null,
    isTextRangeAllowed: () => true,
    flushPendingDocSave: vi.fn(async () => undefined),
    insertChip: vi.fn(() => true),
    onToast: vi.fn(),
    onSaveFailure: vi.fn(),
    ...overrides,
  };
}

describe("runAiModifyTarget", () => {
  it("前置门控失败时不保存也不插 chip", async () => {
    const input = deps({ getBlockReason: () => ({ toast: "请先完成问卷" }) });
    await expect(runAiModifyTarget(input)).resolves.toBe(false);
    expect(input.flushPendingDocSave).not.toHaveBeenCalled();
    expect(input.insertChip).not.toHaveBeenCalled();
    expect(input.onToast).toHaveBeenCalledWith("请先完成问卷");
  });

  it("保存后复查最新门控，状态变化时拒绝插入", async () => {
    let reason: { toast: string } | null = null;
    const input = deps({
      getBlockReason: () => reason,
      flushPendingDocSave: vi.fn(async () => {
        reason = { toast: "请先提交或撤销上方修改，再继续对话" };
      }),
    });
    await expect(runAiModifyTarget(input)).resolves.toBe(false);
    expect(input.insertChip).not.toHaveBeenCalled();
    expect(input.onToast).toHaveBeenCalledWith("请先提交或撤销上方修改，再继续对话");
  });

  it("表格范围跳过单文本块校验，且 insertChip 成功才返回 true", async () => {
    const tableSelection = { axis: "row" as const, startIndex: 0, endIndex: 1, signature: "fnv1a-1" };
    const input = deps({
      target: { label: "甲 | 乙", suffix: "表格·第1–2行", blockId: "table-1", tableSelection },
      isTextRangeAllowed: vi.fn(() => false),
    });
    await expect(runAiModifyTarget(input)).resolves.toBe(true);
    expect(input.isTextRangeAllowed).not.toHaveBeenCalled();
    expect(input.insertChip).toHaveBeenCalledWith(expect.objectContaining({ tableSelection }));

    vi.mocked(input.insertChip).mockReturnValue(false);
    await expect(runAiModifyTarget(input)).resolves.toBe(false);
  });

  it("落盘失败提示并返回 false", async () => {
    const failure = new Error("save failed");
    const input = deps({ flushPendingDocSave: vi.fn(async () => { throw failure; }) });
    await expect(runAiModifyTarget(input)).resolves.toBe(false);
    expect(input.onSaveFailure).toHaveBeenCalledWith(failure);
    expect(input.insertChip).not.toHaveBeenCalled();
  });
});
