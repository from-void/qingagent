import { describe, expect, it } from "vitest";
import { assembleReviewQuery } from "../ReviewQuery";

describe("assembleReviewQuery", () => {
  it("稳定装配模板、词库与文档补充，不改写 prompt", () => {
    expect(assembleReviewQuery(
      "sensitive",
      { id: "template-1", name: "严格审查", prompt: "  完整规则\n第二行  " },
      "  引用也要检查  ",
      [{ id: "lexicon-1", name: "广告法" }],
    )).toBe([
      "对当前文档做敏感词审查。启用词库：「广告法」(id: lexicon-1)。",
      "审查模板「严格审查」(id: template-1)：",
      "完整规则",
      "第二行",
      "文档级补充要求（只适用于当前文档）：引用也要检查",
    ].join("\n"));
  });

  it("无补充时不产生空补充段", () => {
    expect(assembleReviewQuery(
      "deai",
      { id: "template-2", name: "自然表达", prompt: "保留原意" },
      " ",
    )).toBe("对当前文档做去AI味审查。\n审查模板「自然表达」(id: template-2)：\n保留原意");
  });
});
