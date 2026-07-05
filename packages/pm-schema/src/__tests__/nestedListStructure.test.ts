import { describe, expect, it } from "vitest";
import {
  compileAiDocumentToPm,
  detectNestedListIntent,
  flatDepthListToAiIr,
  pmDocHasNestedList,
  pmToAiIr,
  type AiBlock,
} from "../index";

describe("嵌套列表格式与只读自检", () => {
  it("扁平 items+depth 会编译为真实嵌套列表，depth 跳级就近挂载且逐字保留", () => {
    const flat = {
      type: "list",
      ordered: false,
      items: [
        { depth: 1, runs: [{ text: "一级 A" }] },
        { depth: 2, runs: [{ text: "二级 A1" }] },
        { depth: 4, runs: [{ text: "跳级但应挂到三级 A1a" }] },
        { depth: 1, runs: [{ text: "一级 B" }] },
        { depth: 3, runs: [{ text: "跳级但应挂到二级 B1" }] },
      ],
    };
    const beforeTexts = flat.items.map((item) => item.runs[0]!.text).sort();

    const normalized = flatDepthListToAiIr(flat) as Extract<AiBlock, { type: "bulletList" }>;

    expect(normalized.type).toBe("bulletList");
    expect(normalized.items[0]?.children?.[0]).toMatchObject({
      type: "bulletList",
      items: [{
        runs: [{ text: "二级 A1" }],
        children: [{ type: "bulletList", items: [{ runs: [{ text: "跳级但应挂到三级 A1a" }] }] }],
      }],
    });
    expect(normalized.items[1]?.children?.[0]).toMatchObject({
      type: "bulletList",
      items: [{ runs: [{ text: "跳级但应挂到二级 B1" }] }],
    });

    const compiled = compileAiDocumentToPm({ blocks: [flat] });
    expect(compiled.ok).toBe(true);
    expect(compiled.doc).not.toBeNull();
    expect(pmDocHasNestedList(compiled.doc!, 3)).toBe(true);
    expect(collectRunTexts(pmToAiIr(compiled.doc!).blocks).sort()).toEqual(beforeTexts);
  });

  it("taskList 嵌套也计入列表深度(三级待办清单不被误判未达标)", () => {
    // 回归(lane-C-r2):多级 taskList 成为一等能力后,用户要"三级待办清单"时
    // intent 命中 minDepth=3;旧实现 calculatePmListDepth 只数 bullet/ordered,
    // 正确的 3 级 taskList 会被 bestStructurallyAware 判"未达深度"过滤,
    // 反而优选用错块型(bulletList)的候选,全对时还误报 structuralFailures。
    expect(detectNestedListIntent("帮我建一个三级待办清单,阶段>任务>检查点")).toMatchObject({
      wantsNestedList: true,
      minDepth: 3,
    });

    const compiled = compileAiDocumentToPm({
      blocks: [
        {
          type: "taskList",
          items: [
            { depth: 1, checked: false, runs: [{ text: "准备阶段" }] },
            { depth: 2, checked: false, runs: [{ text: "环境搭建" }] },
            { depth: 3, checked: true, runs: [{ text: "服务器配置完成" }] },
          ],
        },
      ],
    });
    expect(compiled.ok).toBe(true);
    expect(pmDocHasNestedList(compiled.doc!, 3)).toBe(true);
    // 混合嵌套(bulletList 里挂 taskList)同样按层级累计
    const mixed = compileAiDocumentToPm({
      blocks: [
        {
          type: "bulletList",
          items: [
            {
              runs: [{ text: "一级" }],
              children: [
                { type: "taskList", items: [{ checked: false, runs: [{ text: "二级待办" }] }] },
              ],
            },
          ],
        },
      ],
    });
    expect(mixed.ok).toBe(true);
    expect(pmDocHasNestedList(mixed.doc!, 2)).toBe(true);
    expect(pmDocHasNestedList(mixed.doc!, 3)).toBe(false);
  });

  it("嵌套列表意图识别只用于完成态自检", () => {
    const intent = detectNestedListIntent("请生成三级嵌套列表，包含一级阶段、二级任务和三级检查点");
    expect(intent).toMatchObject({ wantsNestedList: true, minDepth: 3 });

    const plainIntent = detectNestedListIntent("请写一段普通说明");
    expect(plainIntent.wantsNestedList).toBe(false);
  });
});

function collectRunTexts(blocks: readonly AiBlock[]): string[] {
  const out: string[] = [];
  const visit = (block: AiBlock): void => {
    if ("runs" in block) out.push(...block.runs.map((run) => run.text));
    if (block.type === "bulletList" || block.type === "orderedList") {
      for (const item of block.items) {
        out.push(...item.runs.map((run) => run.text));
        for (const child of item.children ?? []) visit(child);
      }
      return;
    }
    if (block.type === "columnList") {
      for (const column of block.columns) {
        for (const child of column.blocks) visit(child);
      }
    }
  };
  for (const block of blocks) visit(block);
  return out;
}
