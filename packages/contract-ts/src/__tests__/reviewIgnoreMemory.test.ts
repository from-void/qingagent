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

  it("同名标题后有手写正文时不误判为机器区块", () => {
    const text = "用户说明\n## 已确认忽略\n这里也是用户手写内容";
    expect(splitReviewSupplement(text)).toEqual({
      userText: text,
      ignoreLines: [],
      hasManagedSection: false,
    });
  });
});
