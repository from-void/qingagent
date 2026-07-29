import { describe, expect, it } from "vitest";
import {
  cancelConfirmedCommandSchema,
  confirmDecisionForSpecSchema,
  confirmSpecSchema,
  submitConfirmDecisionSchema,
} from "../confirm";
import type { ConfirmSpec } from "../../Confirm";

const plainSpec: ConfirmSpec = {
  id: "confirm-1",
  kind: "command",
  title: "执行命令",
  say: "将执行一次需要确认的命令",
  primaryLabel: "确认执行",
  secondaryLabel: "取消",
};

describe("confirm contract schemas", () => {
  it.each(["install", "connect", "send", "command"] as const)(
    "解析 kind=%s",
    (kind) => {
      expect(confirmSpecSchema.parse({ ...plainSpec, kind }).kind).toBe(kind);
    },
  );

  it("footHint 可选，提供时仍校验非空与长度", () => {
    expect(confirmSpecSchema.parse(plainSpec).footHint).toBeUndefined();
    expect(confirmSpecSchema.safeParse({ ...plainSpec, footHint: "只授权本次调用" }).success).toBe(true);
    expect(confirmSpecSchema.safeParse({ ...plainSpec, footHint: "" }).success).toBe(false);
    expect(confirmSpecSchema.safeParse({ ...plainSpec, footHint: "x".repeat(301) }).success).toBe(false);
  });

  it("commandPreview 是通用可选字段且最多 2000 字符", () => {
    const commandPreview = "npx skills add ffmpeg";
    expect(confirmSpecSchema.parse({
      ...plainSpec,
      kind: "connect",
      commandPreview,
    }).commandPreview).toBe(commandPreview);
    expect(confirmSpecSchema.safeParse({
      ...plainSpec,
      commandPreview: "x".repeat(2_000),
    }).success).toBe(true);
    expect(confirmSpecSchema.safeParse({
      ...plainSpec,
      commandPreview: "x".repeat(2_001),
    }).success).toBe(false);
  });

  it("rememberCategory 四类可记住(0728解锁),类别与卡片kind不匹配及未声明卡片的 remember 仍拒", () => {
    const remembered = confirmSpecSchema.parse({
      ...plainSpec,
      rememberCategory: {
        kind: "command",
        label: "后续此类命令都默认同意",
      },
    });
    expect(confirmDecisionForSpecSchema(remembered).safeParse({
      id: remembered.id,
      accepted: true,
      remember: true,
      uiGrantNonce: "nonce-1",
    }).success).toBe(true);
    expect(confirmDecisionForSpecSchema(plainSpec).safeParse({
      id: plainSpec.id,
      accepted: true,
      remember: true,
    }).success).toBe(false);
    // 0728 安全解锁:send/connect 也可配置记住,send 同类 rememberCategory 转为合法
    expect(confirmSpecSchema.safeParse({
      ...plainSpec,
      kind: "send",
      rememberCategory: { kind: "send", label: "对外发送内容" },
    }).success).toBe(true);
    expect(confirmSpecSchema.safeParse({
      ...plainSpec,
      kind: "install",
      rememberCategory: { kind: "command", label: "错误类别" },
    }).success).toBe(false);
  });

  it("bypassAll 只在卡片声明了勾选项且用户点同意时合法", () => {
    const withBypass = confirmSpecSchema.parse({
      ...plainSpec,
      bypassOption: {
        label: "以后不用再问我",
        hint: "以后的命令会直接执行；可以在 设置 → 安全 里改回。",
      },
    });
    expect(confirmDecisionForSpecSchema(withBypass).safeParse({
      id: withBypass.id,
      accepted: true,
      bypassAll: true,
    }).success).toBe(true);
    // 卡片没声明就不能借决策关掉询问
    expect(confirmDecisionForSpecSchema(plainSpec).safeParse({
      id: plainSpec.id,
      accepted: true,
      bypassAll: true,
    }).success).toBe(false);
    // 拒绝态一律不许携带
    expect(submitConfirmDecisionSchema.safeParse({
      sessionId: "s",
      toolCallId: "t",
      decisionId: "d",
      decision: { id: plainSpec.id, accepted: false, bypassAll: true },
    }).success).toBe(false);
    // 文案有上界,不能塞进长文本
    expect(confirmSpecSchema.safeParse({
      ...plainSpec,
      bypassOption: { label: "以后不用再问我", hint: "x".repeat(301) },
    }).success).toBe(false);
    expect(confirmSpecSchema.safeParse({
      ...plainSpec,
      bypassOption: { label: "", hint: "有效说明" },
    }).success).toBe(false);
  });

  it("拒绝态 remember 合法但仍不能携带 UI grant nonce", () => {
    expect(submitConfirmDecisionSchema.safeParse({
      sessionId: "s",
      toolCallId: "t",
      decisionId: "d",
      decision: {
        id: plainSpec.id,
        accepted: false,
        remember: true,
      },
    }).success).toBe(true);
    expect(submitConfirmDecisionSchema.safeParse({
      sessionId: "s",
      toolCallId: "t",
      decisionId: "d",
      decision: {
        id: plainSpec.id,
        accepted: false,
        remember: true,
        uiGrantNonce: "nonce",
      },
    }).success).toBe(false);
    expect(submitConfirmDecisionSchema.safeParse({
      sessionId: "s",
      toolCallId: "t",
      decisionId: "d",
      decision: {
        id: plainSpec.id,
        accepted: true,
        uiGrantNonce: "nonce",
      },
    }).success).toBe(false);
  });

  it("解析 options 与 secretInput，并按当前 spec 校验接受字段", () => {
    const optionsSpec = confirmSpecSchema.parse({
      ...plainSpec,
      widget: {
        type: "options",
        options: [
          { value: "safe", label: "安全模式", recommended: true },
          { value: "fast", label: "快速模式", description: "减少检查" },
        ],
      },
    });
    expect(
      confirmDecisionForSpecSchema(optionsSpec).parse({
        id: plainSpec.id,
        accepted: true,
        optionValue: "safe",
      }).optionValue,
    ).toBe("safe");

    const secretSpec = confirmSpecSchema.parse({
      ...plainSpec,
      kind: "connect",
      widget: { type: "secretInput", placeholder: "粘贴令牌" },
    });
    expect(
      confirmDecisionForSpecSchema(secretSpec).parse({
        id: plainSpec.id,
        accepted: true,
        secretValue: "  keep-original-bytes  ",
      }).secretValue,
    ).toBe("  keep-original-bytes  ");
  });

  it("拒绝 reject 携带 option/secret", () => {
    expect(
      submitConfirmDecisionSchema.safeParse({
        sessionId: "s",
        toolCallId: "t",
        decisionId: "d",
        decision: { id: "c", accepted: false, secretValue: "sentinel" },
      }).success,
    ).toBe(false);
    expect(
      submitConfirmDecisionSchema.safeParse({
        sessionId: "s",
        toolCallId: "t",
        decisionId: "d",
        decision: { id: "c", accepted: false, optionValue: "x" },
      }).success,
    ).toBe(false);
  });

  it("拒绝重复 option value 与多个 recommended", () => {
    const duplicate = confirmSpecSchema.safeParse({
      ...plainSpec,
      widget: {
        type: "options",
        options: [
          { value: "same", label: "A", recommended: true },
          { value: "same", label: "B", recommended: true },
        ],
      },
    });
    expect(duplicate.success).toBe(false);
  });

  it("拒绝未知 widget/未知字段、非法 option 与空白或超长 secret，错误不回显 secret", () => {
    expect(
      confirmSpecSchema.safeParse({
        ...plainSpec,
        widget: { type: "unknown", value: "x" },
      }).success,
    ).toBe(false);
    expect(confirmSpecSchema.safeParse({ ...plainSpec, extra: true }).success).toBe(false);

    const optionSpec: ConfirmSpec = {
      ...plainSpec,
      widget: { type: "options", options: [{ value: "a", label: "A" }] },
    };
    expect(
      confirmDecisionForSpecSchema(optionSpec).safeParse({
        id: plainSpec.id,
        accepted: true,
        optionValue: "missing",
      }).success,
    ).toBe(false);

    const sentinel = "SECRET_SENTINEL_MUST_NOT_APPEAR";
    const secretSpec: ConfirmSpec = {
      ...plainSpec,
      widget: { type: "secretInput", placeholder: "令牌" },
    };
    const blank = confirmDecisionForSpecSchema(secretSpec).safeParse({
      id: plainSpec.id,
      accepted: true,
      secretValue: "   ",
    });
    expect(blank.success).toBe(false);
    expect(blank.success ? [] : blank.error.issues).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ input: expect.anything() })]),
    );

    const tooLong = submitConfirmDecisionSchema.safeParse({
      sessionId: "s",
      toolCallId: "t",
      decisionId: "d",
      decision: {
        id: "c",
        accepted: true,
        secretValue: `${sentinel}${"x".repeat(8_192)}`,
      },
    });
    expect(tooLong.success).toBe(false);
    expect(tooLong.success ? "" : tooLong.error.message).not.toContain(sentinel);
  });

  it("卡级停止必须同时携带非空 sessionId 与 toolCallId", () => {
    expect(cancelConfirmedCommandSchema.parse({
      sessionId: "session-1",
      toolCallId: "tool-1",
    })).toEqual({ sessionId: "session-1", toolCallId: "tool-1" });
    expect(cancelConfirmedCommandSchema.safeParse({
      sessionId: "session-1",
      toolCallId: "",
    }).success).toBe(false);
  });
});
