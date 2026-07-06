import { describe, expect, it } from "vitest";
import {
  aiBlockSchema,
  aiListItemSchema,
  aiTableCellSchema,
  aiTaskListItemSchema,
  type AiBlock,
} from "../aiIrSchema";
import { qingmlParse, qingmlParseFragment } from "../qingmlParse";

describe("qingmlParse", () => {
  it("解析 title、三级嵌套列表和 taskList checked", () => {
    const result = qingmlParse(`
      <title>发布计划</title>
      <ul>
        <li>阶段一
          <ul>
            <li>任务一
              <ul><li>检查点一</li></ul>
            </li>
          </ul>
        </li>
      </ul>
      <tasks><task checked="true">已完成</task><task checked="false">未完成</task></tasks>
    `);

    expect(result.title).toBe("发布计划");
    expectValidBlocks(result.blocks);
    expect(maxListDepth(result.blocks[0])).toBe(3);
    expect(result.blocks[1]).toMatchObject({
      type: "taskList",
      items: [{ checked: true, runs: [{ text: "已完成" }] }, { checked: false, runs: [{ text: "未完成" }] }],
    });
  });

  it("解析表格并推导全 th 行为 row.header=true", () => {
    const result = qingmlParse(`
      <table>
        <tr><th>指标</th><th>数值</th></tr>
        <tr><td bg="rose">收入</td><td><b>100</b></td></tr>
      </table>
    `);

    expectValidBlocks(result.blocks);
    expect(result.blocks).toEqual([
      {
        type: "table",
        rows: [
          {
            header: true,
            cells: [
              { header: true, runs: [{ text: "指标" }] },
              { header: true, runs: [{ text: "数值" }] },
            ],
          },
          {
            cells: [
              { backgroundColor: "rose", runs: [{ text: "收入" }] },
              { runs: [{ text: "100", marks: [{ type: "bold" }] }] },
            ],
          },
        ],
      },
    ]);
  });

  it("解析 columns + callout", () => {
    const result = qingmlParse(`
      <columns>
        <column ratio="0.4"><p>左列</p></column>
        <column ratio="0.6"><callout emoji="!" tone="warning">注意 <b>重点</b></callout></column>
      </columns>
    `);

    expectValidBlocks(result.blocks);
    expect(result.blocks).toMatchObject([
      {
        type: "columnList",
        columns: [
          { widthRatio: 0.4, blocks: [{ type: "paragraph", runs: [{ text: "左列" }] }] },
          {
            widthRatio: 0.6,
            blocks: [
              {
                type: "callout",
                emoji: "!",
                tone: "warning",
                runs: [{ text: "注意 " }, { text: "重点", marks: [{ type: "bold" }] }],
              },
            ],
          },
        ],
      },
    ]);
  });

  it("解析行内 marks 组合和 inline math", () => {
    const result = qingmlParse(`
      <p><b><i><u><s><code>mix</code></s></u></i></b>
      <a href="https://example.com" title="站点">link</a>
      <mark color="yellow">hi</mark><color val="red">red</color>
      <del>gone</del><strong>strong</strong><em>em</em><b><math>E=mc^2</math></b></p>
    `);

    expectValidBlocks(result.blocks);
    const block = result.blocks[0];
    expect(block).toMatchObject({ type: "paragraph" });
    if (block?.type !== "paragraph") throw new Error("missing paragraph");

    expect(block.runs).toEqual([
      {
        text: "mix",
        marks: [{ type: "bold" }, { type: "italic" }, { type: "underline" }, { type: "strike" }, { type: "code" }],
      },
      { text: " " },
      { text: "link", marks: [{ type: "link", href: "https://example.com", title: "站点" }] },
      { text: " " },
      { text: "hi", marks: [{ type: "highlight", color: "yellow" }] },
      { text: "red", marks: [{ type: "textColor", color: "red" }] },
      { text: " " },
      { text: "gone", marks: [{ type: "strike" }] },
      { text: "strong", marks: [{ type: "bold" }] },
      { text: "em", marks: [{ type: "italic" }] },
      { text: "E=mc^2", marks: [{ type: "math" }] },
    ]);
  });

  it("未转义 pre 子标签按 raw island 静默重建，块级泄漏仍记 bad-block", () => {
    const repaired = qingmlParse(`<pre lang="cpp">#include <stdio.h>\nvector<int> v;</pre>`);
    expectValidBlocks(repaired.blocks);
    expect(repaired.blocks[0]).toMatchObject({ type: "codeBlock", language: "cpp" });
    expect(repaired.blocks[0]?.type === "codeBlock" ? repaired.blocks[0].text : "").toContain("#include <stdio.h>");
    expect(repaired.blocks[0]?.type === "codeBlock" ? repaired.blocks[0].text : "").toContain("vector<int>");
    expect(repaired.warnings.some((warning) => warning.severity === "bad-block")).toBe(false);

    const leaked = qingmlParse(`<pre>text<p>block</p></pre>`);
    expectValidBlocks(leaked.blocks);
    expect(leaked.warnings).toContainEqual({
      kind: "raw-text-child-tag",
      severity: "bad-block",
      detail: "<pre> 内出现子标签，通常表示代码/公式里的 < 没有按 &lt; 转义。",
    });

    const good = qingmlParse(`<pre>#include &lt;stdio.h&gt;</pre>`);
    expectValidBlocks(good.blocks);
    expect(good.blocks).toEqual([{ type: "codeBlock", language: undefined, text: "#include <stdio.h>" }]);
    expect(good.warnings.some((warning) => warning.severity === "bad-block")).toBe(false);
  });

  it("锚死未闭合/交错标签的 htmlparser2 归一输出", () => {
    const result = qingmlParse(`<p><b>粗<i>斜</b>尾</i>`);
    expectValidBlocks(result.blocks);
    expect(result.blocks).toMatchInlineSnapshot(`
      [
        {
          "runs": [
            {
              "marks": [
                {
                  "type": "bold",
                },
              ],
              "text": "粗",
            },
            {
              "marks": [
                {
                  "type": "bold",
                },
                {
                  "type": "italic",
                },
              ],
              "text": "斜",
            },
            {
              "text": "尾",
            },
          ],
          "type": "paragraph",
        },
      ]
    `);
  });

  it("处理裸 <&、br、未知标签剥壳、blockquote p 合并和纯文本", () => {
    const bare = qingmlParse(`正文裸 <&;<br>尾`);
    expectValidBlocks(bare.blocks);
    expect(bare.blocks).toEqual([{ type: "paragraph", runs: [{ text: "正文裸 <&;\n尾" }] }]);

    const unknown = qingmlParse(`<foo>包裹 <b>内文</b></foo>`);
    expectValidBlocks(unknown.blocks);
    expect(unknown.blocks).toEqual([
      { type: "paragraph", runs: [{ text: "包裹 " }, { text: "内文", marks: [{ type: "bold" }] }] },
    ]);

    const quote = qingmlParse(`<blockquote><p>a</p><p>b</p></blockquote>`);
    expectValidBlocks(quote.blocks);
    expect(quote.blocks).toEqual([{ type: "blockquote", runs: [{ text: "a\nb" }] }]);
    expect(quote.warnings.some((warning) => warning.severity === "bad-block")).toBe(false);

    const plain = qingmlParse(`纯文本无标签`);
    expectValidBlocks(plain.blocks);
    expect(plain.blocks).toEqual([{ type: "paragraph", runs: [{ text: "纯文本无标签" }] }]);
    expect(plain.warnings).toContainEqual({
      kind: "plain-text-document",
      severity: "harmless",
      detail: "输入没有 QingML 标签，按纯文本段落解析。",
    });
  });

  it("区分 fence/前导话无害剥壳、块级拍平 bad-block 和 CJK 空白折叠", () => {
    const fenced = qingmlParse("前导\n```qingml\n<p>正文</p>\n```\n收尾");
    expectValidBlocks(fenced.blocks);
    expect(fenced.blocks).toEqual([{ type: "paragraph", runs: [{ text: "正文" }] }]);
    expect(fenced.warnings.some((warning) => warning.kind === "fence-stripped" && warning.severity === "harmless")).toBe(true);

    const prelude = qingmlParse("下面是：\n<p>正文</p>");
    expectValidBlocks(prelude.blocks);
    expect(prelude.blocks).toEqual([{ type: "paragraph", runs: [{ text: "正文" }] }]);
    expect(prelude.warnings.some((warning) => warning.kind === "root-text-stripped" && warning.severity === "harmless")).toBe(true);

    const badInlineOnly = qingmlParse(`<callout><p>块级</p></callout>`);
    expectValidBlocks(badInlineOnly.blocks);
    expect(badInlineOnly.blocks).toEqual([{ type: "callout", runs: [{ text: "块级" }] }]);
    expect(badInlineOnly.warnings.some((warning) => warning.kind === "inline-block-flattened" && warning.severity === "bad-block")).toBe(true);

    const structuralUnknown = qingmlParse(`<foo><ul><li>结构</li></ul></foo>`);
    expectValidBlocks(structuralUnknown.blocks);
    expect(structuralUnknown.warnings.some((warning) => warning.kind === "unknown-structural-tag" && warning.severity === "bad-block")).toBe(true);

    const cjk = qingmlParse(`<p>中文　全角  连续\t空白</p>`);
    expectValidBlocks(cjk.blocks);
    expect(cjk.blocks).toEqual([{ type: "paragraph", runs: [{ text: "中文　全角 连续 空白" }] }]);
  });

  it("script/style 被忽略,内容不当正文吞进 runs", () => {
    const r = qingmlParse(`<p>正文</p><script>alert(1)</script><style>.x{color:red}</style>`);
    expectValidBlocks(r.blocks);
    expect(r.blocks).toEqual([{ type: "paragraph", runs: [{ text: "正文" }] }]);
    const joined = JSON.stringify(r.blocks);
    expect(joined).not.toContain("alert");
    expect(joined).not.toContain("color:red");
    expect(r.warnings.some((w) => w.kind === "script-style-dropped" && w.severity === "harmless")).toBe(true);
  });
});

