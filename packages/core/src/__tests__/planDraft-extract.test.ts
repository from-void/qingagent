import { extractQuestionsJson } from "../tools/planDraft.js";
import { describe, expect, it } from "vitest";

const textQuestion = {
  id: "q-a",
  label: "L",
  kind: "text",
  options: [],
  placeholder: "",
};

describe("extractQuestionsJson", () => {
  it("keeps a clean array unchanged for parsing", () => {
    const input = JSON.stringify([textQuestion]);

    const parsed = JSON.parse(extractQuestionsJson(input));

    expect(parsed).toEqual([textQuestion]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("q-a");
  });

  it("ignores trailing prose and stray closing brackets after the array", () => {
    const input = `${JSON.stringify([textQuestion])}\n\n这是补充说明。]`;

    expect(JSON.parse(extractQuestionsJson(input))).toEqual([textQuestion]);
  });

  it("strips markdown json fences around the array", () => {
    const input = `\`\`\`json\n${JSON.stringify([textQuestion])}\n\`\`\``;

    expect(JSON.parse(extractQuestionsJson(input))).toEqual([textQuestion]);
  });

  it("keeps closing brackets inside option label strings", () => {
    const question = {
      id: "q-choice",
      label: "请选择",
      kind: "single",
      options: [{ value: "a", label: "见[备注]" }],
      placeholder: "",
    };

    const parsed = JSON.parse(extractQuestionsJson(JSON.stringify([question])));

    expect(parsed).toEqual([question]);
    expect(parsed[0].options[0].label).toBe("见[备注]");
  });

  it("skips leading prose with a decoy bracket before the real array", () => {
    const input = `参考 [示例] 如下：\n${JSON.stringify([textQuestion])}`;

    expect(JSON.parse(extractQuestionsJson(input))).toEqual([textQuestion]);
  });

  it("keeps escaped quotes inside label strings", () => {
    const question = {
      id: "q-quote",
      label: '他说"你好"',
      kind: "text",
      options: [],
      placeholder: "",
    };

    const parsed = JSON.parse(extractQuestionsJson(JSON.stringify([question])));

    expect(parsed).toEqual([question]);
    expect(parsed[0].label).toBe('他说"你好"');
  });

  it("leaves malformed unclosed input for the caller parse error", () => {
    expect(() => JSON.parse(extractQuestionsJson(`[{"id":"q-a"`))).toThrow();
  });
});

// R4-A P0 回归:LLM 省略 options 字段时,流式 partial 完整对象必须补 [](否则前端白屏)。
import { tryParsePartialQuestions } from "../tools/planDraft.js";

describe("tryParsePartialQuestions options 规范化", () => {
  it("完整对象省略 options 字段时补空数组", () => {
    const acc = '[{"id":"q-len","label":"目标字数","kind":"slider","slider":{"min":200,"max":3000,"step":100}},{"id":"q-x","label":"风格","kind":"single","options":[{"value":"a","label":"A"}]}';
    const qs = tryParsePartialQuestions(acc);
    expect(qs.length).toBeGreaterThanOrEqual(1);
    for (const q of qs) expect(Array.isArray(q.options)).toBe(true);
  });

  it("options 为非数组脏值时也强制为空数组", () => {
    const acc = '[{"id":"q-1","label":"x","kind":"text","options":null}]';
    const qs = tryParsePartialQuestions(acc);
    expect(qs[0]?.options).toEqual([]);
  });
});

describe("tryParsePartialQuestions 脏流式输入", () => {
  it("完整对象缺失/null 关键字段时不产出问题", () => {
    const acc = [
      "[",
      '{"label":"缺 id","kind":"text","options":[]},',
      '{"id":"q-null-label","label":null,"kind":"text","options":[]},',
      '{"id":"q-empty-kind","label":"空 kind","kind":"","options":[]}',
      "]",
    ].join("");

    expect(tryParsePartialQuestions(acc)).toEqual([]);
  });

  it("完整对象 label 不是字符串时不产出问题", () => {
    const acc = '[{"id":"q-bad-label","label":123,"kind":"text","options":[]}]';

    expect(tryParsePartialQuestions(acc)).toEqual([]);
  });

  it("完整对象 kind 不是合法字符串题型时不产出问题", () => {
    const acc = '[{"id":"q-bad-kind","label":"嵌套 kind","kind":{"kind":"text"},"options":[]}]';

    expect(tryParsePartialQuestions(acc)).toEqual([]);
  });

  it("半截对象字段类型不对时不产出问题", () => {
    const wrongLabelType = '[{"id":"q-1","label":123,"kind":"text","options":[';

    expect(tryParsePartialQuestions(wrongLabelType)).toEqual([]);
  });

  it("嵌套 kind 脏形态不被误提取(R5-B 修复:kind 值必须直接是字符串)", () => {
    const nestedKind = '[{"id":"q-2","label":"嵌套 kind","kind":{"kind":"text"},"options":[';
    expect(tryParsePartialQuestions(nestedKind)).toEqual([]);
  });

  it("半截 options 数组只保留已闭合选项,忽略嵌套截断选项", () => {
    const acc =
      '[{"id":"q-tone","label":"语气","kind":"single","options":[' +
      '{"value":"warm","label":"温和","description":"带一点 } 和 ] 的说明"},' +
      '{"value":"bad","label":"未闭合"';

    const qs = tryParsePartialQuestions(acc);

    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({
      id: "q-tone",
      label: "语气",
      kind: "single",
      options: [
        {
          value: "warm",
          label: "温和",
          description: "带一点 } 和 ] 的说明",
        },
      ],
    });
  });

  it("半截对象里的转义引号不会破坏已完成 option 的 JSON 边界", () => {
    const acc =
      '[{"id":"q-quote","label":"偏好","kind":"multi","options":[' +
      '{"value":"quote","label":"他说\\"好\\"","description":"包含 \\"引号\\""},' +
      '{"value":"tail"';

    const qs = tryParsePartialQuestions(acc);

    expect(qs[0]?.options).toEqual([
      { value: "quote", label: '他说"好"', description: '包含 "引号"' },
    ]);
  });

  it("半截对象 label 里的转义引号会完整解码", () => {
    const acc = '[{"id":"q-quote","label":"他说\\"你好\\"","kind":"text","options":[';

    const qs = tryParsePartialQuestions(acc);

    expect(qs[0]).toMatchObject({
      id: "q-quote",
      label: '他说"你好"',
      kind: "text",
      options: [],
    });
  });

  it("中文引号不是 JSON 字符串定界符,半截对象不误提取", () => {
    const acc = "[{“id”:“q-cn”,“label”:“中文引号”,“kind”:“text”,“options”:[";

    expect(tryParsePartialQuestions(acc)).toEqual([]);
  });

  it("slider 半截对象不提前产出,等待完整 JSON.parse 路径", () => {
    const partial = '[{"id":"q-len","label":"目标字数","kind":"slider","options":[],"slider":{"min":50';
    const complete = '[{"id":"q-len","label":"目标字数","kind":"slider","options":[],"slider":{"min":50,"max":2000,"step":100}}]';

    expect(tryParsePartialQuestions(partial)).toEqual([]);
    expect(tryParsePartialQuestions(complete)[0]).toMatchObject({
      id: "q-len",
      kind: "slider",
      options: [],
      slider: { min: 50, max: 2000, step: 100 },
    });
  });
});

describe("extractQuestionsJson 真实脏外壳", () => {
  it("从前导 fenced 说明中提取真正数组,忽略后续收尾散文", () => {
    const question = { ...textQuestion, label: "正文里有 }、] 和 “中文引号”" };
    const input = `先给你 JSON：\n\`\`\`json\n${JSON.stringify([question])}\n\`\`\`\n以上是问题列表。`;

    expect(JSON.parse(extractQuestionsJson(input))).toEqual([question]);
  });

  it("数组前的截断伪 JSON 不会抢走真正问题数组", () => {
    const input = `模型草稿 [{"id":"broken","label":"截断"\n正式输出：${JSON.stringify([textQuestion])}`;

    expect(JSON.parse(extractQuestionsJson(input))).toEqual([textQuestion]);
  });

  it("合法 JSON 但非问题数组不会抢走后续真正问题数组", () => {
    const input = `${JSON.stringify(["decoy"])}\n${JSON.stringify([textQuestion])}`;

    expect(JSON.parse(extractQuestionsJson(input))).toEqual([textQuestion]);
  });
});
