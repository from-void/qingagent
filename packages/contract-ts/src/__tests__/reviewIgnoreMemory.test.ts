import { describe, expect, it } from "vitest";
import {
  appendReviewIgnoreLines,
  buildReviewIgnoreLine,
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

  it("同名标题后有手写正文时不误判为机器区块", () => {
    const text = "用户说明\n## 已确认忽略\n这里也是用户手写内容";
    expect(splitReviewSupplement(text)).toEqual({
      userText: text,
      ignoreLines: [],
      hasManagedSection: false,
    });
  });
});
