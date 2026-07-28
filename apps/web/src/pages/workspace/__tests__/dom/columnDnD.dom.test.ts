// @vitest-environment jsdom

import { Editor, type JSONContent } from "@tiptap/core";
import { Fragment, type Node as PmModelNode } from "@tiptap/pm/model";
import { createQingagentExtensions } from "@qingagent/pm-schema/tiptap";
import { normalizePmDoc, safeParsePmDoc, type PmBlockNode, type PmDoc } from "@qingagent/pm-schema";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendColumnToList,
  buildColumnDropTransaction,
  buildColumnList,
  findDraggableBlock,
  insertEmptyColumnTransaction,
  rebuildColumnList,
  removeColumnTransaction,
  resolveBlockAtPos,
  resolveDropIntent,
  resolveMovableBlockAtCoords,
  type RectLike,
} from "../../components/ColumnDnD";
import { ColumnCM, ColumnListCM } from "../../components/ColumnView";

const mountedEditors: Editor[] = [];

function createEditor(content: JSONContent): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: createQingagentExtensions({
      columnListExtension: ColumnListCM,
      columnExtension: ColumnCM,
    }),
    content,
  });
  mountedEditors.push(editor);
  return editor;
}

afterEach(() => {
  for (const editor of mountedEditors.splice(0)) {
    const element = editor.options.element;
    editor.destroy();
    if (element instanceof HTMLElement) element.remove();
  }
  document.body.innerHTML = "";
});

function text(value: string): JSONContent {
  return { type: "text", text: value };
}

function paragraph(blockId: string, value: string): JSONContent {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: value ? [text(value)] : [],
  };
}

function callout(blockId: string, value: string): JSONContent {
  return {
    type: "callout",
    attrs: { blockId, emoji: "i", tone: "info" },
    content: [paragraph(`${blockId}-p`, value)],
  };
}

function bulletList(blockId: string, value: string): JSONContent {
  return {
    type: "bulletList",
    attrs: { blockId },
    content: [
      {
        type: "listItem",
        attrs: { blockId: `${blockId}-li` },
        content: [paragraph(`${blockId}-p`, value)],
      },
    ],
  };
}

function table(blockId: string, value: string): JSONContent {
  return {
    type: "table",
    attrs: { blockId },
    content: [
      {
        type: "tableRow",
        content: [
          {
            type: "tableCell",
            content: [paragraph(`${blockId}-cell-p`, value)],
          },
        ],
      },
    ],
  };
}

function columnList(blockId: string, columns: Array<{ id: string; ratio: number; blocks: JSONContent[] }>): JSONContent {
  return {
    type: "columnList",
    attrs: { blockId },
    content: columns.map((column) => ({
      type: "column",
      attrs: { blockId: column.id, widthRatio: column.ratio },
      content: column.blocks,
    })),
  };
}

function doc(content: JSONContent[]): JSONContent {
  return { type: "doc", attrs: { schemaVersion: 1 }, content };
}

function normalized(editor: Editor): PmDoc {
  return normalizePmDoc(editor.getJSON()) as PmDoc;
}

function blockText(node: JSONContent | PmBlockNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return String((node as { text?: string }).text ?? "");
  return ((node as { content?: Array<JSONContent | PmBlockNode> }).content ?? []).map(blockText).join("");
}

function columnTexts(block: PmBlockNode): string[][] {
  expect(block.type).toBe("columnList");
  return (block as Extract<PmBlockNode, { type: "columnList" }>).content.map((column) =>
    column.content.map((child) => blockText(child)),
  );
}

function findNodePosition(editor: Editor, type: string, blockId?: string): number {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found != null) return false;
    if (node.type.name === type && (blockId == null || node.attrs.blockId === blockId)) {
      found = pos;
      return false;
    }
    return true;
  });
  expect(found).not.toBeNull();
  return found!;
}

