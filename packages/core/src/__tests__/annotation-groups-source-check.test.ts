import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ReviewContext } from "@qingagent/contract-ts";
import type { Material } from "../types/material.js";
import { createSession } from "../session/sessionState.js";
import { createSessionScopedTools } from "../session/sessionTools.js";
import { annotationGroupsParseFailureInput } from "../tools/annotationGroups.js";
import {
  insertAnnotationGroups,
  replaceAnnotationGroupsByOrigin,
} from "@qingagent/db";

vi.mock("@qingagent/db", () => ({
  resolveDbUrl: () => "file::memory:",
  STYLE_TEMPLATE_DTYPES: ["gzh", "xhs", "translate", "deai"],
  insertAnnotationGroups: vi.fn(async () => undefined),
  replaceAnnotationGroupsByOrigin: vi.fn(async () => undefined),
}));

const ctx = {} as never;

interface GroupInput {
  summary: string;
  note: string;
  origin: string;
  judgment?: "口径漂移" | "数字失真" | "无据" | "素材遗漏" | "时间线" | "数字" | "称谓与术语" | "论断";
  materialQuote?: string;
  checkedScope?: string;
  documentQuote?: string;
  suggestion?: string;
  severity?: "error" | "warn" | "info";
  anchors: Array<{ find: string; all?: boolean }>;
}

function reviewCtx(reviewContext: ReviewContext) {
  return {
    requestContext: {
      get: (key: string) => key === "reviewContext" ? reviewContext : undefined,
    },
  } as never;
}

function turnCtx(owner: string, generation: number) {
  return {
    requestContext: {
      get: (key: string) => {
        if (key === "qingagentTurnOwner") return owner;
        if (key === "qingagentTurnGeneration") return generation;
        return undefined;
      },
    },
  } as never;
}

function material(id: string, text: string, summary = "无关摘要"): Material {
  return {
    id,
    filename: `${id}.txt`,
    mimeType: "text/plain",
    text,
    summary,
    fileId: null,
    metadata: { pages: null, wordCount: text.length, title: null },
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
  };
}

function setup() {
  const state = createSession("source-check-test");
  state.doc = {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "paragraph",
      attrs: { blockId: "p-1" },
      content: [{ type: "text", text: "报告称收入为130亿元。" }],
    }],
  };
  state.materials.set("mat-1", material("mat-1", "财报显示，收入为 120\n亿元，同比增长 8%。"));
  state.materials.set("mat-2", material("mat-2", "另一份素材全文。", "收入为130亿元"));
  return { state, tool: createSessionScopedTools(state).createAnnotationGroups };
}

function group(overrides: Partial<GroupInput> = {}): GroupInput {
  return {
    summary: "收入数字与素材不符",
    note: "正文数字高于财报口径。",
    origin: "source-check",
    judgment: "数字失真",
    materialQuote: "收入为 120亿元",
    anchors: [{ find: "收入为130亿元" }],
    ...overrides,
  };
}

