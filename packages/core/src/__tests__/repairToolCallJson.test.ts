import { describe, expect, it } from "vitest";
import { editDraftInputSchema } from "../tools/draftMutationSchemas.js";
import { repairToolCallJson } from "../llm/repairToolCallJson.js";
import { repairDraftToolCallInput } from "../llm/repairingModel.js";
import { serverAiir3ToolCallInput } from "./fixtures/serverAiir3ToolCallInput.js";
import { extractJson } from "../bridge/docGenerator.js";

describe("repairToolCallJson", () => {
  it("纯字符串值裸双引号病可修复,且内容保真", () => {
    const quoteOnly =
      '{"ops":[{"action":"replaceBlock","ref":"block-a","block":"<p>进入"土地争夺"和"五层大厦"阶段</p>"}]}';
    const repaired = repairToolCallJson(quoteOnly);

    expect(repaired.ok).toBe(true);
    if (!repaired.ok) return;
    expect(repaired.changed).toBe(true);

    const parsed = JSON.parse(repaired.json) as { ops: unknown[] };
    expect(editDraftInputSchema.safeParse(parsed).success).toBe(true);
    expect(parsed.ops).toHaveLength(1);
    expect(repaired.json).toContain("\\\"土地争夺\\\"");
    expect(repaired.json).toContain("\\\"五层大厦\\\"");
    expect(JSON.stringify(parsed)).toContain("土地争夺");
    expect(JSON.stringify(parsed)).toContain("五层大厦");
  });

  it("原始叠加缺括号病样本走 fail-closed,不产出半修半坏 JSON", () => {
    const repaired = repairToolCallJson(serverAiir3ToolCallInput);

    expect(repaired.ok).toBe(false);
    expect(repairDraftToolCallInput("editDraft", serverAiir3ToolCallInput)).toBeNull();
  });

  it("内容引号紧贴结构符（如 \"…\",）→ 启发式可能误判闭合,必须 fail-closed", () => {
    // replace 值里 `他说"是",我懂了` 的第二个内容引号后面紧跟逗号：
    // 这类输入无法高置信判断逗号属于正文还是 JSON 结构，必须放弃修复。
    const tricky = '{"ops":[{"action":"replaceText","find":"a","replace":"他说"是",我懂了"}]}';

    const repaired = repairToolCallJson(tricky);

    expect(repaired.ok).toBe(false);
    expect(repairDraftToolCallInput("editDraft", tricky)).toBeNull();
  });

  it("闭合引号后紧跟汉字时不把两段语义吞成一个字符串", () => {
    const tricky = '{"ops":[{"action":"replaceText","find":"旧文","replace":"结尾"字"}]}';

    const repaired = repairToolCallJson(tricky);

    expect(repaired).toEqual({ ok: false, reason: "noHighConfidenceRepair" });
    expect(repairDraftToolCallInput("editDraft", tricky)).toBeNull();
  });

  it("开头 BOM 与零宽字符可清理,不影响真实 JSON 内容", () => {
    const clean = JSON.stringify({
      ops: [{ action: "replaceText", find: "旧文", replace: "新文", all: true }],
    });
    const repaired = repairToolCallJson(`\uFEFF\u200B${clean}`);

    expect(repaired).toEqual({ ok: true, json: clean, changed: true });
    expect(JSON.parse(repaired.ok ? repaired.json : "")).toEqual(JSON.parse(clean));
  });

  it("JSON 注释不是高置信修复范围", () => {
    const input = '{"ops":[/* 模型插入的注释 */{"action":"replaceText","find":"旧文","replace":"新文"}]}';

    const repaired = repairToolCallJson(input);

    expect(repaired).toEqual({ ok: false, reason: "noHighConfidenceRepair" });
    expect(repairDraftToolCallInput("editDraft", input)).toBeNull();
  });

  it("多个成对裸双引号仍可修复并保真", () => {
    const input =
      '{"ops":[{"action":"replaceText","find":"旧文","replace":"进入"土地争夺"和"五层大厦"阶段"}]}';

    const repaired = repairToolCallJson(input);

    expect(repaired.ok).toBe(true);
    if (!repaired.ok) return;
    const parsed = JSON.parse(repaired.json) as { ops: Array<{ replace: string }> };
    expect(repaired.changed).toBe(true);
    expect(parsed.ops[0]!.replace).toBe('进入"土地争夺"和"五层大厦"阶段');
  });

  it("数组元素间漏逗号可补齐", () => {
    const input = [
      "[",
      '{"type":"paragraph","runs":[{"text":"第一段"}]}',
      '{"type":"paragraph","runs":[{"text":"第二段"}]}',
      "]",
    ].join("\n");

    const repaired = repairToolCallJson(input);

    expect(repaired.ok).toBe(true);
    if (!repaired.ok) return;
    expect(repaired.changed).toBe(true);
    const parsed = JSON.parse(repaired.json) as unknown[];
    expect(parsed).toHaveLength(2);
  });

  it("数组里字面量后接新元素时补逗号", () => {
    const input = '[true {"ok":1} "tail"]';

    const repaired = repairToolCallJson(input);

    expect(repaired.ok).toBe(true);
    if (!repaired.ok) return;
    expect(JSON.parse(repaired.json)).toEqual([true, { ok: 1 }, "tail"]);
  });

  it("裸引号拆片与数组漏逗号叠加时仍只做高置信修复", () => {
    const input = [
      "[",
      '{"type":"paragraph","runs":[{"text":"名言：","Less is more","。"}]}',
      '{"type":"paragraph","runs":[{"text":"下一段"}]}',
      "]",
    ].join("\n");

    const repaired = repairToolCallJson(input);

    expect(repaired.ok).toBe(true);
    if (!repaired.ok) return;
    const parsed = JSON.parse(repaired.json) as Array<{ runs: Array<{ text: string }> }>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.runs[0]!.text).toBe('名言："Less is more"。');
  });

  it("单引号 JSON 不是高置信修复范围", () => {
    const input = "{'ops':[{'action':'replaceText','find':'旧文','replace':'新文'}]}";

    const repaired = repairToolCallJson(input);

    expect(repaired).toEqual({ ok: false, reason: "noHighConfidenceRepair" });
    expect(repairDraftToolCallInput("editDraft", input)).toBeNull();
  });

  it("合法 JSON 原样不动", () => {
    const input = JSON.stringify({
      ops: [{ action: "replaceText", find: "旧词", replace: "新词", all: true }],
    });

    const repaired = repairToolCallJson(input);

    expect(repaired).toEqual({ ok: true, json: input, changed: false });
    expect(repairDraftToolCallInput("editDraft", input)).toBeNull();
  });

  it("已转义双引号不被二次改坏", () => {
    const input = "{\"ops\":[{\"action\":\"replaceText\",\"find\":\"进入\\\"土地争夺\\\"阶段\",\"replace\":\"进入\\\"算力争夺\\\"阶段\"}]}";

    const repaired = repairToolCallJson(input);

    expect(repaired).toEqual({ ok: true, json: input, changed: false });
    const parsed = JSON.parse(input) as { ops: Array<{ find: string; replace: string }> };
    expect(parsed.ops[0]!.find).toBe("进入\"土地争夺\"阶段");
    expect(parsed.ops[0]!.replace).toBe("进入\"算力争夺\"阶段");
  });

  it("字符串值内合法的括号冒号逗号不误伤", () => {
    const input = JSON.stringify({
      ops: [{
        action: "replaceText",
        find: "正文里有 ] 和 }，也有 key:value, next",
        replace: "保留 ] } : ,",
      }],
    });

    const repaired = repairToolCallJson(input);

    expect(repaired).toEqual({ ok: true, json: input, changed: false });
  });

  it("截断 JSON 放弃修复", () => {
    const input = "{\"ops\":[{\"action\":\"replaceText\",\"find\":\"进入\"土地争夺";

    const repaired = repairToolCallJson(input);

    expect(repaired.ok).toBe(false);
    expect(repairDraftToolCallInput("editDraft", input)).toBeNull();
  });

  it("P3a list item op 可经真实 extractJson 处理 fence、前导/尾随散文和字符串括号", () => {
    const input = {
      ops: [{
        action: "replaceListItem",
        ref: "item-a",
        item: "<li>正文里包含 ] 和 }，也包含转义引号 \"quoted\"<ul><li>子项</li></ul></li>",
      }],
    };
    const raw = `已按行级结构编辑:\n\`\`\`json\n${JSON.stringify(input)}\n\`\`\`\n本轮只改这一行。`;

    const parsed = JSON.parse(extractJson(raw));
    const checked = editDraftInputSchema.safeParse(parsed);

    expect(checked.success).toBe(true);
    expect(checked.success ? checked.data.ops[0] : null).toMatchObject({
      action: "replaceListItem",
      ref: "item-a",
      item: expect.stringContaining("<li>正文里包含"),
    });
  });

  it("P3a list item op 只接受 QingML 字符串,旧对象 item 被 schema 拒绝", () => {
    const accepted = {
      ops: [{
        action: "insertListItem",
        parentRef: "list-a",
        at: "end",
        item: "<li>新增行<ul><li>子项</li></ul></li>",
      }],
    };

    const parsed = JSON.parse(extractJson(JSON.stringify(accepted)));
    const checked = editDraftInputSchema.safeParse(parsed);

    expect(checked.success).toBe(true);
    if (!checked.success) return;
    const op = checked.data.ops[0];
    if (!op) return;
    expect(op.action).toBe("insertListItem");
    if (op.action !== "insertListItem") return;
    expect(op.item).toContain("<li>新增行");

    const rejected = editDraftInputSchema.safeParse({
      ops: [{
        action: "insertListItem",
        parentRef: "list-a",
        at: "end",
        item: { runs: [{ text: "旧对象" }] },
      }],
    });
    expect(rejected.success).toBe(false);
  });

  it("P3a QingML item 字符串所在 JSON 截断时 fail-closed,不从半截结构捞内容", () => {
    const broken =
      '{"ops":[{"action":"replaceListItem","ref":"item-a","item":"<li>父<ul><li>子</li></ul></li>"}';

    expect(() => JSON.parse(extractJson(broken))).toThrow();
    expect(repairDraftToolCallInput("editDraft", broken)).toBeNull();
  });
});
