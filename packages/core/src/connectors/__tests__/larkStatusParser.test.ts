import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { FeishuConnector } from "../feishuConnector.js";
import { LarkCliRunner, redactLarkCliOutput } from "../larkCliRunner.js";
import { parseLarkAuthStatusOutput, parseLarkConfigOutput, parseLarkDeviceFlowOutput } from "../larkStatusParser.js";

const fixture = (name: string) => readFileSync(
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
  "utf8",
);

describe("lark-cli 1.0.65 真实脱敏 fixture", () => {
  it("解析 config show 的 JSON 与尾随路径", () => {
    const result = parseLarkConfigOutput(fixture("lark-cli-1.0.65-config-show.txt"));
    expect(result).toMatchObject({ ok: true, value: { configured: true, brand: "feishu" } });
  });

  it("needs_refresh 仍是 connected，scope 可解析", () => {
    const result = parseLarkAuthStatusOutput(fixture("lark-cli-1.0.65-auth-status.json"));
    expect(result).toMatchObject({
      ok: true,
      value: {
        connected: true,
        needsReauth: false,
        scopes: ["docs:document.content:read", "calendar:calendar.event:read", "offline_access"],
      },
    });
  });

  it("从没登录过的真实形状(status:missing 且无 token 痕迹)判为未连接,不谎称授权失效", () => {
    // 实测 `lark-cli auth status --json`(1.0.65,本机无用户身份):user 只有
    // status/available/message/hint,没有 tokenStatus。
    expect(parseLarkAuthStatusOutput(fixture("lark-cli-1.0.65-auth-status-user-missing.json"))).toEqual({
      ok: true,
      value: { connected: false, needsReauth: false, account: null, scopes: null },
    });
  });

  it("status:missing 叠加 tokenStatus:expired 仍判为需要重新授权", () => {
    expect(parseLarkAuthStatusOutput(fixture("lark-cli-1.0.65-auth-status-user-expired.json"))).toMatchObject({
      ok: true,
      value: { connected: false, needsReauth: true },
    });
  });

  it("状态取值不认识时回退看 token 维度", () => {
    expect(parseLarkAuthStatusOutput(JSON.stringify({
      identities: { user: { available: false, status: "logged_out", tokenStatus: "revoked" } },
    }))).toMatchObject({ ok: true, value: { connected: false, needsReauth: true } });
    // 认识的连接态不被 token 维度推翻。
    expect(parseLarkAuthStatusOutput(JSON.stringify({
      identities: { user: { available: true, status: "ready", tokenStatus: "expired" } },
    }))).toMatchObject({ ok: true, value: { connected: true, needsReauth: false } });
  });

  it.each([
    "garbage",
    '{"identities":{"user":{"available":true}}}',
    '{"identities":{"user":{"available":"yes","status":"ready"}}}',
    '{"identities":{"user":{"available":true,"status":"ready"}',
  ])("核心字段脏输出不误报 connected: %s", (raw) => {
    expect(parseLarkAuthStatusOutput(raw)).toMatchObject({ ok: false, reasonCode: "LARK_CLI_DIRTY_OUTPUT" });
  });

  it("只有 scopes 形状脏时保留 connected 但域未知", () => {
    expect(parseLarkAuthStatusOutput(JSON.stringify({
      identities: { user: { available: true, status: "ready", scopes: { dirty: true } } },
    }))).toEqual({
      ok: true,
      value: { connected: true, needsReauth: false, account: null, scopes: null },
    });
  });
});

describe("LarkCliRunner", () => {
  it("只执行固定 argv，PATH 兜底公开 cliVersion 并脱敏输出", async () => {
    const execFile = vi.fn(async (_file: string, args: readonly string[]) => args[0] === "--version"
      ? { stdout: "lark-cli version 1.0.65", stderr: "" }
      : { stdout: '{"appSecret":"real-secret","status":"ready"}', stderr: "" });
    const runner = new LarkCliRunner({ execFile, shimPath: "/definitely/missing/lark-cli" });
    const result = await runner.run(["config", "show"]);
    expect(result).toMatchObject({ ok: true, source: "path", cliVersion: "1.0.65" });
    expect(result.ok && result.stdout).not.toContain("real-secret");
    expect(execFile).toHaveBeenLastCalledWith("lark-cli", ["config", "show"], expect.objectContaining({
      timeout: 8_000,
      maxBuffer: 128 * 1024,
    }));
    await expect(runner.run(["auth", "login"] as never)).rejects.toThrow("固定白名单");
  });

  it("缺失、超时与未知版本分别降级", async () => {
    const missing = new LarkCliRunner({
      shimPath: "/missing",
      execFile: async () => { throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }); },
    });
    await expect(missing.run(["config", "show"])).resolves.toMatchObject({ ok: false, reasonCode: "LARK_CLI_MISSING" });

    const timeout = new LarkCliRunner({
      shimPath: "/missing",
      execFile: async () => { throw Object.assign(new Error("timeout"), { killed: true }); },
    });
    await expect(timeout.run(["config", "show"])).resolves.toMatchObject({ ok: false, reasonCode: "LARK_CLI_VERSION_TIMEOUT" });

    const unknown = new LarkCliRunner({
      shimPath: "/missing",
      execFile: async () => ({ stdout: "lark-cli version 1.1.0", stderr: "" }),
    });
    await expect(unknown.run(["config", "show"])).resolves.toMatchObject({
      ok: false,
      reasonCode: "LARK_CLI_VERSION_UNSUPPORTED",
      cliVersion: "1.1.0",
    });
  });

  it("脱敏 token/secret", () => {
    const redacted = redactLarkCliOutput('appSecret: abc access_token=xyz Authorization: Bearer abc+/def==');
    expect(redacted).not.toContain("abc");
    expect(redacted).not.toContain("xyz");
    expect(redacted).not.toContain("bearer-value");
  });
});