describe("create_annotation_groups 来源引句校验", () => {
  beforeEach(() => vi.clearAllMocks());

  it("summary schema 只提示短标题，不再用 15 字硬校验触发工具重试", () => {
    const { tool } = setup();
    const jsonSchema = z.toJSONSchema(tool.inputSchema as z.ZodType);
    expect(JSON.stringify(jsonSchema)).toContain("变更类型短标题");
    expect(JSON.stringify(jsonSchema)).toContain("建议≤15字");
    expect(JSON.stringify(jsonSchema)).toContain("细节解释一律写进 note");
    expect(JSON.stringify(jsonSchema)).not.toContain('"maxLength":15');
  });

  it("超长 summary 通过工具校验并由服务端按 15 字截断", async () => {
    const { state, tool } = setup();
    const summary = "这是一个明显超过十五个字但内容本身完全有效的批注摘要";

    const result = await tool.execute!({
      groups: [group({ origin: "privacy", summary })],
    }, ctx);

    expect(result).toMatchObject({ ok: true, groupCount: 1, errors: [] });
    expect(state.annotationGroups[0]?.summary).toBe(Array.from(summary).slice(0, 15).join(""));
  });

  it("不建议改写时丢弃与批注原因重复的 suggestion", async () => {
    const { state, tool } = setup();
    const note = "改写会丢失具体违规词、破坏取证原意，故不提供整句替换建议。";

    const result = await tool.execute!({
      groups: [group({
        origin: "sensitive",
        summary: "最低价·取证转述语境",
        note,
        suggestion: note,
        anchors: [{ find: "收入为130亿元" }],
      })],
    }, reviewCtx({
      type: "sensitive",
      templateId: "review-sensitive-default",
      templateName: "标准敏感词审查",
    }));

    expect(result).toMatchObject({ ok: true, groupCount: 1, errors: [] });
    expect(state.annotationGroups[0]?.note).toBe(note);
    expect(state.annotationGroups[0]?.suggestion).toBeUndefined();
    expect(replaceAnnotationGroupsByOrigin).toHaveBeenCalledWith(
      state.docId,
      state.docVersion,
      [expect.not.objectContaining({ suggestion: expect.any(String) })],
    );
  });

  it("隐私批注在工具唯一生产入口先打码再进入运行态和持久化", async () => {
    const { state, tool } = setup();
    state.doc!.content = [{
      type: "paragraph",
      attrs: { blockId: "p-contact" },
      content: [{ type: "text", text: "手机 13912345678，卡号 6222020200112345678，邮箱 zhangwei@example.com。" }],
    }];

    const result = await tool.execute!({
      groups: [group({
        origin: "模型错填",
        summary: "手机号 13912345678 未脱敏",
        note: "「13912345678」是完整手机号，zhangwei@example.com 也是完整邮箱。",
        suggestion: "改为 139****5678，并隐藏 zhangwei@example.com。",
        anchors: [{ find: "13912345678" }],
      })],
    }, reviewCtx({
      type: "privacy",
      templateId: "review-privacy-default",
      templateName: "对外发布",
    }));

    expect(result).toMatchObject({ ok: true, groupCount: 1, anchorCount: 1, errors: [] });
    const runtimeGroup = state.annotationGroups[0]!;
    expect(runtimeGroup).toMatchObject({
      origin: "privacy",
      summary: "手机号 139****5678",
      note: "「139****5678」是完整手机号，zha***@example.com 也是完整邮箱。",
      suggestion: "改为 139****5678，并隐藏 zha***@example.com。",
      anchors: [{
        quote: "139****5678",
        textHash: "span:p-contact:4:15",
      }],
    });
    expect(replaceAnnotationGroupsByOrigin).toHaveBeenCalledWith(
      state.docId,
      state.docVersion,
      [runtimeGroup],
    );
    expect(JSON.stringify(runtimeGroup)).not.toContain("13912345678");
    expect(JSON.stringify(runtimeGroup)).not.toContain("zhangwei@example.com");
  });

  it("全角引号锚句在精确失败后经归一化二次匹配命中", async () => {
    const { state, tool } = setup();
    state.doc!.content = [{
      type: "paragraph",
      attrs: { blockId: "p-quote" },
      content: [{ type: "text", text: "她只说：“别相信她”。" }],
    }];

    const result = await tool.execute!({
      groups: [group({
        origin: "privacy",
        anchors: [{ find: "「别相信她」" }],
      })],
    }, ctx);

    expect(result).toMatchObject({ ok: true, groupCount: 1, anchorCount: 1, errors: [] });
    expect(state.annotationGroups[0]?.anchors[0]?.quote).toBe("“别相信她”");
  });

  it("引文命中任一素材原文时通过并拼入 note", async () => {
    const { state, tool } = setup();
    const result = await tool.execute!({ groups: [group()] }, ctx) as {
      ok: boolean; groupCount: number; anchorCount: number; errors: string[];
    };

    expect(result).toMatchObject({ ok: true, groupCount: 1, anchorCount: 1, errors: [] });
    expect(state.annotationGroups[0]?.note).toBe("正文数字高于财报口径。\n素材原句：收入为 120亿元");
  });

  it("同 origin 新轮次只替换自身，不影响其他来源", async () => {
    const { state, tool } = setup();
    await tool.execute!({ groups: [group()] }, ctx);
    const firstSourceId = state.annotationGroups[0]?.id;

    await tool.execute!({ groups: [group({ origin: "privacy", summary: "隐私问题" })] }, ctx);
    expect(state.annotationGroups.map((item) => item.origin).sort()).toEqual(["privacy", "source-check"]);

    state._annotationOriginsReplacedThisTurn = new Set();
    await tool.execute!({ groups: [group({ summary: "来源复核新结果" })] }, ctx);
    expect(state.annotationGroups).toHaveLength(2);
    expect(state.annotationGroups.filter((item) => item.origin === "privacy")).toHaveLength(1);
    expect(state.annotationGroups.find((item) => item.origin === "source-check")?.id).not.toBe(firstSourceId);
    expect(state._annotationOriginsReplacedThisTurn).toEqual(new Set(["source-check"]));
  });

  it("同轮同 origin 分批创建时首批换代旧轮、后批追加且两批均保留", async () => {
    const { state, tool } = setup();

    await tool.execute!({
      groups: [group({ summary: "第一批来源问题" })],
    }, ctx);
    await tool.execute!({
      groups: [group({ summary: "第二批来源问题" })],
    }, ctx);

    expect(state.annotationGroups.map((item) => item.summary)).toEqual([
      "第一批来源问题",
      "第二批来源问题",
    ]);
    expect(vi.mocked(replaceAnnotationGroupsByOrigin)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(insertAnnotationGroups)).toHaveBeenCalledTimes(1);
  });

  it("旧轮写入在持久化阻塞后不得回填运行态，排队旧写不得触达数据库", async () => {
    const { state, tool } = setup();
    state._turnOwner = "review-turn";
    state._turnGeneration = 1;

    let releasePersistence!: () => void;
    const persistenceBlocked = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    let notifyPersistenceStarted!: () => void;
    const persistenceStarted = new Promise<void>((resolve) => {
      notifyPersistenceStarted = resolve;
    });
    vi.mocked(replaceAnnotationGroupsByOrigin).mockImplementationOnce(async () => {
      notifyPersistenceStarted();
      await persistenceBlocked;
    });

    const first = tool.execute!({
      groups: [group({ summary: "旧轮首批问题" })],
    }, turnCtx("review-turn", 1));
    await persistenceStarted;
    const queued = tool.execute!({
      groups: [group({ summary: "旧轮排队问题" })],
    }, turnCtx("review-turn", 1));

    state._turnGeneration = 2;
    releasePersistence();

    const settled = await Promise.allSettled([first, queued]);
    expect(settled.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    for (const result of settled) {
      expect(result.status === "rejected" ? result.reason : null).toMatchObject({
        name: "AbortError",
      });
    }
    expect(replaceAnnotationGroupsByOrigin).toHaveBeenCalledTimes(1);
    expect(insertAnnotationGroups).not.toHaveBeenCalled();
    expect(state.annotationGroups).toEqual([]);
    expect(state._annotationOriginsReplacedThisTurn).toBeUndefined();
  });

  it("八类菜单审查均按结构化上下文强制 origin，忽略模型错填", async () => {
    const cases: Array<{ context: ReviewContext; expected: string; overrides?: Partial<GroupInput> }> = [
      { context: { type: "sensitive", templateId: "review-sensitive-default", templateName: "标准敏感词审查" }, expected: "sensitive" },
      { context: { type: "deai", templateId: "review-deai-deep", templateName: "深度重写" }, expected: "deai" },
      { context: { type: "source", templateId: "review-source-default", templateName: "对照素材" }, expected: "source-check" },
      {
        context: { type: "consistency", templateId: "review-consistency-default", templateName: "全面自洽核查" },
        expected: "consistency",
        overrides: { judgment: "数字", materialQuote: undefined, documentQuote: "报告称收入为130亿元" },
      },
      { context: { type: "privacy", templateId: "review-privacy-default", templateName: "对外发布" }, expected: "privacy" },
      { context: { type: "format", templateId: "review-format-default", templateName: "交付前整备" }, expected: "format" },
      { context: { type: "role", templateId: "review-role-engineer", templateName: "研发工程师" }, expected: "角色审查:研发工程师" },
      { context: { type: "custom", templateId: "review-custom-legal", templateName: "法务合规视角" }, expected: "自定义审查:法务合规视角" },
    ];
    const matrix: Record<string, string> = {};

    for (const item of cases) {
      const { state, tool } = setup();
      const result = await tool.execute!({
        groups: [group({ origin: "模型错填的 origin", ...item.overrides })],
      }, reviewCtx(item.context)) as { ok: boolean; errors: string[] };

      expect(result).toMatchObject({ ok: true, errors: [] });
      expect(state.annotationGroups[0]?.origin).toBe(item.expected);
      expect(state.annotationGroups[0]?.reviewTemplateId).toBe(item.context.templateId);
      matrix[item.context.type] = state.annotationGroups[0]!.origin;
    }

    console.info(`[R2:L1] origin 强制矩阵 ${JSON.stringify(matrix)}`);
  });

  it("一致性审查只接受当前文档中逐字存在的冲突对端原句", async () => {
    const { state, tool } = setup();
    state.doc!.content.push({
      type: "paragraph",
      attrs: { blockId: "p-2" },
      content: [{ type: "text", text: "上一节写明收入为120亿元。" }],
    });
    const valid = await tool.execute!({
      groups: [group({
        origin: "consistency",
        summary: "收入数字前后不一",
        judgment: "数字",
        materialQuote: undefined,
        documentQuote: "收入为120亿元",
        severity: "error",
      })],
    }, ctx);

    expect(valid).toMatchObject({ ok: true, groupCount: 1, errors: [] });
    expect(state.annotationGroups[0]).toMatchObject({ origin: "consistency", severity: "error" });
    expect(state.annotationGroups[0]?.note).toContain("文内冲突原句：收入为120亿元");

    const invalid = await tool.execute!({
      groups: [group({
        origin: "consistency",
        summary: "收入数字前后不一",
        judgment: "数字",
        materialQuote: undefined,
        documentQuote: "收入为110亿元",
      })],
    }, ctx) as { ok: boolean; errors: string[] };
    expect(invalid.ok).toBe(false);
    expect(invalid.errors[0]).toContain("当前文档中未找到冲突对端原句");
  });

  it("自定义审查按模板名换代，同模板重跑替换、不同模板共存", async () => {
    const { state, tool } = setup();
    const custom = (origin: string, summary: string) => group({
      origin,
      summary,
      judgment: undefined,
      materialQuote: undefined,
    });
    await tool.execute!({ groups: [custom("自定义审查:法务合规视角", "绝对化用语")] }, ctx);
    const firstId = state.annotationGroups[0]?.id;
    state._annotationOriginsReplacedThisTurn = new Set();
    await tool.execute!({ groups: [custom("自定义审查:法务合规视角", "承诺表述风险")] }, ctx);
    expect(state.annotationGroups).toHaveLength(1);
    expect(state.annotationGroups[0]?.id).not.toBe(firstId);
    await tool.execute!({ groups: [custom("自定义审查:老板视角挑刺", "行动建议空泛")] }, ctx);
    expect(state.annotationGroups.map((item) => item.origin)).toEqual(expect.arrayContaining([
      "自定义审查:老板视角挑刺",
      "自定义审查:法务合规视角",
    ]));
  });

  it("素材摘要命中但原文没有时仍拒绝捏造引文", async () => {
    const { state, tool } = setup();
    const fakeQuote = "原文有***脱敏标记";
    state.materials.get("mat-2")!.summary = fakeQuote;
    const result = await tool.execute!({ groups: [group({ materialQuote: fakeQuote })] }, ctx) as {
      ok: boolean; groupCount: number; anchorCount: number; errors: string[];
    };

    expect(result).toMatchObject({ ok: false, groupCount: 0, anchorCount: 0 });
    expect(result.errors).toEqual([
      `第 1 组 materialQuote 字段无效：素材中未找到所引原句「${fakeQuote}」`,
    ]);
    expect(state.annotationGroups).toHaveLength(0);
  });

  it("素材与引文仅空白不同，经正文同款 normalize 后通过", async () => {
    const { state, tool } = setup();
    const result = await tool.execute!({
      groups: [group({ materialQuote: "财报显示，收入为120 亿元，同比增长8%。" })],
    }, ctx);

    expect(result).toMatchObject({ ok: true, groupCount: 1, errors: [] });
    expect(state.annotationGroups).toHaveLength(1);
  });

  it("来源反向覆盖率接受素材遗漏并透传 info 严重度", async () => {
    const { state, tool } = setup();
    const result = await tool.execute!({
      groups: [group({
        summary: "素材要点未采用",
        judgment: "素材遗漏",
        materialQuote: "另一份素材全文",
        severity: "info",
        anchors: [{ find: "报告称收入为130亿元" }],
      })],
    }, ctx);
    expect(result).toMatchObject({ ok: true, groupCount: 1, errors: [] });
    expect(state.annotationGroups[0]).toMatchObject({ origin: "source-check", severity: "info" });
  });

  it("无据缺 checkedScope 时工具指出组号与字段", async () => {
    const { tool } = setup();
    const result = await tool.execute!({
      groups: [group({ judgment: "无据", materialQuote: undefined })],
    }, ctx) as { ok: boolean; errors: string[] };

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("第 1 组 checkedScope 字段必填");
  });

  it("旧调用缺 judgment 时工具指出组号与字段", async () => {
    const { tool } = setup();
    const legacy = group();
    delete (legacy as { judgment?: unknown }).judgment;
    delete (legacy as { materialQuote?: unknown }).materialQuote;
    const result = await tool.execute!({ groups: [legacy] }, ctx) as { ok: boolean; errors: string[] };

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("第 1 组 judgment 字段必填");
    expect(result.errors[0]).toContain("口径漂移");
    expect(result.errors[0]).toContain("无据");
  });

  it("无法安全修复的 JSON 走无副作用诊断信封并返回可行动错误", async () => {
    const { state, tool } = setup();
    const raw = '{"groups":[{"summary":"融资时间冲突","note":"一处写"2022年11月';
    let parseError: unknown;
    try { JSON.parse(raw); } catch (error) { parseError = error; }
    const input = JSON.parse(annotationGroupsParseFailureInput(raw, parseError));

    const result = await tool.execute!(input, ctx) as { ok: boolean; errors: string[] };

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("第 1 组的 note 字段附近");
    expect(result.errors[0]).toContain("每次≤3组");
    expect(state.annotationGroups).toHaveLength(0);
  });

  it("无据填写 checkedScope 后通过并拼入 note，不做引文存在性校验", async () => {
    const { state, tool } = setup();
    const result = await tool.execute!({
      groups: [group({
        judgment: "无据",
        materialQuote: undefined,
        checkedScope: "会话内两份素材全文",
      })],
    }, ctx);

    expect(result).toMatchObject({ ok: true, groupCount: 1, errors: [] });
    expect(state.annotationGroups[0]?.note).toContain("已核查范围：会话内两份素材全文");
  });
});
