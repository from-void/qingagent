import { describe, expect, it } from "vitest";
import {
  credentialFailureNotice,
  diagnoseCredentialFailure,
} from "../credentials/credentialFailureDiagnosis.js";
import { credentialFailureNoticeFor } from "../workspace/gatedExecuteCommandTool.js";

/**
 * 用例语料直接取自 0729 真机 macOS 的原始日志形态(脏路径:英文报错 + 结构化 kv + 混排中文),
 * 而不是理想化的短句——归因就是要对付这种真实脏输入。
 */
const REAL_KEYCHAIN_LOG = [
  `time="2026-07-29T10:12:03+08:00" level=info msg="polling success, token obtained"`,
  `time="2026-07-29T10:12:03+08:00" level=error msg="key access denied" service="AntOAuthSDK" account="htnn-gateway-master-key" reason="denied"`,
  `time="2026-07-29T10:12:03+08:00" level=warn msg="Poll after PKCE resume failed, returning auth URL for manual retry" error="Keychain access denied by user"`,
].join("\n");

const REAL_EPERM_LOG = [
  "polling success, token obtained",
  "Failed to save starpoint cache EPERM: operation not permitted, open '/Users/tester/.identitymcp/starpoint_cache.json'",
].join("\n");

describe("扫码成功但凭据保存失败,绝不能归因成用户没扫码", () => {
  it("钥匙串被拒的真实日志判为保存失败,并标记授权已完成", () => {
    const diagnosis = diagnoseCredentialFailure({ output: REAL_KEYCHAIN_LOG });
    expect(diagnosis?.kind).toBe("credential-save-failed");
    expect(diagnosis?.authCompleted).toBe(true);
    // 已经拿到凭据就不该再鼓励原样重试。
    expect(diagnosis?.retryable).toBe(false);
  });

  it("写盘 EPERM 的真实日志同样判为保存失败", () => {
    const diagnosis = diagnoseCredentialFailure({ output: REAL_EPERM_LOG });
    expect(diagnosis?.kind).toBe("credential-save-failed");
    expect(diagnosis?.authCompleted).toBe(true);
  });

  it("给模型的说明明确堵死「用户没扫码」与「再出一张码」", () => {
    const diagnosis = diagnoseCredentialFailure({ output: REAL_KEYCHAIN_LOG });
    const notice = credentialFailureNotice(diagnosis!);
    expect(notice).toContain("授权/扫码环节已经完成");
    expect(notice).toContain("禁止再调用 show_qr");
    expect(notice).toMatch(/禁止再说「你没有完成扫码」/);
    // 用户可见那句话不得出现英文原文与内部路径。
    expect(diagnosis!.userMessage).not.toMatch(/[A-Za-z]{4,}/);
    expect(diagnosis!.userMessage).not.toContain("/Users/");
    expect(diagnosis!.userMessage).not.toContain("~/");
  });

  it("保存失败时不得把结果当成授权成功", () => {
    const diagnosis = diagnoseCredentialFailure({ output: REAL_KEYCHAIN_LOG });
    // authCompleted 只代表"扫码这一步过了",绝不代表整体登录成功。
    expect(diagnosis?.userMessage).toContain("没能保存");
    expect(diagnosis?.userMessage).toContain("还是显示未登录");
  });
});

describe("各失败态分档互不混淆", () => {
  it("还在等扫码 = qr-pending,是唯一可以说「请扫码」的一档", () => {
    const diagnosis = diagnoseCredentialFailure({
      output: "authorization_pending, waiting for user to scan the QR code",
    });
    expect(diagnosis?.kind).toBe("qr-pending");
    expect(diagnosis?.authCompleted).toBe(false);
    expect(diagnosis?.userNextStep).toContain("扫描");
  });

  it("二维码过期 = qr-expired", () => {
    const diagnosis = diagnoseCredentialFailure({ output: "device_code expired, please retry" });
    expect(diagnosis?.kind).toBe("qr-expired");
    expect(diagnosis?.authCompleted).toBe(false);
  });

  it("CLI 自己报授权超时 = cli-auth-timeout,不是我们掐的", () => {
    const diagnosis = diagnoseCredentialFailure({ output: "Authorization timeout." });
    expect(diagnosis?.kind).toBe("cli-auth-timeout");
  });

  it("被我们超时终止的登录命令 = sandbox-timeout,并澄清不是用户的问题", () => {
    const diagnosis = diagnoseCredentialFailure({
      output: "waiting for authorization ...",
      timedOut: true,
    });
    expect(diagnosis?.kind).toBe("sandbox-timeout");
    expect(diagnosis?.userMessage).toContain("不是你的授权出了问题");
  });

  it("与登录无关的普通超时不归本模块管,免得和超时归因那条线打架", () => {
    expect(diagnoseCredentialFailure({ output: "Exit code: -1", timedOut: true })).toBeNull();
    expect(credentialFailureNoticeFor({ output: "Exit code: -1", timedOut: true })).toBe("");
  });

  it("判不出来就返回 null,绝不瞎归因", () => {
    expect(diagnoseCredentialFailure({ output: "ls: cannot access 'x': No such file" })).toBeNull();
    expect(diagnoseCredentialFailure({ output: "" })).toBeNull();
  });

  it("拿到凭据之后的超时依然优先判成保存失败,不退回超时叙事", () => {
    const diagnosis = diagnoseCredentialFailure({
      output: `${REAL_KEYCHAIN_LOG}\nAuthorization timeout.`,
      timedOut: true,
    });
    expect(diagnosis?.kind).toBe("credential-save-failed");
    expect(diagnosis?.authCompleted).toBe(true);
  });
});

describe("验证登录态的口径不得混淆普通 whoami 与 --force", () => {
  it("每一档说明都要求用只读子命令、点名禁止 --force", () => {
    const outputs = [
      REAL_KEYCHAIN_LOG,
      "device_code expired",
      "Authorization timeout.",
      "authorization_pending",
    ];
    for (const output of outputs) {
      const diagnosis = diagnoseCredentialFailure({ output });
      expect(diagnosis).not.toBeNull();
      const notice = credentialFailureNotice(diagnosis!);
      expect(notice).toContain("whoami");
      expect(notice).toContain("--force");
      expect(notice).toContain("强制重新认证");
    }
  });

  it("show_qr 的编排口径同样写死这两条,避免模型自行发挥", async () => {
    const { showQrTool } = await import("../tools/showQr.js");
    const description = showQrTool.description ?? "";
    expect(description).toContain("禁止重复出码");
    expect(description).toContain("你没有完成扫码");
    expect(description).toContain("--force");
    expect(description).toContain("whoami");
  });
});
