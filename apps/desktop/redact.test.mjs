// redact.ts 对抗性输入回归测试(AGENTS.md:防御性函数必配对抗性输入测试)。
// 运行:node --import tsx --test redact.test.mjs(已并入 pnpm --filter @qingagent/desktop test)。
import { test } from "node:test";
import assert from "node:assert";
import { redactPotentialPii } from "./src/main/telemetry/redact.ts";

test("路径脱敏:本机路径 → [path]", () => {
  assert.ok(!redactPotentialPii("read /home/user/secret/doc.txt").includes("/home/user"));
  assert.ok(!redactPotentialPii("open C:\\Users\\bob\\x.txt").includes("bob"));
  assert.ok(!redactPotentialPii("at file:///Users/alice/p.txt").includes("alice"));
  assert.ok(redactPotentialPii("read /home/user/x").includes("[path]"));
});

test("密钥脱敏:各形态(含 R4 回归:JSON 引号键 / Bearer)", () => {
  const cases = [
    ["api_key=ABC123DEF456", "ABC123DEF456"],
    ["apikey:ABC123DEF456", "ABC123DEF456"],
    ["token=ABC123DEF456", "ABC123DEF456"],
    ['{"secret":"JSONSECRETVAL123"}', "JSONSECRETVAL123"], // R4-A/B 回归
    ['{"token": "JSONTOKENVAL999"}', "JSONTOKENVAL999"],
    ["password=hunter2hunter", "hunter2hunter"],
    ["authorization: Bearer ABC123BEARERTOKEN", "ABC123BEARERTOKEN"], // R4-B 回归
    ["use sk-ABCDEF123456 now", "sk-ABCDEF123456"],
    ["ghp_ABCDEF123456789", "ghp_ABCDEF123456789"],
    ["glpat-ABCDEF123456", "glpat-ABCDEF123456"],
    ["jwt eyJhbGciOiAB.eyJzdWIiOiCD.SflKxwRJ12", "eyJhbGciOiAB.eyJzdWIiOiCD.SflKxwRJ12"],
    ["a token=TOK111AAAA and api_key=KEY222BBBB", "TOK111AAAA"],
    ["a token=TOK111AAAA and api_key=KEY222BBBB", "KEY222BBBB"],
  ];
  for (const [input, secret] of cases) {
    const r = redactPotentialPii(input);
    assert.ok(!r.includes(secret), `密钥应被脱敏: "${input}" -> "${r}"`);
  }
});

test("不误伤正常文本(含 R4 回归:普通 https URL)", () => {
  const keep = [
    "the key feature is great",
    "he acted secretly",
    "id 550e8400-e29b-41d4-a716-446655440000",
    "version 1.2.3",
    "see https://example.com/docs/page?tab=overview#section", // R4-B 回归:勿误伤
    "at telemetry-inject.ts:120:15",
    "Cannot read properties of undefined (reading 'foo')",
  ];
  for (const k of keep) {
    assert.equal(redactPotentialPii(k), k, `不应改动: "${k}"`);
  }
});

test("截断配合:超长不抛、返回字符串", () => {
  const long = "token=" + "A".repeat(20000);
  const r = redactPotentialPii(long);
  assert.equal(typeof r, "string");
  assert.ok(!r.includes("AAAAAAAAAA"));
});