function findTextPosition(editor: Editor, value: string): number {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found != null) return false;
    if (node.isText && node.text) {
      const index = node.text.indexOf(value);
      if (index >= 0) {
        found = pos + index;
        return false;
      }
    }
    return true;
  });
  expect(found).not.toBeNull();
  return found!;
}

function dispatch(editor: Editor, tr: ReturnType<typeof buildColumnDropTransaction>) {
  expect(tr).not.toBeNull();
  editor.view.dispatch(tr!);
}

function ratioSum(block: PmBlockNode): number {
  expect(block.type).toBe("columnList");
  return Number(
    (block as Extract<PmBlockNode, { type: "columnList" }>).content
      .reduce((sum, column) => sum + Number(column.attrs.widthRatio), 0)
      .toFixed(4),
  );
}

function rect(left: number, top: number, width: number, height: number): RectLike {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

describe("分栏 DnD 事务工厂", () => {
  it("顶层建栏按左右边缘定序,source/target 块原样进入新 columnList", () => {
    const editor = createEditor(doc([paragraph("p-a", "A"), paragraph("p-b", "B")]));
    const source = findNodePosition(editor, "paragraph", "p-b");
    const target = findNodePosition(editor, "paragraph", "p-a");

    dispatch(editor, buildColumnList(editor.state, source, target, "left"));
    let out = normalized(editor);
    expect(out.content).toHaveLength(1);
    expect(columnTexts(out.content[0]!)).toEqual([["B"], ["A"]]);
    expect(ratioSum(out.content[0]!)).toBe(1);

    const editorRight = createEditor(doc([paragraph("p-a", "A"), paragraph("p-b", "B")]));
    dispatch(
      editorRight,
      buildColumnList(
        editorRight.state,
        findNodePosition(editorRight, "paragraph", "p-b"),
        findNodePosition(editorRight, "paragraph", "p-a"),
        "right",
      ),
    );
    out = normalized(editorRight);
    expect(columnTexts(out.content[0]!)).toEqual([["A"], ["B"]]);
  });

  it("并入已有 list 新增列并归一化 ratio,source 在顶层前后都能正确映射", () => {
    const editor = createEditor(
      doc([
        columnList("cl", [
          { id: "c-l", ratio: 0.6, blocks: [paragraph("p-l", "L")] },
          { id: "c-r", ratio: 0.4, blocks: [paragraph("p-r", "R")] },
        ]),
        paragraph("p-b", "B"),
      ]),
    );
    dispatch(
      editor,
      appendColumnToList(
        editor.state,
        findNodePosition(editor, "paragraph", "p-b"),
        findNodePosition(editor, "paragraph", "p-r"),
        "right",
      ),
    );
    const out = normalized(editor);
    expect(out.content).toHaveLength(1);
    expect(columnTexts(out.content[0]!)).toEqual([["L"], ["R"], ["B"]]);
    expect(ratioSum(out.content[0]!)).toBe(1);

    const before = createEditor(doc([paragraph("p-s", "S"), paragraph("p-x", "X"), paragraph("p-t", "T")]));
    dispatch(
      before,
      buildColumnDropTransaction(
        before.state,
        findNodePosition(before, "paragraph", "p-s"),
        findNodePosition(before, "paragraph", "p-t"),
        "right",
      ),
    );
    expect(blockText(normalized(before).content[0])).toBe("X");
    expect(columnTexts(normalized(before).content[1]!)).toEqual([["T"], ["S"]]);

    const after = createEditor(doc([paragraph("p-t", "T"), paragraph("p-x", "X"), paragraph("p-s", "S")]));
    dispatch(
      after,
      buildColumnDropTransaction(
        after.state,
        findNodePosition(after, "paragraph", "p-s"),
        findNodePosition(after, "paragraph", "p-t"),
        "left",
      ),
    );
    expect(columnTexts(normalized(after).content[0]!)).toEqual([["S"], ["T"]]);
    expect(blockText(normalized(after).content[1])).toBe("X");
  });

  it("same-list 操作整 list 重建,不经空栏中间态,undo 一步回原 doc", () => {
    const editor = createEditor(
      doc([
        columnList("cl", [
          { id: "c-l", ratio: 0.5, blocks: [paragraph("p-l1", "L1"), paragraph("p-l2", "L2")] },
          { id: "c-r", ratio: 0.5, blocks: [paragraph("p-r", "R")] },
        ]),
      ]),
    );
    const before = JSON.stringify(normalized(editor));
    dispatch(
      editor,
      appendColumnToList(
        editor.state,
        findNodePosition(editor, "paragraph", "p-l1"),
        findNodePosition(editor, "paragraph", "p-r"),
        "left",
      ),
    );
    const moved = normalized(editor);
    expect(columnTexts(moved.content[0]!)).toEqual([["L2"], ["L1"], ["R"]]);
    expect(safeParsePmDoc(moved).success).toBe(true);

    expect(editor.commands.undo()).toBe(true);
    expect(JSON.stringify(normalized(editor))).toBe(before);
  });

  it("回归:same-list 源列塌陷且在 target 左侧时,块落到正确栏(off-by-one 补偿)", () => {
    // [A,B,C,D] 单块四列;A(列0,唯一块)拖到 C(列2)左边 → 期望 [B,A,C,D](非 [B,C,A,D])。
    const mk = () =>
      createEditor(
        doc([
          columnList("cl", [
            { id: "c-a", ratio: 0.25, blocks: [paragraph("p-a", "A")] },
            { id: "c-b", ratio: 0.25, blocks: [paragraph("p-b", "B")] },
            { id: "c-c", ratio: 0.25, blocks: [paragraph("p-c", "C")] },
            { id: "c-d", ratio: 0.25, blocks: [paragraph("p-d", "D")] },
          ]),
        ]),
      );
    const left = mk();
    dispatch(
      left,
      appendColumnToList(
        left.state,
        findNodePosition(left, "paragraph", "p-a"),
        findNodePosition(left, "paragraph", "p-c"),
        "left",
      ),
    );
    expect(columnTexts(normalized(left).content[0]!)).toEqual([["B"], ["A"], ["C"], ["D"]]);

    const right = mk();
    dispatch(
      right,
      appendColumnToList(
        right.state,
        findNodePosition(right, "paragraph", "p-a"),
        findNodePosition(right, "paragraph", "p-c"),
        "right",
      ),
    );
    expect(columnTexts(normalized(right).content[0]!)).toEqual([["B"], ["C"], ["A"], ["D"]]);
  });

  it("回归:满列(MAX=4)的 list 跨源并入返回 null(不越界建第 5 列)", () => {
    const editor = createEditor(
      doc([
        columnList("cl", [
          { id: "c-a", ratio: 0.25, blocks: [paragraph("p-a", "A")] },
          { id: "c-b", ratio: 0.25, blocks: [paragraph("p-b", "B")] },
          { id: "c-c", ratio: 0.25, blocks: [paragraph("p-c", "C")] },
          { id: "c-d", ratio: 0.25, blocks: [paragraph("p-d", "D")] },
        ]),
        paragraph("p-out", "X"),
      ]),
    );
    expect(
      appendColumnToList(
        editor.state,
        findNodePosition(editor, "paragraph", "p-out"),
        findNodePosition(editor, "paragraph", "p-c"),
        "left",
      ),
    ).toBeNull();
  });

  it("分隔线加号:在指定下标插入只含空段落的新列,其余列等比缩放、ratio 归一", () => {
    const editor = createEditor(
      doc([
        columnList("cl", [
          { id: "c-l", ratio: 0.5, blocks: [paragraph("p-l", "Left")] },
          { id: "c-r", ratio: 0.5, blocks: [paragraph("p-r", "Right")] },
        ]),
      ]),
    );
    const listPos = findNodePosition(editor, "columnList", "cl");
    dispatch(editor, insertEmptyColumnTransaction(editor.state, listPos, 1));
    const block = normalized(editor).content[0]!;
    const texts = columnTexts(block);
    expect(texts).toHaveLength(3);
    expect(texts[0]).toEqual(["Left"]);
    expect(texts[1]).toEqual([""]); // 新列：单个空段落
    expect(texts[2]).toEqual(["Right"]);
    expect(ratioSum(block)).toBe(1);
    // 光标自动落进新列(index 1)的空段落
    const $from = editor.state.selection.$from;
    expect($from.parent.type.name).toBe("paragraph");
    expect($from.node($from.depth - 1).type.name).toBe("column");
    expect($from.index($from.depth - 2)).toBe(1);
  });

  it("末列追加柄:insertIndex=列数 时在末尾追加空列", () => {
    const editor = createEditor(
      doc([
        columnList("cl", [
          { id: "c-l", ratio: 0.5, blocks: [paragraph("p-l", "Left")] },
          { id: "c-r", ratio: 0.5, blocks: [paragraph("p-r", "Right")] },
        ]),
      ]),
    );
    const listPos = findNodePosition(editor, "columnList", "cl");
    dispatch(editor, insertEmptyColumnTransaction(editor.state, listPos, 2));
    const texts = columnTexts(normalized(editor).content[0]!);
    expect(texts).toEqual([["Left"], ["Right"], [""]]);
    // 光标落进末尾新列(index 2)
    const $from = editor.state.selection.$from;
    expect($from.node($from.depth - 1).type.name).toBe("column");
    expect($from.index($from.depth - 2)).toBe(2);
  });

  it("回归:满列(MAX=4)时分隔线加号插列返回 null(不越界建第 5 列)", () => {
    const editor = createEditor(
      doc([
        columnList("cl", [
          { id: "c-a", ratio: 0.25, blocks: [paragraph("p-a", "A")] },
          { id: "c-b", ratio: 0.25, blocks: [paragraph("p-b", "B")] },
          { id: "c-c", ratio: 0.25, blocks: [paragraph("p-c", "C")] },
          { id: "c-d", ratio: 0.25, blocks: [paragraph("p-d", "D")] },
        ]),
      ]),
    );
    expect(
      insertEmptyColumnTransaction(editor.state, findNodePosition(editor, "columnList", "cl"), 2),
    ).toBeNull();
  });

  it("退格删列:删中间列后其余两列保留、ratio 归一", () => {
    const editor = createEditor(
      doc([
        columnList("cl", [
          { id: "c-a", ratio: 0.33, blocks: [paragraph("p-a", "A")] },
          { id: "c-b", ratio: 0.34, blocks: [paragraph("p-b", "")] },
          { id: "c-c", ratio: 0.33, blocks: [paragraph("p-c", "C")] },
        ]),
      ]),
    );
    const listPos = findNodePosition(editor, "columnList", "cl");
    dispatch(editor, removeColumnTransaction(editor.state, listPos, 1));
    const block = normalized(editor).content[0]!;
    const texts = columnTexts(block);
    expect(texts).toEqual([["A"], ["C"]]);
    expect(ratioSum(block)).toBe(1);
  });

  it("退格删列:2列删其一→解体提回父层(列表消失)", () => {
    const editor = createEditor(
      doc([
        columnList("cl", [
          { id: "c-l", ratio: 0.5, blocks: [paragraph("p-l", "Left")] },
          { id: "c-r", ratio: 0.5, blocks: [paragraph("p-r", "")] },
        ]),
      ]),
    );
    const listPos = findNodePosition(editor, "columnList", "cl");
    dispatch(editor, removeColumnTransaction(editor.state, listPos, 1));
    const json = normalized(editor);
    expect(json.content.some((b) => b.type === "columnList")).toBe(false);
    expect(blockText(json.content[0])).toBe("Left");
  });

  it("拖出旧 list 的最后块时在同一事务内塌栏;剩一列则解体提回父层", () => {
    const editor = createEditor(
      doc([
        columnList("cl", [
          { id: "c-l", ratio: 0.5, blocks: [paragraph("p-l", "Left")] },
          { id: "c-r", ratio: 0.5, blocks: [paragraph("p-r", "Right")] },
        ]),
        paragraph("p-out", "Outside"),
      ]),
    );
    dispatch(
      editor,
      buildColumnDropTransaction(
        editor.state,
        findNodePosition(editor, "paragraph", "p-l"),
        findNodePosition(editor, "paragraph", "p-out"),
        "left",
      ),
    );
    const out = normalized(editor);
    expect(blockText(out.content[0])).toBe("Right");
    expect(columnTexts(out.content[1]!)).toEqual([["Left"], ["Outside"]]);
    expect(safeParsePmDoc(out).success).toBe(true);

    const collapse = createEditor(
      doc([
        columnList("cl", [
          { id: "c-l", ratio: 0.5, blocks: [paragraph("p-l", "Left")] },
          { id: "c-r", ratio: 0.5, blocks: [paragraph("p-r", "Right")] },
        ]),
      ]),
    );
    dispatch(collapse, rebuildColumnList(collapse.state, findNodePosition(collapse, "columnList", "cl"), findNodePosition(collapse, "paragraph", "p-l")));
    const collapsed = normalized(collapse);
    expect(collapsed.content).toHaveLength(1);
    expect(blockText(collapsed.content[0])).toBe("Right");
    expect(safeParsePmDoc(collapsed).success).toBe(true);
  });

  it("拖自身 noop,源是 columnList 拒绝,空栏 JSON 不过 validator 但受控事务产物合法", () => {
    const editor = createEditor(doc([paragraph("p-a", "A"), paragraph("p-b", "B")]));
    const source = findNodePosition(editor, "paragraph", "p-a");
    expect(buildColumnDropTransaction(editor.state, source, source, "left")).toBeNull();

    const listSource = createEditor(
      doc([
        columnList("cl", [
          { id: "c-l", ratio: 0.5, blocks: [paragraph("p-l", "Left")] },
          { id: "c-r", ratio: 0.5, blocks: [paragraph("p-r", "Right")] },
        ]),
        paragraph("p-out", "Outside"),
      ]),
    );
    expect(
      buildColumnDropTransaction(
        listSource.state,
        findNodePosition(listSource, "columnList", "cl"),
        findNodePosition(listSource, "paragraph", "p-out"),
        "left",
      ),
    ).toBeNull();

    const invalidEmptyColumn = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        columnList("bad", [
          { id: "empty", ratio: 0.5, blocks: [] },
          { id: "full", ratio: 0.5, blocks: [paragraph("p-full", "Full")] },
        ]),
      ],
    } as unknown as PmDoc;
    expect(safeParsePmDoc(invalidEmptyColumn).success).toBe(false);

    const fixed = createEditor(
      doc([
        columnList("cl", [
          { id: "c-l", ratio: 0.5, blocks: [paragraph("p-l", "Left")] },
          { id: "c-r", ratio: 0.5, blocks: [paragraph("p-r", "Right")] },
        ]),
      ]),
    );
    dispatch(fixed, rebuildColumnList(fixed.state, findNodePosition(fixed, "columnList", "cl"), findNodePosition(fixed, "paragraph", "p-l")));
    expect(safeParsePmDoc(normalized(fixed)).success).toBe(true);
  });
});

