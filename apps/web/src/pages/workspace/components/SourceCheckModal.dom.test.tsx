import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSourceCheckQuery,
  DEFAULT_SOURCE_CHECK_INSTRUCTION,
  SourceCheckModal,
} from "./SourceCheckModal";

describe("SourceCheckModal", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    host.id = "view-workspace";
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("加载并保存独立常驻指令，同时提交本次补充要求", async () => {
    const loadInstruction = vi.fn().mockResolvedValue("数字逐字核对");
    const saveInstruction = vi.fn().mockResolvedValue(undefined);
    const onConfirm = vi.fn();
    await act(async () => root.render(
      <SourceCheckModal open loadInstruction={loadInstruction} saveInstruction={saveInstruction} onClose={vi.fn()} onConfirm={onConfirm} />,
    ));
    expect(host.querySelectorAll("textarea")).toHaveLength(2);
    const [instruction, supplement] = [...host.querySelectorAll<HTMLTextAreaElement>("textarea")];
    expect(instruction?.value).toBe("数字逐字核对");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(instruction, "金额和日期逐字核对");
      instruction?.dispatchEvent(new Event("input", { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(supplement, "重点看月活");
      supplement?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => host.querySelector<HTMLButtonElement>(".ws-lexicon-actions button:last-child")?.click());
    expect(saveInstruction).toHaveBeenCalledWith("金额和日期逐字核对");
    expect(onConfirm).toHaveBeenCalledWith("金额和日期逐字核对", "重点看月活");
  });

  it("没有已存指令时预填可编辑的默认核查要求", async () => {
    await act(async () => root.render(
      <SourceCheckModal
        open
        loadInstruction={vi.fn().mockResolvedValue("  ")}
        saveInstruction={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    ));

    const instruction = host.querySelector<HTMLTextAreaElement>(".ws-lexicon-instruction textarea");
    expect(instruction?.value).toBe(DEFAULT_SOURCE_CHECK_INSTRUCTION);
    expect(instruction?.value).toContain("时间与日期先后");
    expect(instruction?.value).toContain("素材中查不到依据的断言标记为无据");
  });

  it("生成显式白名单 query 并拼接常驻指令", () => {
    const query = buildSourceCheckQuery("只看数值", "核对月活");
    expect(query).toContain("对当前文档做来源核查");
    expect(query).toContain("仅以当前会话素材为依据");
    expect(query).toContain("来源审查指令（用户长期偏好，必须遵守）：只看数值");
    expect(query).toContain("本次补充要求：核对月活");
  });
});
