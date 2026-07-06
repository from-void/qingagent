import { describe, expect, it } from "vitest";
import { extractJson } from "../bridge/docGenerator.js";

// extractJson 的职责:从 LLM 的"脏输出"里抠出第一个完整 JSON 值。
// 它的全部价值就是对付脏输入,所以这里用 LLM 真实会吐的各种脏形态逐条测(对抗性输入测试)。
// 契约:截出的串应能被 JSON.parse;真截不出合法的,就原样返回让上层 parse 失败 → 触发重试。
const parses = (s: string): boolean => {
  JSON.parse(s);
  return true;
};

describe("extractJson — 对抗 LLM 脏输出(契约测试)", () => {
  const ARR = '[{"type":"heading","level":1,"runs":[{"text":"标题"}]}]';
  const OBJ = '{"blocks":[{"type":"paragraph","runs":[{"text":"正文"}]}]}';

  it("纯 JSON array:原样可解析", () => {
    expect(parses(extractJson(ARR))).toBe(true);
    expect(extractJson(ARR)).toBe(ARR);
  });

  it("JSON + 尾随收尾散文(本次真 bug 回归):只截 JSON、丢散文", () => {
    const raw = `${ARR}\n\n已生成,共 1 段。`;
    const out = extractJson(raw);
    expect(out).toBe(ARR);
    expect(parses(out)).toBe(true);
  });

  it("前导话 + JSON:截出 JSON", () => {
    const out = extractJson(`好的,这是文档:\n${ARR}`);
    expect(out).toBe(ARR);
    expect(parses(out)).toBe(true);
  });

  it("前导伪方括号不会抢跑:跳过不可解析候选并解析真 JSON", () => {
    const raw = `参考 [示例] 如下:\n${ARR}`;
    const out = extractJson(raw);
    expect(out).toBe(ARR);
    expect(parses(out)).toBe(true);
  });

  it("前导 + JSON + 尾随都有:只截中间 JSON", () => {
    const out = extractJson(`这是结果:${ARR}\n希望满意。`);
    expect(out).toBe(ARR);
    expect(parses(out)).toBe(true);
  });

  it("```json fence 包裹:取内部 JSON", () => {
    expect(parses(extractJson("```json\n" + ARR + "\n```"))).toBe(true);
  });

  it("```json fence 内尾随散文:只取 fence body 里的完整 JSON", () => {
    const raw = "```json\n" + ARR + "\n已生成。\n```";
    const out = extractJson(raw);
    expect(out).toBe(ARR);
    expect(parses(out)).toBe(true);
  });

  it("```json fence + 前后散文:取内部 JSON", () => {
    expect(parses(extractJson("好的:\n```json\n" + ARR + "\n```\n完成了。"))).toBe(true);
  });

  it("多个候选:跳过不可解析数组 decoy,返回后面的真数组", () => {
    const raw = `候选一:[未引用]\n候选二:\n${ARR}`;
    const out = extractJson(raw);
    expect(out).toBe(ARR);
    expect(parses(out)).toBe(true);
  });

  it("JSON object({blocks}) + 尾随散文:只截 object", () => {
    const out = extractJson(`${OBJ}\n已生成。`);
    expect(out).toBe(OBJ);
    expect(parses(out)).toBe(true);
  });

  it("正文字符串里含 ] 和 }:平衡括号扫描不被误截", () => {
    const tricky = '[{"type":"paragraph","runs":[{"text":"数组写成 [x],对象写成 {y}"}]}]';
    const out = extractJson(`${tricky}\n收尾散文带个 ] 和 }`);
    expect(out).toBe(tricky);
    expect(parses(out)).toBe(true);
  });

  it("正文里有转义引号:字符串扫描正确、不提前收尾", () => {
    const esc = '[{"type":"paragraph","runs":[{"text":"他说\\"你好\\",然后走了"}]}]';
    const out = extractJson(`${esc}\n完。`);
    expect(out).toBe(esc);
    expect(parses(out)).toBe(true);
  });

  it("截断(不完整 JSON):返回到末尾,交给上层 parse 失败 → 重试", () => {
    const truncated = '[{"type":"heading","runs":[{"text":"只写了一半';
    const out = extractJson(truncated);
    // 截不出完整值,不应抛错;返回的串 parse 失败是预期(让外层重试)
    expect(typeof out).toBe("string");
    expect(() => JSON.parse(out)).toThrow();
  });

  it("截断对象里的内部数组不能被误提取成完整文档", () => {
    const truncated = '{"type":"paragraph","runs":[{"text":"半截"}]';
    const out = extractJson(truncated);
    expect(out).toBe(truncated);
    expect(() => JSON.parse(out)).toThrow();
  });

  it("空数组和空 blocks envelope 仍只负责截取,语义拒收由上层格式 parser 处理", () => {
    expect(extractJson("[]")).toBe("[]");
    expect(extractJson('{"blocks":[]}')).toBe('{"blocks":[]}');
  });
});