describe("分栏 DnD 命中判定", () => {
  it("EDGE 内返回左右 columnEdge,中间区域交回竖直 dropcursor,rect fallback 可兜底 posAtCoords null", () => {
    const editor = createEditor(doc([paragraph("p-a", "A"), paragraph("p-b", "B")]));
    const source = resolveBlockAtPos(editor.state, findNodePosition(editor, "paragraph", "p-b"));
    const targetPos = findNodePosition(editor, "paragraph", "p-a");
    const targetRect = rect(100, 10, 200, 40);
    const getRect = (block: { pos: number }) => (block.pos === targetPos ? targetRect : null);

    const left = resolveDropIntent({
      state: editor.state,
      source,
      coords: { left: 108, top: 20 },
      posAtCoords: () => ({ pos: targetPos + 1 }),
      getRect,
    });
    expect(left.kind).toBe("columnEdge");
    if (left.kind === "columnEdge") expect(left.side).toBe("left");

    const right = resolveDropIntent({
      state: editor.state,
      source,
      coords: { left: 292, top: 20 },
      posAtCoords: () => ({ pos: targetPos + 1 }),
      getRect,
    });
    expect(right.kind).toBe("columnEdge");
    if (right.kind === "columnEdge") expect(right.side).toBe("right");

    expect(
      resolveDropIntent({
        state: editor.state,
        source,
        coords: { left: 200, top: 20 },
        posAtCoords: () => ({ pos: targetPos + 1 }),
        getRect,
      }).kind,
    ).toBe("vertical");

    const fallback = resolveDropIntent({
      state: editor.state,
      source,
      coords: { left: 108, top: 20 },
      posAtCoords: () => null,
      getRect,
    });
    expect(fallback.kind).toBe("columnEdge");
  });

  it("回归:目标列所在 list 已满(MAX=4)且跨源时,边缘命中降级竖直(不画建栏金边)", () => {
    const editor = createEditor(
      doc([
        columnList("cl", [
          { id: "c-a", ratio: 0.25, blocks: [paragraph("p-a", "A")] },
          { id: "c-b", ratio: 0.25, blocks: [paragraph("p-b", "B")] },
          { id: "c-c", ratio: 0.25, blocks: [paragraph("p-c", "C")] },
          { id: "c-d", ratio: 0.25, blocks: [paragraph("p-d", "D")] },
        ]),
        paragraph("p-out", "X"),
      ]),
    );
    const source = resolveBlockAtPos(editor.state, findNodePosition(editor, "paragraph", "p-out"));
    const targetPos = findNodePosition(editor, "paragraph", "p-c");
    const targetRect = rect(100, 10, 200, 40);
    const intent = resolveDropIntent({
      state: editor.state,
      source,
      coords: { left: 108, top: 20 }, // 左边缘内
      posAtCoords: () => ({ pos: targetPos + 1 }),
      getRect: (block: { pos: number }) => (block.pos === targetPos ? targetRect : null),
    });
    expect(intent.kind).toBe("vertical"); // 满列降级,不返回 columnEdge
  });

  it("回归:同一满列列表仅在删源会塌列时允许边缘建栏,源列仍有块则降级竖直", () => {
    const editor = createEditor(
      doc([
        columnList("cl", [
          {
            id: "c-a",
            ratio: 0.25,
            blocks: [paragraph("p-a1", "A1"), paragraph("p-a2", "A2")],
          },
          { id: "c-b", ratio: 0.25, blocks: [paragraph("p-b", "B")] },
          { id: "c-c", ratio: 0.25, blocks: [paragraph("p-c", "C")] },
          { id: "c-d", ratio: 0.25, blocks: [paragraph("p-d", "D")] },
        ]),
      ]),
    );
    const targetPos = findNodePosition(editor, "paragraph", "p-c");
    const targetRect = rect(100, 10, 200, 40);
    const intentFor = (sourceId: string) =>
      resolveDropIntent({
        state: editor.state,
        source: resolveBlockAtPos(editor.state, findNodePosition(editor, "paragraph", sourceId)),
        coords: { left: 108, top: 20 },
        posAtCoords: () => ({ pos: targetPos + 1 }),
        getRect: (block: { pos: number }) => (block.pos === targetPos ? targetRect : null),
      });

    expect(intentFor("p-a1").kind).toBe("vertical");
    expect(intentFor("p-b").kind).toBe("columnEdge");
  });

  it("叶子块(horizontalRule / diagram 等 atom)也能被块手柄命中:findDraggableBlock 经 nodeAfter 命中", () => {
    // 叶子块无法从"内部位置"解析到自身(向上走只会拿到父节点),修复前块手柄拖不到图表/分割线。
    const editor = createEditor(
      doc([
        paragraph("p1", "A"),
        { type: "horizontalRule", attrs: { blockId: "hr1" } },
        paragraph("p2", "B"),
      ]),
    );
    let hrPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "horizontalRule") hrPos = pos;
      return true;
    });
    expect(hrPos).toBeGreaterThanOrEqual(0);
    // 内部位置(pos+1)落到块后,解析不到叶子块本身(回归前的失败形态)
    expect(findDraggableBlock(editor.state.doc.resolve(hrPos + 1))?.node.type.name).not.toBe("horizontalRule");
    // 边界位置(pos)经 nodeAfter 命中叶子块本身
    const block = findDraggableBlock(editor.state.doc.resolve(hrPos));
    expect(block?.node.type.name).toBe("horizontalRule");
    expect(block?.pos).toBe(hrPos);
    expect(block?.parentType).toBe("doc");
    expect(block?.parentDepth).toBe(0);
  });

  it("表格/列表/callout 内部命中会上升到 doc/column 直接子块,不把 cell/listItem 当 target", () => {
    const editor = createEditor(
      doc([
        paragraph("p-source", "Source"),
        table("tbl", "Cell"),
        bulletList("list", "Item"),
        callout("callout", "Callout"),
      ]),
    );
    const cases: Array<[string, string]> = [
      ["Cell", "table"],
      ["Item", "bulletList"],
      ["Callout", "callout"],
    ];
    for (const [needle, expectedType] of cases) {
      const target = resolveMovableBlockAtCoords(
        editor.state,
        { left: 10, top: 10 },
        () => ({ pos: findTextPosition(editor, needle) }),
      );
      expect(target?.node.type.name).toBe(expectedType);
    }
  });
});

