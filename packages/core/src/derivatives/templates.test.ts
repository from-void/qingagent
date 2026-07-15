import { describe, expect, it } from "vitest";
import { DTYPE_COMMON_CONSTRAINTS, DTYPE_WRITING_TEMPLATE_SEEDS, withDtypeCommonConstraints } from "./dtypeTemplatePrompts.js";

describe("dtype writing template seeds", () => {
  it("公众号、小红书和翻译各注册三张写作模板", () => {
    expect(DTYPE_WRITING_TEMPLATE_SEEDS.filter((item) => item.dtype === "gzh")).toHaveLength(3);
    expect(DTYPE_WRITING_TEMPLATE_SEEDS.filter((item) => item.dtype === "xhs")).toHaveLength(3);
    expect(DTYPE_WRITING_TEMPLATE_SEEDS.filter((item) => item.dtype === "translate")).toHaveLength(3);
    expect(DTYPE_WRITING_TEMPLATE_SEEDS.every((item) => item.slot === "writing")).toBe(true);
    expect(DTYPE_WRITING_TEMPLATE_SEEDS.map((item) => item.id)).toEqual([
      "translate-faithful", "translate-native", "translate-business",
      "gzh-opinion", "gzh-tutorial", "gzh-story",
      "xhs-recommend", "xhs-checklist", "xhs-experience",
    ]);
  });

  it("翻译种子名称、摘要和提示词与施工单逐字一致", () => {
    const expected = [
      ["translate-faithful", "忠实精准", "结构对应、术语括注、不增不减", `把主文档忠实翻译成目标语言：
①不增不减不改写，段落结构与原文一一对应；
②术语、产品名、人名首次出现时在译文后括注原文；
③数字、日期、单位原样保留，书写格式遵循目标语言习惯；
④多义处选最贴近上下文的译法，不自由发挥。`],
      ["translate-native", "母语化改写", "像目标语言母语者写的", `把主文档翻译成目标语言，以读起来像母语者写的为最高标准：
①按目标语言的行文习惯重组句式与段落衔接，不逐句直译；
②中文特有的成语、俗语、比喻，换成目标语言里同等效果的表达；
③语气与文体保持原文定位（正式/轻松），节奏按目标语言调整；
④事实、数据、结论必须与原文完全一致，只改表达不改内容。`],
      ["translate-business", "正式商务", "书面商务文体、敬语规范", `把主文档翻译成目标语言的正式商务文体：
①用书面语与商务惯用表达，避免口语和俚语；
②称谓、敬语、格式遵循目标语言的商务规范；
③关键条款、数字、日期翻译后逐项复核与原文一致；
④原文中随意的表达适度收敛为得体书面语，但不改变承诺与事实。`],
    ];
    expect(DTYPE_WRITING_TEMPLATE_SEEDS.filter((item) => item.dtype === "translate").map((item) => [item.id, item.name, item.detail, item.prompt])).toEqual(expected);
  });

  it("公共硬约束由 dtype 层统一拼接，不写进单张模板", () => {
    const opinion = DTYPE_WRITING_TEMPLATE_SEEDS.find((item) => item.id === "gzh-opinion")!;
    const recommend = DTYPE_WRITING_TEMPLATE_SEEDS.find((item) => item.id === "xhs-recommend")!;
    expect(opinion.prompt).not.toContain("不得新增未经素材/主稿支撑的事实");
    expect(recommend.prompt).not.toContain("每段至多1-2个");
    expect(withDtypeCommonConstraints("gzh", opinion.prompt)).toBe(`${DTYPE_COMMON_CONSTRAINTS.gzh}\n\n${opinion.prompt}`);
    expect(withDtypeCommonConstraints("xhs", recommend.prompt)).toContain("emoji 使用自然不堆砌(每段至多1-2个,用于分段和情绪标记)。");
    expect(DTYPE_COMMON_CONSTRAINTS.gzh).toContain("不得给主稿对象追加其未自述的行业/阶段/规模定性");
    expect(DTYPE_COMMON_CONSTRAINTS.xhs).toContain("不得新增主稿外亲历事件");
  });

  it("L2 回归:故事开头、三张小红书标题与亲历事实边界均为硬约束", () => {
    const getPrompt = (id: string) => DTYPE_WRITING_TEMPLATE_SEEDS.find((item) => item.id === id)!.prompt;
    expect(getPrompt("gzh-story")).toContain("第一句就是具体场景里的动作或对话");
    expect(getPrompt("gzh-story")).toContain("禁止\"把时间拨回\"");
    for (const id of ["xhs-recommend", "xhs-checklist", "xhs-experience"]) {
      expect(getPrompt(id)).toContain("写完标题后逐字符数一遍(汉字/字母/数字/标点各算1字)");
      expect(getPrompt(id)).toContain(">20字必须删词重写,宁短勿超");
    }
    expect(getPrompt("xhs-experience")).toContain("第一人称是叙述视角,不是虚构事件的许可");
    expect(getPrompt("xhs-experience")).toContain("主稿没有的经历(如见投资人/融资过程细节)一律不得编造");
  });
});