describe("FeishuConnector", () => {
  it("两命令顺序执行并映射 connected", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ ok: true, stdout: fixture("lark-cli-1.0.65-config-show.txt"), stderr: "", cliVersion: "1.0.65", source: "path" })
      .mockResolvedValueOnce({ ok: true, stdout: fixture("lark-cli-1.0.65-auth-status.json"), stderr: "", cliVersion: "1.0.65", source: "path" });
    const status = await new FeishuConnector({ run }).status();
    expect(run.mock.calls.map(([argv]) => argv)).toEqual([
      ["config", "show"],
      ["auth", "status", "--json"],
    ]);
    expect(status).toMatchObject({ state: "connected", cliVersion: "1.0.65" });
  });

  it("config 核心字段脏时短路，不调用 auth status", async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, stdout: "garbage", stderr: "", cliVersion: "1.0.65", source: "path" });
    const status = await new FeishuConnector({ run }).status();
    expect(status).toMatchObject({ state: "checking", reasonCode: "LARK_CLI_DIRTY_OUTPUT" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("冷启动版本超时先返回检查中，延后重试后自愈为真实 needs_reauth", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        reasonCode: "LARK_CLI_VERSION_TIMEOUT",
        message: "cold start timeout",
        cliVersion: null,
        source: "path",
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: fixture("lark-cli-1.0.65-config-show.txt"),
        stderr: "",
        cliVersion: "1.0.65",
        source: "path",
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: fixture("lark-cli-1.0.65-auth-status-user-expired.json"),
        stderr: "",
        cliVersion: "1.0.65",
        source: "path",
      });
    const connector = new FeishuConnector({ run });

    await expect(connector.status()).resolves.toMatchObject({
      state: "checking",
      reasonCode: "LARK_CLI_VERSION_TIMEOUT",
      statusFreshness: "unknown",
    });
    await expect(connector.status()).resolves.toMatchObject({
      state: "needs_reauth",
      reasonCode: "LARK_AUTH_EXPIRED",
      statusFreshness: "fresh",
    });
  });
});

describe("parseLarkDeviceFlowOutput", () => {
  // 形状取自真机实测 lark-cli 1.0.53 `auth login --no-wait --json` 的原始 stdout:
  // 顶层只有 device_code/expires_in/hint/verification_url,user_code 嵌在 URL 查询参数里。
  it("接受真实 CLI 输出:顶层无 user_code,从 verification_url 派生", () => {
    const real = JSON.stringify({
      device_code: "O04p0Ry4tuIP.example",
      expires_in: 600,
      hint: "**MUST generate QR code AND display it:** ...",
      verification_url: "https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=ONMIOg&user_code=J2KQ",
    });
    const parsed = parseLarkDeviceFlowOutput(real);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.deviceCode).toBe("O04p0Ry4tuIP.example");
      expect(parsed.value.expiresIn).toBe(600);
      expect(parsed.value.userCode).toBe("J2KQ");
    }
  });

  it("顶层带 user_code 时优先用顶层值", () => {
    const parsed = parseLarkDeviceFlowOutput(JSON.stringify({
      device_code: "d", expires_in: 300, user_code: "TOP",
      verification_url: "https://accounts.feishu.cn/verify?user_code=URL",
    }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.userCode).toBe("TOP");
  });

  it("URL 里也没有 user_code 时为 null 而不判脏", () => {
    const parsed = parseLarkDeviceFlowOutput(JSON.stringify({
      device_code: "d", expires_in: 300,
      verification_url: "https://accounts.feishu.cn/verify?flow_id=x",
    }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.userCode).toBeNull();
  });

  it("缺 device_code 或 expires_in 非法仍判脏", () => {
    expect(parseLarkDeviceFlowOutput(JSON.stringify({
      expires_in: 600, verification_url: "https://a.b/v",
    })).ok).toBe(false);
    expect(parseLarkDeviceFlowOutput(JSON.stringify({
      device_code: "d", expires_in: "600", verification_url: "https://a.b/v",
    })).ok).toBe(false);
  });
});
