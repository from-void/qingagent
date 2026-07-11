import { describe, expect, it, vi } from "vitest";
import {
  aiBlockSchema,
  compileAiDocumentToPm,
  pmToAiIr,
  qingmlParse,
  safeParsePmDoc,
  type AiBlock,
  type PmDoc,
} from "@qingagent/pm-schema";
import { AIIR_SYSTEM_PROMPT } from "../prompts/system.js";
import {
  compileAiDocumentWithBlockRetry,
  parseAiDocumentFromQingml,
} from "../tools/generateDoc.js";

function compileOk(input: unknown): PmDoc {
  const compiled = compileAiDocumentToPm(input);
  if (!compiled.ok || !compiled.doc) {
    throw new Error(`fixture should compile: ${JSON.stringify(compiled.blockErrors)}`);
  }
  return compiled.doc;
}

function expectQingmlExample(prompt: string, example: string): void {
  expect(prompt).toContain(example);
  const parsed = qingmlParse(example);
  expect(parsed.warnings.filter((warning) => warning.severity === "bad-block")).toEqual([]);
  expect(parsed.blocks.length).toBeGreaterThan(0);
}

const alignMathBlockExample = [
  "<math-block>\\begin{align}",
  "\\nabla \\cdot \\mathbf{E} &amp;= \\frac{\\rho}{\\varepsilon_0} \\\\",
  "\\nabla \\times \\mathbf{B} &amp;= \\mu_0\\mathbf{J}+\\mu_0\\varepsilon_0\\frac{\\partial \\mathbf{E}}{\\partial t}",
  "\\end{align}</math-block>",
].join("\n");

