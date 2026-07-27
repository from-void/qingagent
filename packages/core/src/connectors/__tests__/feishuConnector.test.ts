import { describe, expect, it, vi } from "vitest";
import { FeishuConnector } from "../feishuConnector.js";
import { LARK_DEVICE_CODE, type LarkCliCommand, type LarkCliRunResult } from "../larkCliRunner.js";

const ok = (stdout = ""): LarkCliRunResult => ({ ok: true, stdout, stderr: "", cliVersion: "1.0.65", source: "path" });
const configured = JSON.stringify({ appId: "cli_test_app", brand: "feishu" });
const unconfigured = JSON.stringify({ appId: null, brand: "feishu" });
const ready = (scopes = ["docs:document:readonly"]) => JSON.stringify({ identities: { user: { available: true, status: "ready", userName: "测试用户", openId: "ou_test", scopes } } });
const missing = JSON.stringify({ identities: { user: { available: false, status: "missing" } } });
const device = JSON.stringify({ verification_url: "https://accounts.feishu.cn/device", user_code: "ABCD-EFGH", device_code: "secret-device-code", expires_in: 300 });
const deviceResult = (): LarkCliRunResult => ({ ok: true, stdout: device, stderr: "", cliVersion: "1.0.65", source: "path", [LARK_DEVICE_CODE]: "secret-device-code" });

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 30; i += 1) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("状态未在预期时间内收敛");
}

