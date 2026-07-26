import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { FeishuConnector } from "../feishuConnector.js";
import { LarkCliRunner, redactLarkCliOutput } from "../larkCliRunner.js";
import { parseLarkAuthStatusOutput, parseLarkConfigOutput } from "../larkStatusParser.js";

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
    expect(status).toMatchObject({ state: "unavailable", reasonCode: "LARK_CLI_DIRTY_OUTPUT" });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