describe("qingmlParseFragment", () => {
  it("接受各 action 的合法根并剥掉允许的容器壳", () => {
    const blocks = qingmlParseFragment(`<div><p>块</p><h2>标题</h2></div>`, "replaceBlock");
    expect(blocks.ok).toBe(true);
    if (!blocks.ok || blocks.kind !== "blocks") throw new Error("missing blocks");
    expectValidBlocks(blocks.blocks);
    expect(blocks.blocks.map((block) => block.type)).toEqual(["paragraph", "heading"]);

    const listItem = qingmlParseFragment(`<ul><li>父<ul><li>子</li></ul></li></ul>`, "insertListItem");
    expect(listItem.ok).toBe(true);
    if (!listItem.ok || listItem.kind !== "listItem") throw new Error("missing listItem");
    expect(aiListItemSchema.safeParse(listItem.item).success).toBe(true);
    expect(listItem.item).toMatchObject({ runs: [{ text: "父" }], children: [{ type: "bulletList" }] });

    const nakedListItem = qingmlParseFragment(`裸 <b>行内</b>`, "replaceListItem");
    expect(nakedListItem.ok).toBe(true);
    if (!nakedListItem.ok || nakedListItem.kind !== "listItem") throw new Error("missing naked item");
    expect(nakedListItem.item).toEqual({ runs: [{ text: "裸 " }, { text: "行内", marks: [{ type: "bold" }] }] });

    const taskItem = qingmlParseFragment(`<task checked="true">待办</task>`, "replaceListItem");
    expect(taskItem.ok).toBe(true);
    if (!taskItem.ok || taskItem.kind !== "listItem") throw new Error("missing task item");
    expect(aiTaskListItemSchema.safeParse(taskItem.item).success).toBe(true);
    expect(taskItem.item).toMatchObject({ checked: true, runs: [{ text: "待办" }] });

    const row = qingmlParseFragment(`<table><tr><th>A</th><td>B</td></tr></table>`, "insertTableRow");
    expect(row.ok).toBe(true);
    if (!row.ok || row.kind !== "row") throw new Error("missing row");
    expect(row.cells.every((cell) => aiTableCellSchema.safeParse(cell).success)).toBe(true);
    expect(row.cells).toEqual([{ header: true, runs: [{ text: "A" }] }, { runs: [{ text: "B" }] }]);

    const column = qingmlParseFragment(`<table><tr><td>A1</td></tr><tr><td>A2</td></tr></table>`, "insertTableColumn");
    expect(column.ok).toBe(true);
    if (!column.ok || column.kind !== "column") throw new Error("missing column");
    expect(column.cells.every((cell) => aiTableCellSchema.safeParse(cell).success)).toBe(true);
    expect(column.cells).toEqual([{ runs: [{ text: "A1" }] }, { runs: [{ text: "A2" }] }]);
  });

  it("拒收越界根节点，不做三载体宽容归一", () => {
    const badList = qingmlParseFragment(`<table><tr><td>x</td></tr></table>`, "replaceListItem");
    expect(badList).toMatchObject({ ok: false });

    const badRow = qingmlParseFragment(`<p>x</p>`, "insertTableRow");
    expect(badRow).toMatchObject({ ok: false });

    const badColumn = qingmlParseFragment(`<tr><td>a</td><td>b</td></tr>`, "insertTableColumn");
    expect(badColumn).toMatchObject({ ok: false });
  });
});

function expectValidBlocks(blocks: readonly AiBlock[]): void {
  for (const block of blocks) {
    expect(aiBlockSchema.safeParse(block).success).toBe(true);
  }
}

function maxListDepth(block: AiBlock | undefined): number {
  if (!block) return 0;
  if (block.type === "bulletList" || block.type === "orderedList" || block.type === "taskList") {
    return Math.max(
      1,
      ...block.items.flatMap((item) => (item.children ?? []).map((child) => 1 + maxListDepth(child))),
    );
  }
  if (block.type === "columnList") return Math.max(0, ...block.columns.flatMap((column) => column.blocks.map(maxListDepth)));
  return 0;
}
