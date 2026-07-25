import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
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
