import { describe, expect, it } from "vitest";
import {
  appendReviewIgnoreLines,
  buildReviewIgnoreDecisionKey,
  buildReviewIgnoreLine,
  reviewIgnoreDecisionKeyFromLine,
  reviewTypeFromAnnotationOrigin,
  splitReviewSupplement,
} from "../ReviewIgnoreMemory";

function phoneBruteForceSpace(disclosure: string, target: string): number {
  const fragments = new Set<string>();
  for (let length = 4; length <= target.length; length += 1) {
    for (let start = 0; start + length <= target.length; start += 1) {
      const fragment = target.slice(start, start + length);
      if (disclosure.includes(fragment)) fragments.add(fragment);
    }
  }

  let candidates = 0;
  for (let middle = 0; middle < 10_000; middle += 1) {
    const candidate = `139${String(middle).padStart(4, "0")}5678`;
    if ([...fragments].every((fragment) => candidate.includes(fragment))) candidates += 1;
  }
  return candidates;
}

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
      decisionKey: "v1:custom:span%3Ap-1%3A1%3A2:action",
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
      quote: "139****5678",
      anchor: { blockId: "contact-a", pmFrom: 4, pmTo: 15 },
    };
    const second = {
      origin: "sensitive",
      summary,
      quote: "139****5678",
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
      quote: "尽快推动项目落地",
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
      quote: "尽快推动项目落地",
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
      quote: "139****5678",
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

  it("同一忽略记录的打码引文与 8 位摘要残片不能并集拼回完整手机号", () => {
    const phone = "13912345678";
    const quote = "139****5678";
    const summary = "摘要含手机号：13912345";
    const keyInput: Parameters<typeof buildReviewIgnoreDecisionKey>[0] = {
      origin: "sensitive",
      summary,
      quote,
      anchor: { blockId: "contact-union", pmFrom: 4, pmTo: 15 },
    };
    const key = buildReviewIgnoreDecisionKey(keyInput);
    const line = buildReviewIgnoreLine({
      quote,
      summary,
      date: "2026-08-06",
      decisionKey: key,
    });
    const controlLine = buildReviewIgnoreLine({
      quote,
      summary: "已获授权的客服联系信息",
      date: "2026-08-06",
      decisionKey: "control",
    });

    expect(line).not.toContain("13912345");
    expect(decodeURIComponent(key)).not.toContain("13912345");
    expect(phoneBruteForceSpace(line, phone)).toBeGreaterThanOrEqual(1_000);
    expect(phoneBruteForceSpace(line, phone)).toBe(phoneBruteForceSpace(controlLine, phone));
  });

  it.each([
    "订单号 139123456",
    "金额 1380013800 元",
    "年份 2026，普通编号 1234567890",
  ])("持久化忽略决定不误伤正常数字：%s", (summary) => {
    const key = buildReviewIgnoreDecisionKey({
      origin: "自定义审查:数字复核",
      summary,
      quote: summary,
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

  it("同名标题后有手写正文时不误判为机器区块", () => {
    const text = "用户说明\n## 已确认忽略\n这里也是用户手写内容";
    expect(splitReviewSupplement(text)).toEqual({
      userText: text,
      ignoreLines: [],
      hasManagedSection: false,
    });
  });
});
