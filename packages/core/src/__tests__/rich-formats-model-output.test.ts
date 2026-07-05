import { describe, expect, it, vi } from "vitest";
import {
  aiBlockSchema,
  compileAiDocumentToPm,
  pmToAiIr,
  repairAiIrShorthand,
  safeParsePmDoc,
  type AiBlock,
  type PmDoc,
} from "@qingagent/pm-schema";
import { extractJson } from "../bridge/docGenerator.js";
import { AIIR_SYSTEM_PROMPT } from "../prompts/system.js";
import {
  buildAiIrPrompt,
  buildAiIrRetryUserPrompt,
  compileAiDocumentWithBlockRetry,
  parseAiDocumentFromText,
} from "../tools/generateDoc.js";

function jsonOf(value: unknown): string {
  return JSON.stringify(value);
}

function compileOk(input: unknown): PmDoc {
  const compiled = compileAiDocumentToPm(input);
  if (!compiled.ok || !compiled.doc) {
    throw new Error(`fixture should compile: ${JSON.stringify(compiled.blockErrors)}`);
  }
  return compiled.doc;
}

function expectBlockExample(prompt: string, example: string): void {
  expect(prompt).toContain(example);
  const parsed = JSON.parse(example);
  expect(aiBlockSchema.safeParse(parsed).success).toBe(true);
}

function expectAiIrCompiles(prompt: string, example: string): void {
  expect(prompt).toContain(example);
  compileOk({ blocks: [JSON.parse(example)] });
}

function expectInlineMathRunExample(prompt: string, runs: string[]): void {
  const parsedRuns = runs.map((run) => {
    expect(prompt).toContain(run);
    return JSON.parse(run);
  });
  expect(aiBlockSchema.safeParse({ type: "paragraph", runs: parsedRuns }).success).toBe(true);
}