describe("C3 QingML 富格式文档管线", () => {
  it("模型脏输出样本库: fence、前导话、收尾散文经 QingML 解析与编译通过", () => {
    const samples = [
      { name: "```qingml fence 外包", raw: "```qingml\n<h1>富格式模型输出</h1><p>正文</p>\n```" },
      { name: "QingML 前导中文说明", raw: "下面是生成好的内容:\n<h1>富格式模型输出</h1><p>正文</p>" },
      { name: "QingML 后收尾散文", raw: "<h1>富格式模型输出</h1><p>正文</p>\n\n已生成。" },
      {
        name: "正文里含裸尖括号和实体",
        raw: "<p>代码条件 a &lt; b &amp;&amp; ok，正文裸 <&; 继续</p><callout tone=\"info\">提示</callout>",
      },
    ];

    for (const sample of samples) {
      const parsed = parseAiDocumentFromQingml(sample.raw, sample.name);
      const doc = compileOk(parsed.document);
      expect(safeParsePmDoc(doc).success, sample.name).toBe(true);
    }
  });

  it("富格式语义陷阱:math mark 覆盖整 run,含普通中文时当前会整体编成 inlineMath", () => {
    const doc = compileOk({
      blocks: [
        {
          type: "paragraph",
          runs: [{ text: "E=mc^2 很重要", marks: [{ type: "math" }] }],
        },
      ],
    });

    expect(doc.content[0]).toMatchObject({
      type: "paragraph",
      content: [{ type: "inlineMath", attrs: { latex: "E=mc^2 很重要" } }],
    });
    expect(pmToAiIr(doc).blocks[0]).toEqual({
      type: "paragraph",
      runs: [{ text: "E=mc^2 很重要", marks: [{ type: "math" }] }],
    });
  });

  it("富格式块级重试:只替换失败的 callout 块,保留其余已解析块", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const result = await compileAiDocumentWithBlockRetry(
        {
          title: "块级重试",
          blocks: [
            { type: "paragraph", runs: [{ text: "保留段落" }] },
            { type: "callout", tone: "urgent", runs: [{ text: "非法 tone" }] },
            { type: "blockMath", latex: "x+y=z" },
          ],
        },
        async ({ index, previousBlock }) => {
          expect(index).toBe(1);
          expect(previousBlock).toMatchObject({ type: "callout", tone: "urgent" });
          return { type: "callout", tone: "warning", runs: [{ text: "已修正 tone" }] };
        },
        1,
      );

      expect(result.success).toBe(true);
      if (!result.success) throw new Error(result.error);
      expect(result.doc.content.map((block) => block.type)).toEqual(["paragraph", "callout", "blockMath"]);
      expect(result.doc.content[1]).toMatchObject({ type: "callout", attrs: { tone: "warning" } });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("主 system 富格式提示词契约:高级块说明与示例可解析", () => {
    const prompt = AIIR_SYSTEM_PROMPT;

    expect(prompt).toContain("任务清单 <tasks>");
    expect(prompt).toContain("提示框 <callout");
    expect(prompt).toContain("块级公式 <math-block>");
    expect(prompt).toContain("分栏 <columns>");
    expect(prompt).toContain("行内公式 <math>");
    expect(prompt).toContain("## 展示公式硬规则");
    expect(prompt).toContain("绝不把这类公式写成普通 <p> 段落文本");
    expect(prompt).toContain("多级列表必须用 <li> 内嵌子 <ul>/<ol>");
    expect(prompt).toContain("分栏必须用 <columns>");
    expect(prompt).toContain('<td><p>结论</p><ul><li>依据</li></ul></td>');
    expect(prompt).toContain("td/th 内可放 p/ul/ol/tasks/callout");
    expect(prompt).toContain("bg、colspan、rowspan 在改写已有表格时照抄");
    expect(prompt).toContain("列宽由系统自动保留");
    expect(prompt).not.toContain("表格单元格、callout、blockquote 内只放文字与行内标记");
    expect(prompt).not.toContain("items+depth");
    expect(prompt).not.toContain("必须用扁平");

    expectQingmlExample(prompt, "<tasks><task checked>已完成</task><task>未完成</task></tasks>");
    expectQingmlExample(prompt, "<callout emoji=\"💡\" tone=\"info\">提示内容</callout>");
    expectQingmlExample(prompt, "<math-block>E=mc^2</math-block>");
    expectQingmlExample(prompt, alignMathBlockExample);
    expectQingmlExample(prompt, "<columns><column ratio=\"0.5\"><p>左栏</p></column><column ratio=\"0.5\"><p>右栏</p></column></columns>");
  });

  it("system.ts 编辑提示词契约:高级块类型章节存在且示例合法", () => {
    expect(AIIR_SYSTEM_PROMPT).toContain("## 高级块类型");
    expect(AIIR_SYSTEM_PROMPT).toContain("待办清单 taskList");
    expect(AIIR_SYSTEM_PROMPT).toContain("高亮框 callout");
    expect(AIIR_SYSTEM_PROMPT).toContain("块级公式 blockMath");
    expect(AIIR_SYSTEM_PROMPT).toContain("展示公式硬规则");
    expect(AIIR_SYSTEM_PROMPT).toContain("\\begin{align|aligned|equation|gather");
    expect(AIIR_SYSTEM_PROMPT).toContain("绝不把这类公式写成普通 <p> 段落文本");
    expect(AIIR_SYSTEM_PROMPT).toContain("行内公式");
    expect(AIIR_SYSTEM_PROMPT).toContain("math 不能与其他 mark 混用");

    expectQingmlExample(AIIR_SYSTEM_PROMPT, "<tasks><task>待办项</task></tasks>");
    expectQingmlExample(AIIR_SYSTEM_PROMPT, "<callout emoji=\"💡\" tone=\"info\">内容</callout>");
    expectQingmlExample(AIIR_SYSTEM_PROMPT, "<math-block>E = mc^2</math-block>");
    expectQingmlExample(AIIR_SYSTEM_PROMPT, alignMathBlockExample);
    expectQingmlExample(AIIR_SYSTEM_PROMPT, "<math>E=mc^2</math>");
  });

  it("端到端:完整富格式 QingML 输出解析、PM 校验和回转", () => {
    const raw = [
      "<h1>上线前核对</h1>",
      "<p>上线前核对 <math>E=mc^2</math>，参考 <a href=\"https://example.com/deepseek\"><b>模型笔记</b></a></p>",
      "<tasks><task>保留真实 QingML 解析函数</task><task checked>记录回归样本</task></tasks>",
      "<callout emoji=\"!\" tone=\"warning\">正文里有 ]} 符号也只是正文</callout>",
      "<math-block>\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}</math-block>",
    ].join("");

    const parsed = parseAiDocumentFromQingml(raw, "完整富格式样本");
    for (const block of parsed.document.blocks) {
      expect(aiBlockSchema.safeParse(block).success).toBe(true);
    }
    const doc = compileOk(parsed.document);
    expect(safeParsePmDoc(doc).success).toBe(true);

    const roundTrip = pmToAiIr(doc);
    expect(roundTrip.blocks.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "taskList",
      "callout",
      "blockMath",
    ]);
    expect(roundTrip.blocks[1]).toMatchObject({
      type: "paragraph",
      runs: expect.arrayContaining([
        { text: "E=mc^2", marks: [{ type: "math" }] },
        {
          text: "模型笔记",
          marks: [
            { type: "link", href: "https://example.com/deepseek" },
            { type: "bold" },
          ],
        },
      ]),
    } satisfies Partial<AiBlock>);
  });
});
