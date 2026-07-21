import { describe, expect, it } from "vitest";
import {
  redactedSerializedText,
  redactSensitiveText,
  summarizeToolValue,
} from "../agent-run/redaction.js";
import {
  commandCardFromResult,
} from "../agent-run/toolCards.js";

describe("bridge redaction", () => {
  it("redacts secrets inside non-sensitive string fields in tool IO summaries", () => {
    expect(
      summarizeToolValue({
        message:
          "Authorization: Bearer spansecret123 {\"bearer_token\":\"jsonsecret\"}",
      }),
    ).toEqual({
      message:
        "Authorization: Bearer *** {\"bearer_token\":\"***\"}",
    });
  });

  it("Round10 回归:running placeholder 的 argsJson 序列化会脱敏(敏感字段 + 内嵌 token)", () => {
    const out = redactedSerializedText({
      api_key: "sk-secret123",
      note: "Authorization: Bearer leaktoken456",
    });
    expect(out).not.toContain("sk-secret123");
    expect(out).not.toContain("leaktoken456");
    expect(out).toContain("***");
  });

  it("Round11 回归:空格分隔 + 引号包裹的敏感值也脱敏(password 'x' / api_key \"x\" / --token 'x')", () => {
    for (const [input, secret] of [
      ["password 'mysecret1'", "mysecret1"],
      ["password \"mysecret2\"", "mysecret2"],
      ["api_key 'sk-secret6'", "sk-secret6"],
      ["--password 'pw7'", "pw7"],
      ["token 'tok8'", "tok8"],
    ] as const) {
      const out = redactSensitiveText(input);
      expect(out, input).not.toContain(secret);
      expect(out, input).toContain("***");
    }
    // 既有形态不回归
    expect(redactSensitiveText("password mysecret3")).toBe("password ***");
    expect(redactSensitiveText("password=mysecret4")).toBe("password=***");
  });

  it("Round17 回归:大写 env-var 风格凭据名在文本路径会脱敏", () => {
    for (const [input, secret] of [
      ["FEISHU_APP_SECRET=feishu-secret-1", "feishu-secret-1"],
      ["DINGTALK_APP_KEY=dingtalk-key-1", "dingtalk-key-1"],
      ["export FEISHU_APP_SECRET=feishu-secret-2", "feishu-secret-2"],
      ['{"FEISHU_APP_SECRET":"feishu-secret-3"}', "feishu-secret-3"],
      ["FEISHU_APP_SECRET: 'feishu-secret-4'", "feishu-secret-4"],
      ['FEISHU_APP_SECRET "feishu-secret-5"', "feishu-secret-5"],
    ] as const) {
      const out = redactSensitiveText(input);
      expect(out, input).not.toContain(secret);
      expect(out, input).toContain("***");
    }
  });

  it("Round17 回归:大写 env-var 风格凭据名在对象字段路径会脱敏", () => {
    const feishu = redactedSerializedText({
      FEISHU_APP_SECRET: "feishu-secret-6",
    });
    expect(feishu).toContain('"FEISHU_APP_SECRET":"***"');
    expect(feishu).not.toContain("feishu-secret-6");

    const dingtalk = redactedSerializedText({
      DINGTALK_APP_KEY: "dingtalk-key-2",
    });
    expect(dingtalk).toContain('"DINGTALK_APP_KEY":"***"');
    expect(dingtalk).not.toContain("dingtalk-key-2");
  });

  it("Round17 回归:env-var 脱敏不误伤公开 app id 和普通词", () => {
    expect(redactSensitiveText("FEISHU_APP_ID=cli_public_id")).toBe(
      "FEISHU_APP_ID=cli_public_id",
    );
    expect(redactSensitiveText("monkey")).toBe("monkey");
    expect(redactSensitiveText("donkey business")).toBe("donkey business");
    expect(redactSensitiveText("keyboard")).toBe("keyboard");
    expect(redactSensitiveText("turkey")).toBe("turkey");
    expect(redactSensitiveText("ordinary prose without credentials.")).toBe(
      "ordinary prose without credentials.",
    );
  });

  it("Round11 回归:redactedSerializedText 对超长输入封顶截断,不无界膨胀", () => {
    const huge = { code: "x".repeat(500_000) };
    const out = redactedSerializedText(huge);
    expect(out.length).toBeLessThan(60 * 1024);
    expect(out).toContain("[truncated]");
  });
});

describe("commandCardFromResult 状态映射(Round10)", () => {
  it("旧字符串结果里的非零退出也 fail-closed，不再显示已完成", () => {
    const card = commandCardFromResult({ command: "node x" }, "boom\nExit code: 2", true);
    expect(card.exitCode).toBe(2);
    expect(card.phase).toBe("failed");
    expect(card.outputTail).toBe("boom");
  });

  it("结构化非零退出直接落 failed，不靠文本前缀推断", () => {
    const card = commandCardFromResult({ command: "node x" }, {
      success: false,
      exitCode: 2,
      cancelled: false,
      timedOut: false,
      output: "boom",
    }, false);
    expect(card.exitCode).toBe(2);
    expect(card.phase).toBe("failed");
  });

  it("catch 路径 'Error: ...'(无 Exit code)→ failed,不再误渲完成", () => {
    const card = commandCardFromResult({ command: "node x" }, "Error: spawn failed", false);
    expect(card.phase).toBe("failed");
    expect(card.exitCode).not.toBe(0);
  });

  it("正常成功输出 → done", () => {
    const card = commandCardFromResult({ command: "node calc.mjs sum" }, "{\"sum\":6}", true);
    expect(card.phase).toBe("done");
    expect(card.exitCode).toBe(0);
  });

  it("命令卡输出脱敏:Bearer token 不外泄", () => {
    const card = commandCardFromResult(
      { command: "curl -H 'Authorization: Bearer secrettok'" },
      "ok",
      true,
    );
    expect(card.command).not.toContain("secrettok");
  });
});