describe("FeishuConnector 授权编排", () => {
  it("不同 domains 的并发 start 不共享授权卡", async () => {
    let releaseConfig!: () => void;
    const configGate = new Promise<void>((resolve) => { releaseConfig = resolve; });
    let configStarted!: () => void;
    const configEntered = new Promise<void>((resolve) => { configStarted = resolve; });
    const run = vi.fn(async (command: LarkCliCommand, options?: { signal?: AbortSignal }): Promise<LarkCliRunResult> => {
      const key = command.join(" ");
      if (key === "config show") {
        configStarted();
        await configGate;
        return ok(configured);
      }
      if (key === "auth status --json") return ok(missing);
      if (key.includes("--no-wait")) return deviceResult();
      if (key.includes("--device-code")) {
        return new Promise<LarkCliRunResult>((resolve) => {
          options?.signal?.addEventListener("abort", () => resolve({
            ok: false,
            reasonCode: "LARK_CLI_FAILED",
            message: "aborted",
            cliVersion: "1.0.65",
            source: "path",
          }), { once: true });
        });
      }
      if (key === "auth logout") return ok();
      throw new Error(`unexpected ${key}`);
    });
    const connector = new FeishuConnector({ runner: { run } });

    const docsStart = connector.start({ domains: ["docs"] });
    await configEntered;
    const calendarOutcome = connector.start({ domains: ["calendar"] }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    releaseConfig();

    await expect(docsStart).resolves.toMatchObject({ mode: "authorization", user_code: "ABCD-EFGH" });
    await expect(calendarOutcome).resolves.toMatchObject({
      ok: false,
      error: { code: "FEISHU_AUTH_ALREADY_PENDING", status: 409 },
    });
    await connector.disconnect();
  });

  it("start 仅返回公开 DTO，后台收尾后 status 复核 connected", async () => {
    let loggedIn = false;
    const run = vi.fn(async (command: LarkCliCommand): Promise<LarkCliRunResult> => {
      const key = command.join(" ");
      if (key === "config show") return ok(configured);
      if (key.includes("--no-wait")) return deviceResult();
      if (key.includes("--device-code")) { loggedIn = true; return ok(); }
      if (key === "auth status --json") return ok(loggedIn ? ready() : missing);
      throw new Error(`unexpected ${key}`);
    });
    const connector = new FeishuConnector({ runner: { run } });
    const started = await connector.start({ domains: ["docs"] });
    expect(started).toMatchObject({ mode: "authorization", connectorId: "feishu", user_code: "ABCD-EFGH", pendingId: expect.any(String) });
    expect(JSON.stringify(started)).not.toContain("device_code");
    expect(JSON.stringify(started)).not.toContain("secret-device-code");
    const status = await eventually(() => connector.status(started.pendingId), (value) => value.state === "connected");
    expect(status).toMatchObject({ state: "connected", account: { displayName: "测试用户" } });
    expect(run.mock.calls.some(([argv]) => argv.join(" ").includes("auth login --device-code secret-device-code"))).toBe(true);
  });

  it.each([
    ["收尾失败", { ok: false, reasonCode: "LARK_CLI_FAILED", message: "failed", cliVersion: "1.0.65", source: "path" } as LarkCliRunResult, "LARK_CLI_FAILED"],
    ["收尾超时", { ok: false, reasonCode: "LARK_CLI_TIMEOUT", message: "timeout", cliVersion: "1.0.65", source: "path" } as LarkCliRunResult, "PENDING_EXPIRED"],
  ])("%s 后 pending 终止", async (_name, finishResult, reasonCode) => {
    const run = vi.fn(async (command: LarkCliCommand): Promise<LarkCliRunResult> => {
      const key = command.join(" ");
      if (key === "config show") return ok(configured);
      if (key.includes("--no-wait")) return deviceResult();
      if (key.includes("--device-code")) return finishResult;
      if (key === "auth status --json") return ok(missing);
      throw new Error(`unexpected ${key}`);
    });
    const connector = new FeishuConnector({ runner: { run } });
    const started = await connector.start({ domains: ["docs"] });
    const status = await eventually(() => connector.status(started.pendingId), (value) => value.state !== "pending");
    expect(status).toMatchObject({ state: "disconnected", reasonCode });
  });

  it("未配置时返回创建应用卡 DTO，并在完成后复查 config show", async () => {
    let configChecks = 0;
    const run = vi.fn(async (command: LarkCliCommand): Promise<LarkCliRunResult> => {
      const key = command.join(" ");
      if (key === "config show") return ok(++configChecks === 1 ? unconfigured : configured);
      if (key.startsWith("config init")) return ok("请打开 https://open.feishu.cn/verification/test 创建应用");
      throw new Error(`unexpected ${key}`);
    });
    const connector = new FeishuConnector({ runner: { run } });
    const started = await connector.start({ domains: ["docs"] });
    expect(started).toMatchObject({ mode: "configuration", connectorId: "feishu", configuration_url: "https://open.feishu.cn/verification/test" });
    const status = await eventually(() => connector.status(started.pendingId), (value) => value.state !== "pending");
    expect(status).toMatchObject({ state: "disconnected", reasonCode: "LARK_AUTH_MISSING" });
  });

  it("增量域授权失败保留原 connected 状态", async () => {
    const run = vi.fn(async (command: LarkCliCommand): Promise<LarkCliRunResult> => {
      const key = command.join(" ");
      if (key === "config show") return ok(configured);
      if (key === "auth status --json") return ok(ready(["docs"]));
      if (key.includes("--no-wait")) return deviceResult();
      if (key.includes("--device-code")) return { ok: false, reasonCode: "LARK_CLI_FAILED", message: "denied", cliVersion: "1.0.65", source: "path" };
      throw new Error(`unexpected ${key}`);
    });
    const connector = new FeishuConnector({ runner: { run } });
    const started = await connector.start({ domains: ["calendar"] });
    const status = await eventually(() => connector.status(started.pendingId), (value) => value.state !== "pending");
    expect(status).toMatchObject({ state: "connected", scopes: ["docs"], reasonCode: "LARK_CLI_FAILED" });
  });

  it("已有目标域权限时不重复发起 device flow", async () => {
    const run = vi.fn(async (command: LarkCliCommand): Promise<LarkCliRunResult> => {
      const key = command.join(" ");
      if (key === "config show") return ok(configured);
      if (key === "auth status --json") return ok(ready(["docs:document:readonly"]));
      throw new Error(`unexpected ${key}`);
    });
    const connector = new FeishuConnector({ runner: { run } });
    await expect(connector.start({ domains: ["docs"] })).rejects.toMatchObject({ code: "FEISHU_ALREADY_AUTHORIZED", status: 409 });
    expect(run.mock.calls.some(([argv]) => argv.join(" ").includes("--no-wait"))).toBe(false);
  });

  it("配置 pending 重入复用同一卡与后台进程", async () => {
    let resolveCompletion!: (value: LarkCliRunResult) => void;
    const completion = new Promise<LarkCliRunResult>((resolve) => { resolveCompletion = resolve; });
    const run = vi.fn(async (command: LarkCliCommand): Promise<LarkCliRunResult> => {
      if (command.join(" ") === "config show") return ok(unconfigured);
      throw new Error("不应走 fallback config init");
    });
    const startConfigInit = vi.fn(async () => ({
      initial: Promise.resolve(ok("https://open.feishu.cn/verification/reused")), completion,
    }));
    const connector = new FeishuConnector({ runner: { run, startConfigInit } });
    const first = await connector.start({ domains: ["docs"] });
    const second = await connector.start({ domains: ["docs"] });
    expect(second).toMatchObject({ pendingId: first.pendingId, reused: true, configuration_url: "https://open.feishu.cn/verification/reused" });
    expect(startConfigInit).toHaveBeenCalledTimes(1);
    resolveCompletion(ok());
  });
});