describe("分栏 appendTransaction 守卫", () => {
  function replaceFirstColumnList(editor: Editor, node: PmModelNode) {
    const pos = findNodePosition(editor, "columnList");
    const current = editor.state.doc.nodeAt(pos)!;
    editor.view.dispatch(editor.state.tr.replaceWith(pos, pos + current.nodeSize, node));
  }

  it("单栏残留会解体,空 childCount 栏只作为兜底被移除,插入菜单两空段栏保持合法", () => {
    const editor = createEditor(
      doc([
        columnList("cl", [
          { id: "c-l", ratio: 0.5, blocks: [paragraph("p-l", "Left")] },
          { id: "c-r", ratio: 0.5, blocks: [paragraph("p-r", "Right")] },
        ]),
      ]),
    );
    const schema = editor.state.schema;
    const single = schema.nodes.columnList!.create(
      { blockId: "single" },
      Fragment.fromArray([
        schema.nodes.column!.create(
          { blockId: "single-col", widthRatio: 1 },
          Fragment.fromArray([schema.nodes.paragraph!.create({ blockId: "single-p" }, schema.text("Single"))]),
        ),
      ]),
    );
    replaceFirstColumnList(editor, single);
    expect(normalized(editor).content[0]?.type).toBe("paragraph");
    expect(blockText(normalized(editor).content[0])).toBe("Single");

    const emptyGuard = createEditor(
      doc([
        columnList("cl", [
          { id: "c-l", ratio: 0.5, blocks: [paragraph("p-l", "Left")] },
          { id: "c-r", ratio: 0.5, blocks: [paragraph("p-r", "Right")] },
        ]),
      ]),
    );
    const emptyColumnList = emptyGuard.state.schema.nodes.columnList!.create(
      { blockId: "empty-list" },
      Fragment.fromArray([
        emptyGuard.state.schema.nodes.column!.create({ blockId: "empty-col", widthRatio: 0.5 }, Fragment.empty),
        emptyGuard.state.schema.nodes.column!.create(
          { blockId: "full-col", widthRatio: 0.5 },
          Fragment.fromArray([emptyGuard.state.schema.nodes.paragraph!.create({ blockId: "full-p" }, emptyGuard.state.schema.text("Full"))]),
        ),
      ]),
    );
    replaceFirstColumnList(emptyGuard, emptyColumnList);
    expect(normalized(emptyGuard).content[0]?.type).toBe("paragraph");
    expect(blockText(normalized(emptyGuard).content[0])).toBe("Full");

    const menuEmpty = createEditor(
      doc([
        columnList("menu", [
          { id: "menu-l", ratio: 0.5, blocks: [paragraph("menu-l-p", "")] },
          { id: "menu-r", ratio: 0.5, blocks: [paragraph("menu-r-p", "")] },
        ]),
      ]),
    );
    menuEmpty.view.dispatch(menuEmpty.state.tr.insertText("x", findNodePosition(menuEmpty, "paragraph", "menu-l-p") + 1));
    expect(normalized(menuEmpty).content[0]?.type).toBe("columnList");
    expect((normalized(menuEmpty).content[0] as Extract<PmBlockNode, { type: "columnList" }>).content).toHaveLength(2);
  });

  it("反嵌套会把 column 内直接子 columnList 解包提出", () => {
    const editor = createEditor(doc([paragraph("seed", "Seed")]));
    const schema = editor.state.schema;
    const nested = schema.nodes.columnList!.create(
      { blockId: "outer" },
      Fragment.fromArray([
        schema.nodes.column!.create(
          { blockId: "outer-l", widthRatio: 0.5 },
          Fragment.fromArray([
            schema.nodes.columnList!.create(
              { blockId: "inner" },
              Fragment.fromArray([
                schema.nodes.column!.create(
                  { blockId: "inner-l", widthRatio: 0.5 },
                  Fragment.fromArray([schema.nodes.paragraph!.create({ blockId: "inner-p1" }, schema.text("Inner 1"))]),
                ),
                schema.nodes.column!.create(
                  { blockId: "inner-r", widthRatio: 0.5 },
                  Fragment.fromArray([schema.nodes.paragraph!.create({ blockId: "inner-p2" }, schema.text("Inner 2"))]),
                ),
              ]),
            ),
          ]),
        ),
        schema.nodes.column!.create(
          { blockId: "outer-r", widthRatio: 0.5 },
          Fragment.fromArray([schema.nodes.paragraph!.create({ blockId: "outer-p" }, schema.text("Outer"))]),
        ),
      ]),
    );
    const seed = findNodePosition(editor, "paragraph", "seed");
    editor.view.dispatch(editor.state.tr.replaceWith(seed, seed + editor.state.doc.nodeAt(seed)!.nodeSize, nested));
    const out = normalized(editor);
    expect(out.content[0]?.type).toBe("columnList");
    expect(JSON.stringify(out).match(/"type":"columnList"/g)).toHaveLength(1);
    expect(blockText(out.content[0])).toContain("Inner 1");
    expect(blockText(out.content[0])).toContain("Inner 2");
  });

  it("ratio 漂移只在偏差时归一化", () => {
    const editor = createEditor(
      doc([
        columnList("cl", [
          { id: "c-l", ratio: 0.2, blocks: [paragraph("p-l", "Left")] },
          { id: "c-r", ratio: 0.2, blocks: [paragraph("p-r", "Right")] },
        ]),
      ]),
    );
    editor.view.dispatch(editor.state.tr.insertText("!", findTextPosition(editor, "Left")));
    const out = normalized(editor).content[0] as Extract<PmBlockNode, { type: "columnList" }>;
    expect(out.content.map((column) => column.attrs.widthRatio)).toEqual([0.5, 0.5]);
  });
});