describe("C3 模型脏输出 -> 富格式文档管线", () => {
  const richBlocks = [
    { type: "heading", level: 1, runs: [{ text: "富格式模型输出" }] },
    {
      type: "paragraph",
      runs: [
        { text: "公式 " },
        { text: "E=mc^2", marks: [{ type: "math" }] },
        { text: " 与正文共存" },
      ],
    },
    {
      type: "taskList",
      items: [
        { checked: false, runs: [{ text: "确认 JSON 提取" }] },
        { checked: true, runs: [{ text: "确认富格式编译" }] },
      ],
    },
    { type: "callout", emoji: "!", tone: "warning", runs: [{ text: "风险提示" }] },
    { type: "blockMath", latex: "\\int_0^1 x^2 dx" },
  ];

  it("deepseek 风格脏输出样本库:可恢复形态均经真实提取与编译通过", () => {
    const baseJson = jsonOf(richBlocks);
    const bracketTextJson = jsonOf([
      { type: "paragraph", runs: [{ text: "正文字符串里含 ]} 和数组 [x]，后面还有收尾散文" }] },
      { type: "callout", tone: "info", runs: [{ text: "不要被字符串里的括号截断" }] },
    ]);
    const escapedQuoteJson = jsonOf([
      { type: "paragraph", runs: [{ text: "他说 \"不要重写解析器\"，然后继续" }] },
      { type: "blockMath", latex: "a^2+b^2=c^2" },
    ]);

    const samples = [
      { name: "```json fence 外包", raw: `\`\`\`json\n${baseJson}\n\`\`\`` },
      { name: "JSON 前导中文说明", raw: `下面是生成好的 AI-IR：\n${baseJson}` },
      { name: "JSON 后收尾散文", raw: `${baseJson}\n\n已生成，共 ${richBlocks.length} 段。`, notContains: "已生成" },
      { name: "正文字符串里含 ]}", raw: `${bracketTextJson}\n\n收尾也有 ]}。`, notContains: "收尾也有" },
      { name: "正文字符串里有转义引号", raw: `${escapedQuoteJson}\n完成。`, notContains: "完成。" },
    ];

    for (const sample of samples) {
      const extracted = extractJson(sample.raw);
      if (sample.notContains) expect(extracted).not.toContain(sample.notContains);
      expect(() => JSON.parse(extracted), sample.name).not.toThrow();

      const parsed = parseAiDocumentFromText(sample.raw, sample.name);
      const doc = compileOk(parsed);
      expect(safeParsePmDoc(doc).success, sample.name).toBe(true);
    }
  });

  it("deepseek 风格脏输出样本库:尾逗号可修复,截断重试拼接明确失败", () => {
    const retryJson = jsonOf([{ type: "paragraph", runs: [{ text: "第二轮完整稿" }] }]);
    const truncated = '[{"type":"paragraph","runs":[{"text":"第一轮半截"}]';
    const trailingComma = '[{"type":"paragraph","runs":[{"text":"尾逗号"}]},]';
    const extractedTrailingComma = extractJson(trailingComma);
    expect(extractedTrailingComma).toContain(",]");
    expect(() => JSON.parse(extractedTrailingComma)).toThrow();
    expect(parseAiDocumentFromText(trailingComma, "尾逗号").blocks).toHaveLength(1);

    const joinedRetry = `${truncated}\n\n第二次重试输出:\n${retryJson}`;
    const extractedJoinedRetry = extractJson(joinedRetry);
    expect(extractedJoinedRetry).toContain("第二次重试输出");
    expect(() => JSON.parse(extractedJoinedRetry)).toThrow();
    expect(() => parseAiDocumentFromText(joinedRetry, "截断后把第二轮输出拼在同一日志里")).toThrow();

    const retryPrompt = buildAiIrRetryUserPrompt("标题: 截断重试", 1, "Unexpected end of JSON input");
    expect(retryPrompt).toContain("完整、闭合");
    expect(retryPrompt).toContain("不要输出 markdown fence");
    expect(parseAiDocumentFromText(retryJson, "第二轮完整稿").blocks).toHaveLength(1);
  });

  it("富格式简写修复:taskList 裸 run[][]、裸布尔 bold、裸 href 进入 PM 后不丢语义", () => {
    const input = {
      blocks: [
        {
          type: "taskList",
          items: [
            [{ text: "裸数组任务保留加粗", bold: true }],
            { checked: true, runs: [{ text: "裸 href 链接", href: "https://example.com/task" }] },
          ],
        },
      ],
    };

    const repaired = repairAiIrShorthand(input) as any;
    expect(repaired.blocks[0].items[0]).toEqual({
      checked: false,
      runs: [{ text: "裸数组任务保留加粗", marks: [{ type: "bold" }] }],
    });
    expect(repaired.blocks[0].items[1].runs[0]).toEqual({
      text: "裸 href 链接",
      marks: [{ type: "link", href: "https://example.com/task" }],
    });

    const doc = compileOk(input);
    const taskList = doc.content[0] as any;
    expect(taskList.type).toBe("taskList");
    expect(taskList.content[0].attrs.checked).toBe(false);
    expect(taskList.content[0].content[0].content[0].marks).toEqual([{ type: "bold" }]);
    expect(taskList.content[1].attrs.checked).toBe(true);
    expect(taskList.content[1].content[0].content[0].marks).toEqual([
      { type: "link", attrs: { href: "https://example.com/task" } },
    ]);
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

  it("buildAiIrPrompt 富格式提示词契约:新块说明与示例 JSON 合法", () => {
    const prompt = buildAiIrPrompt("");

    expect(prompt).toContain("taskList");
    expect(prompt).toContain("callout");
    expect(prompt).toContain("blockMath");
    expect(prompt).toContain("columnList");
    expect(prompt).toContain("行内公式：用 math mark 表示");
    expect(prompt).toContain("用户要求\"提示框/注意/风险/结论卡片/高亮框/强调块\"时必须用 callout");
    expect(prompt).toContain("多级清单必须用 children 递归表达");
    expect(prompt).toContain("必须真的出现 children 子列表");
    expect(prompt).toContain("正文字符串里严禁裸半角双引号");
    expect(prompt).toContain("用户要求分栏/双栏/三栏/左右对照时必须用真实 columnList");
    expect(prompt).not.toContain("嵌套有序列表支持另行立项");
    expect(prompt).not.toContain("不要输出递归嵌套结构");
    expect(prompt).not.toContain("不支持分栏");

    expectBlockExample(prompt, '{"type":"taskList","items":[{"checked":false,"runs":[{"text":"父任务"}],"children":[{"type":"taskList","items":[{"checked":false,"runs":[{"text":"子任务"}]},{"checked":true,"runs":[{"text":"已完成子任务"}]}]}]}]}');
    expectBlockExample(prompt, '{"type":"callout","emoji":"💡","tone":"info","runs":[{"text":"提示内容"}]}');
    expectAiIrCompiles(prompt, '{"type":"bulletList","items":[{"runs":[{"text":"一级阶段"}],"children":[{"type":"bulletList","items":[{"runs":[{"text":"二级任务"}],"children":[{"type":"bulletList","items":[{"runs":[{"text":"三级检查点"}]}]}]}]}]}]}');
    expectBlockExample(prompt, '{"type":"columnList","columns":[{"widthRatio":0.5,"blocks":[{"type":"heading","level":3,"runs":[{"text":"左栏"}]},{"type":"paragraph","runs":[{"text":"左栏内容"}]}]},{"widthRatio":0.5,"blocks":[{"type":"heading","level":3,"runs":[{"text":"右栏"}]},{"type":"paragraph","runs":[{"text":"右栏内容"}]}]}]}');
    expectBlockExample(prompt, '{"type":"blockMath","latex":"E = mc^2"}');
    expectInlineMathRunExample(prompt, [
      '{"text":"质能方程 ","marks":[]}',
      '{"text":"E=mc^2","marks":[{"type":"math"}]}',
    ]);
  });

  it("system.ts 编辑提示词契约:高级块类型章节存在且示例合法", () => {
    expect(AIIR_SYSTEM_PROMPT).toContain("## 高级块类型");
    expect(AIIR_SYSTEM_PROMPT).toContain("待办清单 taskList");
    expect(AIIR_SYSTEM_PROMPT).toContain("高亮框 callout");
    expect(AIIR_SYSTEM_PROMPT).toContain("块级公式 blockMath");
    expect(AIIR_SYSTEM_PROMPT).toContain("行内公式");
    expect(AIIR_SYSTEM_PROMPT).toContain("math 不能与其他 mark 混用");

    expectBlockExample(AIIR_SYSTEM_PROMPT, '{"type":"taskList","items":[{"checked":false,"runs":[{"text":"待办项"}]}]}');
    expectBlockExample(AIIR_SYSTEM_PROMPT, '{"type":"callout","emoji":"💡","tone":"info","runs":[{"text":"内容"}]}');
    expectBlockExample(AIIR_SYSTEM_PROMPT, '{"type":"blockMath","latex":"E = mc^2"}');
    expectInlineMathRunExample(AIIR_SYSTEM_PROMPT, ['{"text":"E=mc^2","marks":[{"type":"math"}]}']);
  });

  it("端到端:带 fence 与收尾散文的完整富格式输出走提取、修复、编译、PM 校验和回转", () => {
    const modelBlocks = [
      { type: "heading", level: 1, runs: [{ text: "上线前核对" }] },
      {
        type: "paragraph",
        runs: [
          { text: "上线前核对 " },
          { text: "E=mc^2", marks: [{ type: "math" }] },
          { text: "，参考 " },
          { text: "模型笔记", href: "https://example.com/deepseek", bold: true },
        ],
      },
      {
        type: "taskList",
        items: [
          [{ text: "保留真实提取函数", bold: true }],
          { checked: true, runs: [{ text: "记录 Feishu bug", href: "#bugs" }] },
        ],
      },
      {
        type: "callout",
        emoji: "!",
        tone: "warning",
        runs: [{ text: "正文里有转义引号 \"AI-IR\"，也有 ]} 符号" }],
      },
      { type: "blockMath", latex: "\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}" },
    ];
    const raw = `模型输出如下：\n\`\`\`json\n${jsonOf(modelBlocks)}\n\`\`\`\n已生成，共 5 个富格式块。`;

    const extracted = extractJson(raw);
    expect(JSON.parse(extracted)).toEqual(modelBlocks);

    const parsed = parseAiDocumentFromText(raw, "完整富格式样本");
    const repaired = repairAiIrShorthand(parsed);
    const doc = compileOk(repaired);
    expect(safeParsePmDoc(doc).success).toBe(true);

    const roundTrip = pmToAiIr(doc);
    expect(roundTrip.blocks).toEqual([
      { type: "heading", level: 1, runs: [{ text: "上线前核对" }] },
      {
        type: "paragraph",
        runs: [
          { text: "上线前核对 " },
          { text: "E=mc^2", marks: [{ type: "math" }] },
          { text: "，参考 " },
          {
            text: "模型笔记",
            marks: [
              { type: "link", href: "https://example.com/deepseek" },
              { type: "bold" },
            ],
          },
        ],
      },
      {
        type: "taskList",
        items: [
          { checked: false, runs: [{ text: "保留真实提取函数", marks: [{ type: "bold" }] }] },
          { checked: true, runs: [{ text: "记录 Feishu bug", marks: [{ type: "link", href: "#bugs" }] }] },
        ],
      },
      {
        type: "callout",
        emoji: "!",
        tone: "warning",
        runs: [{ text: "正文里有转义引号 \"AI-IR\"，也有 ]} 符号" }],
      },
      { type: "blockMath", latex: "\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}" },
    ] satisfies AiBlock[]);
  });
});
