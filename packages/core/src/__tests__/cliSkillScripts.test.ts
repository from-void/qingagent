import { describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// CLI skill 脚本冒烟:零依赖 node 脚本的参数解析 / 凭据缺失友好报错 / 退出码。
// 真实 API 调用需用户凭据(端到端在沙箱内验证),此处只测无凭据/坏参数的防御路径。

const SKILLS_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "skills",
  "capability",
);

function runScript(rel: string, args: string[], env: Record<string, string> = {}) {
  try {
    const stdout = execFileSync("node", [join(SKILLS_DIR, rel), ...args], {
      env: { PATH: process.env.PATH, ...env },
      encoding: "utf8",
    });
    return { exitCode: 0, json: JSON.parse(stdout.trim().split("\n").pop()!) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    const out = (err.stdout ?? "").trim().split("\n").pop() ?? "{}";
    return { exitCode: err.status ?? 1, json: JSON.parse(out) };
  }
}

describe("doc-calc 计算脚本", () => {
  function calc(op: string, input: string, extra: string[] = []): Promise<unknown> {
    return new Promise((resolve, reject) => {
      // Vitest worker 内的同步 stdin 在 Node 24 会死锁；产品命令 gate 也禁止管道，故这里
      // 按脚本正式接口走异步子进程 + --data，仍覆盖真实 argv/退出/输出链路。
      execFile(process.execPath, [join(SKILLS_DIR, "doc-calc/scripts/calc.mjs"), op, ...extra, "--data", input], {
        encoding: "utf8",
      }, (error, stdout) => {
        if (error) reject(error);
        else resolve(JSON.parse(stdout.trim()));
      });
    });
  }
  it("JSON 数组求和", async () => {
    await expect(calc("sum", "[1280,960,430,1875]")).resolves.toEqual({ sum: 4545, count: 4 });
  });
  it("逐行统计", async () => {
    await expect(calc("stats", "12\n34\n56")).resolves.toMatchObject({
      count: 3,
      sum: 102,
      avg: 34,
      min: 12,
      max: 56,
    });
  });
  it("按列求和(tab 分隔,容忍货币千分位)", async () => {
    await expect(calc("sumcol", "苹果\t¥1,280\n香蕉\t¥960", ["1"])).resolves.toEqual({
      sum: 2240,
      count: 2,
    });
  });
});

// 飞书改走官方 lark-cli(feishu skill),原手写 feishu.mjs 已删除——不再有飞书脚本防御路径测试。

describe("dingtalk 脚本防御路径", () => {
  it("无凭据 → 友好报错引导配置", () => {
    const r = runScript("dingtalk-docs/scripts/dingtalk.mjs", ["auth-check"]);
    expect(r.exitCode).toBe(1);
    expect(r.json.error).toContain("DINGTALK_APP_KEY");
    expect(r.json.hint).toContain("open-dev.dingtalk.com");
  });
});

describe("Round14 回归:平台脚本失败输出经管道不截断(writeSync 同步落 fd1)", () => {
  const scripts = [
    "dingtalk-docs/scripts/dingtalk.mjs",
  ];
  it("无凭据写操作经 execFileSync(管道)仍得到完整可解析 JSON", () => {
    for (const rel of scripts) {
      const r = runScript(rel, ["doc-create", "--title", "x"]);
      expect(r.exitCode, rel).toBe(1);
      expect(r.json.ok, rel).toBe(false);
      expect(typeof r.json.error, rel).toBe("string");
    }
  });
  it("源码不变量:fail/ok 用 writeSync 而非 process.stdout.write(避免 exit 截断异步写)", () => {
    for (const rel of scripts) {
      const src = readFileSync(join(SKILLS_DIR, rel), "utf8");
      expect(src, rel).toContain("writeSync(1,");
      expect(src, rel).not.toContain("process.stdout.write(JSON.stringify");
    }
  });
});
