import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assembleReviewQuery,
  buildReviewIgnoreDecisionKey,
  buildReviewIgnoreLine,
  maskSensitiveAnnotationGroup,
  splitReviewSupplement,
  type AnnotationGroup,
  type ReviewIgnoreDecision,
} from "@qingagent/contract-ts";
import {
  getDocumentsClient,
  getReviewDocSupplement,
  runMigrations,
  upsertReviewDocSupplement,
} from "@qingagent/db";
import {
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "@qingagent/db/testing";

const mocks = vi.hoisted(() => ({
  branchCall: vi.fn(),
  getSessionSnapshot: vi.fn(),
}));

vi.mock("../llm/modelConfig.js", () => ({
  branchCall: mocks.branchCall,
  getSessionSnapshot: mocks.getSessionSnapshot,
}));

import {
  guardRewrittenReviewSupplement,
  rewriteReviewSupplementsForIgnoredGroups,
} from "../session/reviewSupplement.js";

let db: TempDocumentsDb;

const group: AnnotationGroup = {
  id: "group-1",
  summary: "行动建议空泛",
  note: "缺少负责人和期限。",
  origin: "自定义审查:老板视角挑刺",
  reviewTemplateId: "review-custom-boss",
  status: "reviewing" as const,
  anchors: [{
    blockId: "p-1",
    pmFrom: 1,
    pmTo: 9,
    quote: "尽快推动项目落地",
    textHash: "hash-1",
  }],
};

function sensitivePhoneGroup(input: {
  id: string;
  name: string;
  blockId: string;
  phone: string;
}): AnnotationGroup {
  return {
    id: input.id,
    summary: `${input.name}的手机号属于已获授权的客服联系信息`,
    note: `${input.name}的手机号 ${input.phone} 已获授权，无需标记。`,
    origin: "sensitive",
    status: "reviewing",
    anchors: [{
      blockId: input.blockId,
      pmFrom: 4,
      pmTo: 15,
      quote: input.phone,
      textHash: `raw-hash-${input.id}`,
    }],
  };
}

function ignoredDecision(
  group: AnnotationGroup,
  date = "2026-08-05",
): ReviewIgnoreDecision {
  const safeGroup = maskSensitiveAnnotationGroup(group);
  const anchor = safeGroup.anchors[0]!;
  const key = buildReviewIgnoreDecisionKey({
    origin: safeGroup.origin,
    templateId: safeGroup.reviewTemplateId,
    summary: safeGroup.summary,
    anchor,
  });
  return {
    key,
    line: buildReviewIgnoreLine({
      quote: anchor.quote,
      summary: safeGroup.summary,
      date,
      decisionKey: key,
    }),
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  db = prepareTempDocumentsDb("qa-review-supplement-");
  await runMigrations();
  await getDocumentsClient().execute(`INSERT INTO documents(
    id,thread_id,resource_id,title,doc_state,created_at,updated_at,role
  ) VALUES('doc-review-supplement','thread-review-supplement','qingagent-user','补充要求','editing','now','now','main')`);
  mocks.getSessionSnapshot.mockReturnValue({ sessionId: "thread-review-supplement" });
});

afterEach(() => db.cleanup());

describe("忽略批注回填审查补充提示词", () => {
  it("借道旁支让模型合并完整补充提示词并写回对应 custom 类型", async () => {
    const userText = "重点核对金额。\n英文 Product-X 必须逐字保留。";
    const line = ignoredDecision(group, "2026-08-03").line;
    const expected = [
      userText,
      "",
      "## 已确认忽略",
      line,
    ].join("\n");
    await upsertReviewDocSupplement(
      "doc-review-supplement",
      "custom",
      userText,
      group.reviewTemplateId,
    );
    mocks.branchCall.mockResolvedValue({
      ok: true,
      text: expected,
      attempts: 1,
      toolCallRetries: 0,
      finishReason: "stop",
    });

    await rewriteReviewSupplementsForIgnoredGroups({
      docId: "doc-review-supplement",
      groups: [group],
      now: new Date("2026-08-03T12:00:00.000Z"),
    });

    expect(await getReviewDocSupplement(
      "doc-review-supplement",
      "custom",
      group.reviewTemplateId,
    )).toBe(expected);
    expect(mocks.branchCall).toHaveBeenCalledWith(expect.objectContaining({
      callSite: "rewriteReviewSupplement",
      steeringTail: expect.stringContaining("自定义审查:老板视角挑刺"),
    }));
  });

  it("模型改动用户手写内容时守卫拒绝，机械追加仍保存本次决定", async () => {
    const userText = "用户手写：保留 Product-X，金额不要四舍五入。";
    const line = ignoredDecision(group, "2026-08-03").line;
    await upsertReviewDocSupplement(
      "doc-review-supplement",
      "custom",
      userText,
      group.reviewTemplateId,
    );
    mocks.branchCall.mockResolvedValue({
      ok: true,
      text: [
        "用户手写：保留产品名，金额可取整。",
        "",
        "## 已确认忽略",
        line,
      ].join("\n"),
      attempts: 1,
      toolCallRetries: 0,
      finishReason: "stop",
    });

    await rewriteReviewSupplementsForIgnoredGroups({
      docId: "doc-review-supplement",
      groups: [group],
      now: new Date("2026-08-03T12:00:00.000Z"),
    });

    expect(await getReviewDocSupplement(
      "doc-review-supplement",
      "custom",
      group.reviewTemplateId,
    )).toBe([
      userText,
      "",
      "## 已确认忽略",
      line,
    ].join("\n"));
  });

  it("会话快照不可用时不发模型请求，直接机械追加", async () => {
    mocks.getSessionSnapshot.mockReturnValue(null);
    const sourceGroup = { ...group, origin: "source-check" };

    await rewriteReviewSupplementsForIgnoredGroups({
      docId: "doc-review-supplement",
      groups: [sourceGroup],
      now: new Date("2026-08-03T12:00:00.000Z"),
    });

    expect(mocks.branchCall).not.toHaveBeenCalled();
    expect(await getReviewDocSupplement("doc-review-supplement", "source")).toBe(
      `## 已确认忽略\n${ignoredDecision(sourceGroup, "2026-08-03").line}`,
    );
  });

  it("两个明文不同但脱敏同形的手机号分别忽略后均留痕，并完整进入复审输入", async () => {
    mocks.getSessionSnapshot.mockReturnValue(null);
    const first = sensitivePhoneGroup({
      id: "phone-wang",
      name: "王芳",
      blockId: "contact-wang",
      phone: "13912345678",
    });
    const second = sensitivePhoneGroup({
      id: "phone-li",
      name: "李明",
      blockId: "contact-li",
      phone: "13987655678",
    });

    await rewriteReviewSupplementsForIgnoredGroups({
      docId: "doc-review-supplement",
      groups: [first],
      now: new Date("2026-08-05T12:00:00.000Z"),
    });
    const afterFirst = await getReviewDocSupplement(
      "doc-review-supplement",
      "sensitive",
    );
    mocks.getSessionSnapshot.mockReturnValue({ sessionId: "thread-review-supplement" });
    mocks.branchCall.mockResolvedValue({
      ok: true,
      // 复现线上假成功：模型只返回已有第一条，完全漏掉本次第二条。
      text: afterFirst,
      attempts: 1,
      toolCallRetries: 0,
      finishReason: "stop",
    });
    await rewriteReviewSupplementsForIgnoredGroups({
      docId: "doc-review-supplement",
      groups: [second],
      now: new Date("2026-08-05T12:01:00.000Z"),
    });

    const supplement = await getReviewDocSupplement("doc-review-supplement", "sensitive");
    const lines = splitReviewSupplement(supplement).ignoreLines;
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.includes("139****5678"))).toBe(true);
    expect(lines.some((line) => line.includes("王芳的手机号"))).toBe(true);
    expect(lines.some((line) => line.includes("李明的手机号"))).toBe(true);
    expect(supplement).not.toContain("13912345678");
    expect(supplement).not.toContain("13987655678");
    expect(mocks.branchCall).toHaveBeenCalledTimes(1);

    const reviewQuery = assembleReviewQuery("sensitive", {
      id: "sensitive-default",
      name: "默认敏感词模板",
      prompt: "标记未获授权的手机号。",
    }, supplement);
    expect(reviewQuery).toContain(lines[0]!);
    expect(reviewQuery).toContain(lines[1]!);
  });

  it.each([
    ["9 位", "待核对号码 139123456", "139123456"],
    ["10 位", "联系电话疑似截断为 1380013800", "1380013800"],
  ])("custom origin 的%s手机号片段不会落入补充要求正文或机器键", async (_label, summary, fragment) => {
    mocks.getSessionSnapshot.mockReturnValue(null);
    const customGroup: AnnotationGroup = {
      ...group,
      id: `custom-phone-${fragment.length}`,
      summary,
      origin: "自定义审查:联系方式复核",
      reviewTemplateId: "review-custom-contact",
      anchors: [{
        blockId: `contact-${fragment.length}`,
        pmFrom: 4,
        pmTo: 15,
        quote: "139****5678",
        textHash: "masked-upstream-hash",
      }],
    };

    await rewriteReviewSupplementsForIgnoredGroups({
      docId: "doc-review-supplement",
      groups: [customGroup],
      now: new Date("2026-08-06T12:00:00.000Z"),
    });

    const supplement = await getReviewDocSupplement(
      "doc-review-supplement",
      "custom",
      customGroup.reviewTemplateId,
    );
    const [line] = splitReviewSupplement(supplement).ignoreLines;
    expect(supplement).not.toContain(fragment);
    expect(decodeURIComponent(line ?? "")).not.toContain(fragment);
    expect(line).toContain("139****5678");
  });

  it("同一位置同一问题的决定重复提交时只保留一条", async () => {
    mocks.getSessionSnapshot.mockReturnValue(null);
    const repeated = sensitivePhoneGroup({
      id: "phone-wang",
      name: "王芳",
      blockId: "contact-wang",
      phone: "13912345678",
    });

    await rewriteReviewSupplementsForIgnoredGroups({
      docId: "doc-review-supplement",
      groups: [repeated],
      now: new Date("2026-08-05T12:00:00.000Z"),
    });
    await rewriteReviewSupplementsForIgnoredGroups({
      docId: "doc-review-supplement",
      groups: [repeated],
      now: new Date("2026-08-06T12:00:00.000Z"),
    });

    const supplement = await getReviewDocSupplement("doc-review-supplement", "sensitive");
    expect(splitReviewSupplement(supplement).ignoreLines).toHaveLength(1);
  });

  it("guard 按决定身份识别同形新决定未落盘，不能把旧行当成本次成功", () => {
    const firstGroup = sensitivePhoneGroup({
      id: "phone-wang",
      name: "王芳",
      blockId: "contact-wang",
      phone: "13912345678",
    });
    const secondGroup = sensitivePhoneGroup({
      id: "phone-li",
      name: "李明",
      blockId: "contact-li",
      phone: "13987655678",
    });
    const first = ignoredDecision(firstGroup);
    const second = ignoredDecision(secondGroup);
    const current = `## 已确认忽略\n${first.line}`;

    expect(guardRewrittenReviewSupplement(
      current,
      [{ key: second.key, line: first.line }],
      current,
    )).toBeNull();
    expect(guardRewrittenReviewSupplement(current, [second], current)).toBeNull();
    expect(guardRewrittenReviewSupplement(
      current,
      [second],
      `${current}\n${second.line}`,
    )).toBe(`${current}\n${second.line}`);
  });

  it("guard 在合并前校验本次决定基数，不能用去重结果证明碰撞成功", () => {
    const decision = ignoredDecision(group);
    const candidate = `## 已确认忽略\n${decision.line}`;

    expect(guardRewrittenReviewSupplement("", [decision, decision], candidate)).toBeNull();
  });

  it("两个自定义模板的同形批注分别留痕、互不误抑制且补充要求不串台", async () => {
    mocks.getSessionSnapshot.mockReturnValue(null);
    const getScoped = getReviewDocSupplement as unknown as (
      docId: string,
      type: "custom",
      templateScope: string,
    ) => Promise<string>;
    const upsertScoped = upsertReviewDocSupplement as unknown as (
      docId: string,
      type: "custom",
      supplement: string,
      templateScope: string,
    ) => Promise<string>;
    const sameAnchor = [{
      blockId: "same-block",
      pmFrom: 4,
      pmTo: 12,
      quote: "尽快推动项目落地",
      textHash: "same-hash",
    }];
    const templateX = {
      ...group,
      id: "group-template-x",
      origin: "自定义审查:模板 X",
      reviewTemplateId: "review-custom-x",
      anchors: sameAnchor,
    };
    const templateY = {
      ...group,
      id: "group-template-y",
      origin: "自定义审查:模板 Y",
      reviewTemplateId: "review-custom-y",
      anchors: sameAnchor,
    };
    await upsertScoped(
      "doc-review-supplement",
      "custom",
      "只属于模板 X 的补充要求",
      "review-custom-x",
    );
    await upsertScoped(
      "doc-review-supplement",
      "custom",
      "只属于模板 Y 的补充要求",
      "review-custom-y",
    );

    await rewriteReviewSupplementsForIgnoredGroups({
      docId: "doc-review-supplement",
      groups: [templateX],
      now: new Date("2026-08-06T12:00:00.000Z"),
    });
    await rewriteReviewSupplementsForIgnoredGroups({
      docId: "doc-review-supplement",
      groups: [templateY],
      now: new Date("2026-08-06T12:01:00.000Z"),
    });

    const supplementX = await getScoped(
      "doc-review-supplement",
      "custom",
      "review-custom-x",
    );
    const supplementY = await getScoped(
      "doc-review-supplement",
      "custom",
      "review-custom-y",
    );
    const [lineX] = splitReviewSupplement(supplementX).ignoreLines;
    const [lineY] = splitReviewSupplement(supplementY).ignoreLines;

    expect(splitReviewSupplement(supplementX).ignoreLines).toHaveLength(1);
    expect(splitReviewSupplement(supplementY).ignoreLines).toHaveLength(1);
    expect(lineX).not.toBe(lineY);
    expect(supplementX).toContain("只属于模板 X 的补充要求");
    expect(supplementX).not.toContain("只属于模板 Y 的补充要求");
    expect(supplementY).toContain("只属于模板 Y 的补充要求");
    expect(supplementY).not.toContain("只属于模板 X 的补充要求");

    const queryX = assembleReviewQuery("custom", {
      id: "review-custom-x",
      name: "模板 X",
      prompt: "检查行动项。",
    }, supplementX);
    const queryY = assembleReviewQuery("custom", {
      id: "review-custom-y",
      name: "模板 Y",
      prompt: "检查行动项。",
    }, supplementY);
    expect(queryX).toContain(lineX!);
    expect(queryX).not.toContain(lineY!);
    expect(queryY).toContain(lineY!);
    expect(queryY).not.toContain(lineX!);
  });

  it("升级前没有模板 id 的两个 custom origin 仍在兼容基线保留两条决定", async () => {
    mocks.getSessionSnapshot.mockReturnValue(null);
    const { reviewTemplateId: _templateId, ...legacyGroup } = group;
    const first = {
      ...legacyGroup,
      id: "legacy-template-x",
      origin: "自定义审查:旧模板 X",
    };
    const second = {
      ...legacyGroup,
      id: "legacy-template-y",
      origin: "自定义审查:旧模板 Y",
    };

    await rewriteReviewSupplementsForIgnoredGroups({
      docId: "doc-review-supplement",
      groups: [first],
      now: new Date("2026-08-06T12:00:00.000Z"),
    });
    await rewriteReviewSupplementsForIgnoredGroups({
      docId: "doc-review-supplement",
      groups: [second],
      now: new Date("2026-08-06T12:01:00.000Z"),
    });

    const supplement = await getReviewDocSupplement(
      "doc-review-supplement",
      "custom",
    );
    const lines = splitReviewSupplement(supplement).ignoreLines;
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toBe(lines[1]);
  });
});
