import { describe, expect, it } from "vitest";
import { assembleReviewQuery } from "../ReviewQuery";

describe("assembleReviewQuery", () => {
  it("稳定装配模板、词库与文档补充，不改写 prompt", () => {
    const query = assembleReviewQuery(
      "sensitive",
      { id: "template-1", name: "严格审查", prompt: "  完整规则\n第二行  " },
      "  引用也要检查  ",
      [{ id: "lexicon-1", name: "广告法" }],
    );
    const expectedPrefix = [
      "对当前文档做敏感词审查。启用词库：「广告法」(id: lexicon-1)。",
      "审查模板「严格审查」(id: template-1)：",
      "完整规则",
      "第二行",
      "文档级补充要求（只适用于当前文档）：引用也要检查",
    ].join("\n");

    expect(query.startsWith(`${expectedPrefix}\n敏感词替换执行契约`)).toBe(true);
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

  it("敏感词旧模板也会在实际菜单上下文末尾补入语境改写硬纪律", () => {
    const query = assembleReviewQuery(
      "sensitive",
      {
        id: "sensitive-legacy",
        name: "旧直替模板",
        prompt: "有 replacement 的命中直接做最小替换。",
      },
      "所有命中一律套用词库替换",
      [{ id: "lexicon-1", name: "公文规范用语对照" }],
    );

    expect(query).toContain("replacementHint 仅是词库候选，不是直接替换指令");
    expect(query).toContain("必须先读取命中所在完整句子及必要段落");
    expect(query).toContain("suggestion 必须是结合完整上下文改写后的通顺整句");
    expect(query).toContain("不得插入‘该事项’‘相关内容’等占位词");
    expect(query).toContain("anchors[].find 必须是与 suggestion 对应的完整原句");
    expect(query).toContain("采纳时以整句替换整句");
    expect(query).toContain("只标注风险并省略 suggestion");
    expect(query).toContain("‘那块铭牌’‘爆破拆除’‘枪毙方案’");
    expect(query.lastIndexOf("敏感词替换执行契约")).toBeGreaterThan(query.indexOf("所有命中一律套用词库替换"));
  });
});
