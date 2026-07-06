import {
  askUserNoReaskScorer,
  askUserWriteDraftFollowthroughScorer,
  type AskUserActionOutput,
  type AskUserAnswerWordingInput,
} from "./askUserScorers.js";
import {
  editDraftStructParseScorer,
  type EditDraftStructOutput,
} from "./editDraftStructScorers.js";
import type { OfflineScorerFixture, OfflineScorerSuite } from "./types.js";
import { aiBlockToQingml, type AiBlock } from "@qingagent/pm-schema";

const askUserFixtureInputs: AskUserAnswerWordingInput[] = [
  {
    toolCallId: "eval-wwdc-deep-analysis",
    request: "创建一篇文章,记录一下",
    answers: {
      "q-topic": { chosen: [], freeText: "2026WWDC发布会" },
      "q-style": { chosen: ["深度商业分析(虎嗅风)"], freeText: null },
      "q-reader": { chosen: ["大众读者"], freeText: null },
      "q-length": { chosen: ["长文(3000字+)"], freeText: null },
    },
  },
  {
    toolCallId: "eval-travel-essay",
    request: "帮我写篇游记",
    answers: {
      "q-topic": { chosen: [], freeText: "杭州西湖春游,白堤苏堤一日" },
      "q-style": { chosen: ["散文抒情"], freeText: null },
      "q-length": { chosen: ["中等(1500字左右)"], freeText: null },
    },
  },
  {
    toolCallId: "eval-product-launch",
    request: "写一篇产品发布稿",
    answers: {
      "q-topic": { chosen: [], freeText: "DeepSeek V4 系列大模型发布" },
      "q-style": { chosen: ["科技媒体报道"], freeText: "要有数据支撑" },
      "q-reader": { chosen: ["开发者"], freeText: null },
    },
  },
  {
    toolCallId: "eval-work-summary",
    request: "帮我写个总结",
    answers: {
      "q-topic": { chosen: [], freeText: "2026上半年个人工作总结,后端开发方向" },
      "q-style": { chosen: ["正式汇报"], freeText: null },
      "q-length": { chosen: ["短(800字)"], freeText: null },
    },
  },
  {
    toolCallId: "eval-wechat-article",
    request: "写公众号文章",
    answers: {
      "q-topic": { chosen: [], freeText: "AI 编程助手怎么选" },
      "q-style": { chosen: ["轻松口语化"], freeText: "标题要有冲突感" },
      "q-reader": { chosen: ["普通上班族"], freeText: null },
      "q-length": { chosen: ["中等(1500字左右)"], freeText: null },
    },
  },
];

const askUserOutput: AskUserActionOutput = { toolNames: ["writeDraft"], text: "" };

export const askUserAnswerWordingFixtures: OfflineScorerFixture<AskUserAnswerWordingInput, AskUserActionOutput>[] =
  askUserFixtureInputs.map((input) => ({
    id: input.toolCallId,
    source: input.toolCallId === "eval-wwdc-deep-analysis"
      ? "eval-askuser-answer-wording.ts:SAMPLES/wwdc-deep-analysis; 实锤会话 a922cb8a 答案形态"
      : "eval-askuser-answer-wording.ts:SAMPLES",
    input,
    output: askUserOutput,
  }));

function op(rawOp: Record<string, unknown>): string {
  return JSON.stringify({ ops: [rawOp] });
}

function blockQingml(block: Record<string, unknown>): string {
  return aiBlockToQingml(block as AiBlock);
}

function tableBlock(): Record<string, unknown> {
  const cell = (text: string, header = false) => ({
    ...(header ? { header: true } : {}),
    runs: [{ text }],
  });
  return {
    type: "table",
    rows: [
      { cells: [cell("维度", true), cell("V2.6", true), cell("V2.7", true)] },
      { cells: [cell("性能"), cell("稳定"), cell("更快")] },
      { cells: [cell("稳定性"), cell("普通"), cell("提升")] },
      { cells: [cell("新特性"), cell("少"), cell("更多")] },
    ],
  };
}

function taskList(items: string[]): Record<string, unknown> {
  return {
    type: "taskList",
    items: items.map((text) => ({ checked: false, runs: [{ text }] })),
  };
}

function nestedList(): Record<string, unknown> {
  return {
    type: "bulletList",
    items: [
      {
        runs: [{ text: "表现层" }],
        children: [{
          type: "bulletList",
          items: [{
            runs: [{ text: "Web" }],
            children: [{ type: "bulletList", items: [{ runs: [{ text: "React" }] }] }],
          }],
        }],
      },
      {
        runs: [{ text: "服务层" }],
        children: [{
          type: "bulletList",
          items: [{
            runs: [{ text: "API" }],
            children: [{ type: "bulletList", items: [{ runs: [{ text: "鉴权" }] }] }],
          }],
        }],
      },
    ],
  };
}

