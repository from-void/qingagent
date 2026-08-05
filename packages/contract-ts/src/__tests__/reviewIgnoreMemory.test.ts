import { describe, expect, it } from "vitest";
import {
  appendReviewIgnoreLines,
  buildReviewIgnoreDecisionKey,
  buildReviewIgnoreLine,
  reviewIgnoreDecisionKeyFromLine,
  reviewTypeFromAnnotationOrigin,
  splitReviewSupplement,
} from "../ReviewIgnoreMemory";

describe("审查忽略补充提示词纯函数", () => {
  it.each([
    ["sensitive", "sensitive"],
    ["deai", "deai"],
    ["source-check", "source"],
    ["consistency", "consistency"],
    ["privacy", "privacy"],
    ["format", "format"],
    ["角色审查:研发工程师", "role"],
    ["自定义审查:逻辑链审查", "custom"],
    ["历史自由 origin", "custom"],
  ] as const)("origin %s 映射到 %s", (origin, type) => {
    expect(reviewTypeFromAnnotationOrigin(origin)).toBe(type);
  });

  it("机械追加逐字保留用户区并对规范行做全等去重", () => {
    const userText = "重点核对金额。\n保留 Product-X 原文。";
    const line = buildReviewIgnoreLine({
      quote: "尽快推动项目落地",
      summary: "行动建议空泛",
      date: "2026-08-03",
    });
    const once = appendReviewIgnoreLines(userText, [line]);
    const twice = appendReviewIgnoreLines(once, [line]);

    expect(twice).toBe(`${userText}\n\n## 已确认忽略\n${line}`);
    expect(splitReviewSupplement(twice)).toEqual({
      userText: `${userText}\n\n`,
      ignoreLines: [line],
      hasManagedSection: true,
    });
  });

  it("同形脱敏引文用结构锚点和问题摘要保留两条决定，真正重复仍去重", () => {
    const summary = "手机号属于已获授权的客服联系信息";
    const first = {
      origin: "sensitive",
      summary,
      anchor: { blockId: "contact-a", pmFrom: 4, pmTo: 15 },
    };
    const second = {
      origin: "sensitive",
      summary,
      anchor: { blockId: "contact-b", pmFrom: 4, pmTo: 15 },
    };
    const firstKey = buildReviewIgnoreDecisionKey(first);
    const secondKey = buildReviewIgnoreDecisionKey(second);
    const firstLine = buildReviewIgnoreLine({
      quote: "139****5678",
      summary: first.summary,
      date: "2026-08-05",
      decisionKey: firstKey,
    });
    const secondLine = buildReviewIgnoreLine({
      quote: "139****5678",
      summary: second.summary,
      date: "2026-08-05",
      decisionKey: secondKey,
    });

    const supplement = appendReviewIgnoreLines("", [firstLine, secondLine, firstLine]);
    const parts = splitReviewSupplement(supplement);

    expect(parts.ignoreLines).toHaveLength(2);
    expect(parts.ignoreLines).toEqual([firstLine, secondLine]);
    expect(firstLine).toContain(`问题：「${summary}」`);
    expect(secondLine).toContain(`问题：「${summary}」`);
    expect(firstLine.replace(/<!--.*-->$/u, "")).toBe(
      secondLine.replace(/<!--.*-->$/u, ""),
    );
    expect(reviewIgnoreDecisionKeyFromLine(firstLine)).toBe(firstKey);
    expect(reviewIgnoreDecisionKeyFromLine(secondLine)).toBe(secondKey);
    expect(firstKey).not.toBe(secondKey);
  });

  it("两个自定义模板在同一位置给出同一问题时仍有不同身份键", () => {
    const base = {
      summary: "行动建议空泛",
      anchor: { blockId: "same-block", pmFrom: 4, pmTo: 12 },
    };
    const first = {
      ...base,
      origin: "自定义审查:模板甲",
      templateId: "review-custom-x",
    };
    const second = {
      ...base,
      origin: "自定义审查:模板乙",
      templateId: "review-custom-y",
    };

    expect(buildReviewIgnoreDecisionKey(first)).not.toBe(
      buildReviewIgnoreDecisionKey(second),
    );
  });

  it("缺少模板 id 的历史自定义 origin 仍参与身份且不会把名称中的 PII 写进键", () => {
    const base = {
      summary: "行动建议空泛",
      anchor: { blockId: "same-block", pmFrom: 4, pmTo: 12 },
    };
    const firstKey = buildReviewIgnoreDecisionKey({
      ...base,
      origin: "自定义审查:客户 13912345678 复核",
    });
    const secondKey = buildReviewIgnoreDecisionKey({
      ...base,
      origin: "自定义审查:客户 13787654321 复核",
    });

    expect(firstKey).not.toBe(secondKey);
    expect(decodeURIComponent(firstKey)).not.toContain("13912345678");
    expect(decodeURIComponent(secondKey)).not.toContain("13787654321");
  });

  it.each([
    ["9 位", "待核对号码 139123456", "139123456"],
    ["10 位", "联系电话疑似截断为 1380013800", "1380013800"],
  ])("自定义审查的%s手机号片段不会进入忽略正文或机器身份键", (_label, summary, fragment) => {
    const key = buildReviewIgnoreDecisionKey({
      origin: "自定义审查:联系方式复核",
      summary,
      anchor: { blockId: "contact-fragment", pmFrom: 4, pmTo: 15 },
    });
    const line = buildReviewIgnoreLine({
      quote: "139****5678",
      summary,
      date: "2026-08-06",
      decisionKey: key,
    });

    expect(line).not.toContain(fragment);
    expect(decodeURIComponent(key)).not.toContain(fragment);
  });

  it.each([
    "订单号 139123456",
    "金额 1380013800 元",
    "年份 2026，普通编号 1234567890",
  ])("持久化忽略决定不误伤正常数字：%s", (summary) => {
    const key = buildReviewIgnoreDecisionKey({
      origin: "自定义审查:数字复核",
      summary,
      anchor: { blockId: "normal-number", pmFrom: 1, pmTo: 9 },
    });
    const line = buildReviewIgnoreLine({
      quote: summary,
      summary,
      date: "2026-08-06",
      decisionKey: key,
    });

    expect(line).toContain(summary);
    expect(decodeURIComponent(key)).toContain(summary);
  });

  it("机器键被删坏后按 legacy 行全等去重并保留决定", () => {
    const keyed = buildReviewIgnoreLine({
      quote: "需要保留的决定",
      summary: "无需修改",
      date: "2026-08-06",
      decisionKey: "v1:custom:span%3Ap-1%3A1%3A2:%E6%97%A0%E9%9C%80%E4%BF%AE%E6%94%B9",
    });
    const damaged = keyed.replace(/ <!-- qingagent-review-ignore-key:.* -->$/u, "");

    expect(reviewIgnoreDecisionKeyFromLine(damaged)).toBeNull();
    expect(splitReviewSupplement(appendReviewIgnoreLines("", [damaged, damaged])).ignoreLines)
      .toEqual([damaged]);
  });

  it("同名标题后有手写正文时不误判为机器区块", () => {
    const text = "用户说明\n## 已确认忽略\n这里也是用户手写内容";
    expect(splitReviewSupplement(text)).toEqual({
      userText: text,
      ignoreLines: [],
      hasManagedSection: false,
    });
  });
});
