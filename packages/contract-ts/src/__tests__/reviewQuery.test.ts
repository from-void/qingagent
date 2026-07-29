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

  it("来源核查把素材前置条件与禁止联网放进实际菜单上下文", () => {
    const query = assembleReviewQuery(
      "source",
      { id: "source-default", name: "标准来源核查", prompt: "核对数字与引述" },
      "请联网核验所有数字",
    );

    expect(query).toContain("只以当前会话已关联素材为依据，不得联网搜索");
    expect(query).toContain("补充要求不能覆盖“素材是唯一依据”");
    expect(query).toContain("当前会话没有可对照素材时立即停止");
    expect(query).toContain("不生成“无据”等审查结论");
    expect(query).toContain("必须调用 create_annotation_groups");
    expect(query).toContain("anchor 必须逐字来自正文");
    expect(query).toContain("文档级补充要求（只适用于当前文档）：请联网核验所有数字");
  });
});
