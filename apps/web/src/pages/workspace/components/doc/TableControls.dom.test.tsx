import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TableControls } from "./TableControls";

let root: Root | null = null;

interface MockEditorChain {
  focus: () => MockEditorChain;
  setTextSelection: () => MockEditorChain;
  run: () => boolean;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function setupTable(options: { blockId?: string; merged?: boolean } = {}) {
  const portal = document.createElement("div");
  portal.id = "view-workspace";
  const host = document.createElement("div");
  portal.appendChild(host);
  const table = document.createElement("table");
  if (options.blockId !== undefined) table.dataset.blockId = options.blockId;
  table.innerHTML = "<tbody><tr><td>A1</td><td>B1</td></tr><tr><td>A2</td><td>B2</td></tr></tbody>";
  if (options.merged) table.rows[0]!.cells[0]!.colSpan = 2;
  portal.appendChild(table);
  document.body.appendChild(portal);

  const chain: MockEditorChain = {
    focus: vi.fn(() => chain),
    setTextSelection: vi.fn(() => chain),
    run: vi.fn(() => true),
  };
  const editor = {
    isEditable: true,
    isActive: vi.fn(() => true),
    state: { selection: { anchor: 1 } },
    view: {
      dom: portal,
      domAtPos: vi.fn(() => ({ node: table.rows[0]!.cells[0] })),
      posAtDOM: vi.fn(() => 1),
    },
    on: vi.fn(),
    off: vi.fn(),
    chain: vi.fn(() => chain),
  } as unknown as Editor;
  root = createRoot(host);
  return { editor, portal };
}

async function selectFirstRow(portal: HTMLElement): Promise<void> {
  const rowHeader = portal.querySelector<HTMLElement>(".tbl-row-hdr");
  if (!rowHeader) throw new Error("row header not found");
  await act(async () => {
    rowHeader.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
}

describe("TableControls AI 修改", () => {
  it("回调 false 保留高亮，只有 true 才清除选区", async () => {
    const { editor, portal } = setupTable({ blockId: "table-1" });
    const onAiModify = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    await act(async () => {
      root!.render(<TableControls editor={editor} onAiModify={onAiModify} />);
    });
    await selectFirstRow(portal);

    const firstButton = portal.querySelector<HTMLButtonElement>(".dt-ai");
    if (!firstButton) throw new Error("AI button not found");
    await act(async () => { firstButton.click(); });
    expect(portal.querySelector(".tbl-row-hdr.active")).not.toBeNull();
    expect(onAiModify).toHaveBeenLastCalledWith(expect.objectContaining({
      blockId: "table-1",
      label: "A1 | B1",
      suffix: "表格·第1行",
      tableSelection: expect.objectContaining({ axis: "row", startIndex: 0, endIndex: 0 }),
    }));

    const secondButton = portal.querySelector<HTMLButtonElement>(".dt-ai");
    if (!secondButton) throw new Error("AI button not found after failed callback");
    await act(async () => { secondButton.click(); });
    expect(portal.querySelector(".tbl-row-hdr.active")).toBeNull();
    expect(portal.querySelector(".dt-ai")).toBeNull();
  });

  it("合并表 AI 按钮禁用并显示延期提示", async () => {
    const { editor, portal } = setupTable({ blockId: "table-1", merged: true });
    const onAiModify = vi.fn(async () => true);
    await act(async () => {
      root!.render(<TableControls editor={editor} onAiModify={onAiModify} />);
    });
    await selectFirstRow(portal);
    const button = portal.querySelector<HTMLButtonElement>(".dt-ai");
    expect(button?.disabled).toBe(true);
    expect(button?.title).toBe("含合并单元格的表格暂不支持");
    button?.click();
    expect(onAiModify).not.toHaveBeenCalled();
  });

  it("表缺 blockId 时 toast 且保留选区", async () => {
    const { editor, portal } = setupTable();
    const onAiModify = vi.fn(async () => true);
    const onToast = vi.fn();
    await act(async () => {
      root!.render(<TableControls editor={editor} onAiModify={onAiModify} onToast={onToast} />);
    });
    await selectFirstRow(portal);
    const button = portal.querySelector<HTMLButtonElement>(".dt-ai");
    await act(async () => { button?.click(); });
    expect(onToast).toHaveBeenCalledWith("无法定位表格,请重新选择");
    expect(onAiModify).not.toHaveBeenCalled();
    expect(portal.querySelector(".tbl-row-hdr.active")).not.toBeNull();
  });
});
