import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  aiBlockSchema,
  aiListItemSchema,
  aiTableCellSchema,
  aiTaskListItemSchema,
  type AiBlock,
} from "../aiIrSchema";
import { qingmlParse, qingmlParseFragment, qingmlTagSkeleton } from "../qingmlParse";

const realDocumentWrapperOutput = readFileSync(
  new URL("./fixtures/document-wrapper.qingml", import.meta.url),
  "utf8",
);

function badBlockWarnings(result: ReturnType<typeof qingmlParse>) {
  return result.warnings.filter((warning) => warning.severity === "bad-block");
}

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
              { header: true, blocks: [{ type: "paragraph", runs: [{ text: "指标" }] }] },
              { header: true, blocks: [{ type: "paragraph", runs: [{ text: "数值" }] }] },
            ],
          },
          {
            cells: [
              { backgroundColor: "rose", blocks: [{ type: "paragraph", runs: [{ text: "收入" }] }] },
              { blocks: [{ type: "paragraph", runs: [{ text: "100", marks: [{ type: "bold" }] }] }] },
            ],
          },
        ],
      },
    ]);
  });

  it("表格 cell 直嵌多块、旧裸文本、空 cell 与 span 均规范化", () => {
    const result = qingmlParse(`
      <table><tr>
        <td colspan="2" rowspan="3" bg="rose"><p>首段</p><ul><li>列表项</li></ul><tasks><task checked>完成</task></tasks></td>
        <td>旧式 <b>裸文本</b></td>
        <td></td>
      </tr></table>
    `);

    expect(result.warnings.filter((warning) => warning.severity === "bad-block")).toEqual([]);
    const table = result.blocks[0];
    expect(table?.type).toBe("table");
    if (table?.type !== "table") throw new Error("missing table");
    expect(table.rows[0]!.cells).toEqual([
      {
        colspan: 2,
        rowspan: 3,
        backgroundColor: "rose",
        blocks: [
          { type: "paragraph", runs: [{ text: "首段" }] },
          { type: "bulletList", items: [{ runs: [{ text: "列表项" }] }] },
          { type: "taskList", items: [{ checked: true, runs: [{ text: "完成" }] }] },
        ],
      },
      {
        blocks: [{
          type: "paragraph",
          runs: [{ text: "旧式 " }, { text: "裸文本", marks: [{ type: "bold" }] }],
        }],
      },
      { blocks: [{ type: "paragraph", runs: [] }] },
    ]);
  });

  it.each(["0", "-1", "1.5"])("非法 colspan=%s 产生 bad-block，供工具层 fail-closed", (value) => {
    const result = qingmlParse(`<table><tr><td colspan="${value}"><p>x</p></td></tr></table>`);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      kind: "invalid-table-span",
      severity: "bad-block",
    }));
  });

  it("完整闭合的表中表报不支持的结构，不误报为截断", () => {
    const nested = qingmlParse(
      "<table><tr><td><table><tr><td><p>内层</p></td></tr></table></td></tr></table>",
    );

    expect(nested.warnings).toContainEqual(expect.objectContaining({
      kind: "unsupported-nested-table",
      severity: "bad-block",
    }));
    const structuralWarnings = nested.warnings.filter((warning) => warning.kind === "unsupported-nested-table");
    expect(structuralWarnings.length).toBeGreaterThan(0);
    expect(structuralWarnings.every((warning) => !warning.detail.includes("截断"))).toBe(true);
    expect(nested.warnings.some((warning) => warning.kind === "truncated-table-structure")).toBe(false);
  });

  it("表内真正漏闭合仍报疑似输出截断", () => {
    const truncated = qingmlParse(`<table><tr><td><p>未闭合`);

    expect(truncated.warnings).toContainEqual(expect.objectContaining({
      kind: "truncated-table-structure",
      severity: "bad-block",
      detail: expect.stringContaining("疑似输出截断"),
    }));
    expect(truncated.warnings.some((warning) => warning.kind === "unsupported-nested-table")).toBe(false);
  });

  it("深度 40 的合法嵌套列表在表内外都保真", () => {
    const list = nestedListQingml(40);
    const outside = qingmlParse(list);
    const inside = qingmlParse(`<table><tr><td>${list}</td></tr></table>`);

    expect(outside.warnings.some((warning) => warning.severity === "bad-block")).toBe(false);
    expect(inside.warnings.some((warning) => warning.severity === "bad-block")).toBe(false);
    expect(maxListDepth(outside.blocks[0])).toBe(40);
    const table = inside.blocks[0];
    expect(table?.type === "table" ? maxListDepth(table.rows[0]!.cells[0]!.blocks[0]) : 0).toBe(40);
  });

  it("诊断骨架只保留有界标签形状，不泄露正文、属性或未知标签名", () => {
    const skeleton = qingmlTagSkeleton([
      "前导话\n```qingml",
      '<table data-note="客户秘密 > 不得外传"><tr><td><p title="内部标题">敏感正文',
      "<secret-project>不可恢复的内容</secret-project>",
      "</td></tr></table>\n```\n收尾散文",
    ].join(""));

    expect(skeleton).toContain("<table><tr><td><p>");
    expect(skeleton).toContain("<unknown></unknown>");
    expect(skeleton).not.toMatch(/客户秘密|内部标题|敏感正文|secret-project|不可恢复|收尾散文/);
    expect(qingmlTagSkeleton("<ul><li>a</li><li>b</li><li>c</li></ul>", 2).endsWith("…")).toBe(true);
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

  it("链接协议校验与 PM 一致，接受大写 HTTP(S) scheme", () => {
    const result = qingmlParse('<p><a href="HTTP://example.com/reference" title="来源">资料</a></p>');

    expectValidBlocks(result.blocks);
    expect(result.blocks[0]).toMatchObject({
      type: "paragraph",
      runs: [{
        text: "资料",
        marks: [{ type: "link", href: "HTTP://example.com/reference", title: "来源" }],
      }],
    });
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

  it("处理裸 <&、br、未知标签剥壳、blockquote 子块保真和纯文本", () => {
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
    expect(quote.blocks).toEqual([{
      type: "blockquote",
      blocks: [
        { type: "paragraph", runs: [{ text: "a" }] },
        { type: "paragraph", runs: [{ text: "b" }] },
      ],
    }]);
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

  it("真实模型输出仅有 document 未知外壳时剥掉一层并恢复全部块", () => {
    const result = qingmlParse(realDocumentWrapperOutput);

    expectValidBlocks(result.blocks);
    expect(result.blocks.length).toBeGreaterThanOrEqual(50);
    expect(badBlockWarnings(result)).toEqual([]);
    const recovery = result.warnings.find((warning) => warning.kind === "document-wrapper-stripped");
    expect(recovery).toMatchObject({
      severity: "harmless",
      location: {
        startOffset: expect.any(Number),
        endOffset: expect.any(Number),
      },
      diagnostic: {
        tagSkeleton: expect.stringContaining("<unknown><h1>"),
        badBlockCountBefore: expect.any(Number),
        badBlockCountAfter: 0,
      },
    });
    expect(JSON.stringify(recovery)).not.toMatch(/明清徽州|土地流转|宗族治理/);
  });

  it("未知外壳名换成 article 仍按形态剥壳，不依赖 document 标签名", () => {
    const articleWrapped = realDocumentWrapperOutput
      .replace(/^<document>/, "<article>")
      .replace(/<\/document>\s*$/, "</article>");
    const result = qingmlParse(articleWrapped);

    expectValidBlocks(result.blocks);
    expect(result.blocks.length).toBeGreaterThanOrEqual(50);
    expect(badBlockWarnings(result)).toEqual([]);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      kind: "document-wrapper-stripped",
      severity: "harmless",
    }));
  });

  it("剥掉未知外壳后 bad-block 反而增加时保留原解析结果", () => {
    const wrapped = '<article><table><tr><td colspan="0" rowspan="0"><p>正文';
    const stripped = wrapped.replace("<article>", "");
    const strippedResult = qingmlParse(stripped);
    const result = qingmlParse(wrapped);

    expect(badBlockWarnings(strippedResult).length).toBeGreaterThan(badBlockWarnings(result).length);
    expect(result.blocks).toEqual([{ type: "paragraph", runs: [{ text: "正文" }] }]);
    expect(result.warnings.some((warning) => warning.kind === "unknown-structural-tag")).toBe(true);
    expect(result.warnings.some((warning) => warning.kind === "document-wrapper-stripped")).toBe(false);

    const inlineDetails = result.warnings
      .filter((warning) => warning.kind === "inline-block-flattened")
      .map((warning) => warning.detail)
      .join("\n");
    expect(inlineDetails).toContain("<article> 内");
    expect(inlineDetails).not.toContain("<inline>");
  });

  it("无真实容器标签可报时，行内块级错误使用不指名描述而非虚构 inline 标签", () => {
    const result = qingmlParse("<li><p>越界结构</p></li>");
    const details = result.warnings
      .filter((warning) => warning.kind === "inline-block-flattened")
      .map((warning) => warning.detail)
      .join("\n");

    expect(details).toContain("顶层行内内容中出现块级/结构标签 <li>");
    expect(details).not.toContain("<inline>");
  });

  it("区分 fence/前导话无害剥壳、结构化 callout 和 CJK 空白折叠", () => {
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
    expect(badInlineOnly.blocks).toEqual([{
      type: "callout",
      blocks: [{ type: "paragraph", runs: [{ text: "块级" }] }],
    }]);
    expect(badInlineOnly.warnings.some((warning) => warning.severity === "bad-block")).toBe(false);

    const structuralUnknown = qingmlParse(`<foo><ul><li>结构</li></ul></foo>`);
    expectValidBlocks(structuralUnknown.blocks);
    expect(structuralUnknown.blocks).toEqual([{
      type: "bulletList",
      items: [{ runs: [{ text: "结构" }] }],
    }]);
    expect(badBlockWarnings(structuralUnknown)).toEqual([]);
    expect(structuralUnknown.warnings).toContainEqual(expect.objectContaining({
      kind: "document-wrapper-stripped",
      severity: "harmless",
    }));

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
    expect(row.cells).toEqual([
      { header: true, blocks: [{ type: "paragraph", runs: [{ text: "A" }] }] },
      { blocks: [{ type: "paragraph", runs: [{ text: "B" }] }] },
    ]);

    const column = qingmlParseFragment(`<table><tr><td>A1</td></tr><tr><td>A2</td></tr></table>`, "insertTableColumn");
    expect(column.ok).toBe(true);
    if (!column.ok || column.kind !== "column") throw new Error("missing column");
    expect(column.cells.every((cell) => aiTableCellSchema.safeParse(cell).success)).toBe(true);
    expect(column.cells).toEqual([
      { blocks: [{ type: "paragraph", runs: [{ text: "A1" }] }] },
      { blocks: [{ type: "paragraph", runs: [{ text: "A2" }] }] },
    ]);
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

function nestedListQingml(depth: number): string {
  let item = `<li>第 ${depth} 层</li>`;
  for (let level = depth - 1; level >= 1; level -= 1) {
    item = `<li>第 ${level} 层<ul>${item}</ul></li>`;
  }
  return `<ul>${item}</ul>`;
}

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