export const editDraftStructFixtures: OfflineScorerFixture<undefined, EditDraftStructOutput>[] = [
  {
    id: "struct-insert-table",
    source: "eval-editdraft-struct.ts:SCENARIOS/insert-table",
    output: {
      scenarioKey: "insert-table",
      raw: op({ action: "insertBlock", position: "after", ref: "para-compare", blocks: blockQingml(tableBlock()) }),
    },
  },
  {
    id: "struct-expand-faq",
    source: "eval-editdraft-struct.ts:SCENARIOS/expand-faq",
    output: {
      scenarioKey: "expand-faq",
      raw: op({
        action: "replaceBlock",
        ref: "faq-list",
        block: blockQingml({
          type: "orderedList",
          items: ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"].map((text) => ({ runs: [{ text }] })),
        }),
      }),
    },
  },
  {
    id: "struct-add-checklist-fenced",
    source: "eval-editdraft-struct.ts:SCENARIOS/add-checklist; v17-c2/v20-c2 结构失败族回归",
    output: {
      scenarioKey: "add-checklist",
      raw: ["```json", op({
        action: "insertBlock",
        position: "after",
        ref: "para-actions",
        blocks: blockQingml(taskList(["制定计划", "分配负责人", "设定截止", "复盘"])),
      }), "```"].join("\n"),
    },
  },
  {
    id: "struct-insert-nested-deep",
    source: "eval-editdraft-struct.ts:SCENARIOS/insert-nested-deep",
    output: {
      scenarioKey: "insert-nested-deep",
      raw: `这是结构编辑 JSON:\n${op({
        action: "insertBlock",
        position: "after",
        ref: "para-arch2",
        blocks: blockQingml(nestedList()),
      })}\n已完成。`,
    },
  },
  {
    id: "struct-insert-callout",
    source: "eval-editdraft-struct.ts:SCENARIOS/insert-callout",
    output: {
      scenarioKey: "insert-callout",
      raw: op({
        action: "insertBlock",
        position: "after",
        ref: "para-warn",
        blocks: blockQingml({ type: "callout", tone: "warning", runs: [{ text: "注意数据备份与权限。" }] }),
      }),
    },
  },
  {
    id: "struct-long-task-list",
    source: "eval-editdraft-struct.ts:SCENARIOS/long-taskList; 深括号压力回归",
    output: {
      scenarioKey: "long-taskList",
      raw: op({
        action: "insertBlock",
        position: "after",
        ref: "para-plan",
        blocks: blockQingml(taskList(["立项", "调研", "设计", "开发", "测试", "上线"])),
      }),
    },
  },
  {
    id: "struct-nested-3level",
    source: "eval-editdraft-struct.ts:SCENARIOS/nested-3level",
    output: {
      scenarioKey: "nested-3level",
      raw: op({ action: "replaceBlock", ref: "para-org", block: blockQingml(nestedList()) }),
    },
  },
];

export function getOfflineScorerSuites(options: {
  includeBadFixture?: boolean;
} = {}): OfflineScorerSuite[] {
  const structFixtures = [...editDraftStructFixtures];
  if (options.includeBadFixture) {
    structFixtures.push({
      id: "injected-bad-editdraft-struct",
      source: "QINGAGENT_SCORER_INJECT_BAD_FIXTURE=1 自测负例",
      output: {
        scenarioKey: "insert-callout",
        raw: op({
          action: "insertBlock",
          position: "after",
          ref: "para-risk",
          blocks: "<callout><p>块级越界</p></callout>",
        }),
      },
    });
  }

  return [
    {
      id: "askuser-no-reask",
      description: "eval-askuser-answer-wording.ts 防回问/表单话术断言",
      scorer: askUserNoReaskScorer,
      fixtures: askUserAnswerWordingFixtures,
      threshold: 1,
    },
    {
      id: "askuser-write-draft-followthrough",
      description: "eval-askuser-answer-wording.ts writeDraft 后续动作断言",
      scorer: askUserWriteDraftFollowthroughScorer,
      fixtures: askUserAnswerWordingFixtures,
      threshold: 1,
    },
    {
      id: "editdraft-struct-parse",
      description: "eval-editdraft-struct.ts QingML 结构化解析回归",
      scorer: editDraftStructParseScorer,
      fixtures: structFixtures,
      threshold: 1,
    },
  ];
}
