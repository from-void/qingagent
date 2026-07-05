import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BUILTIN_SKILLS_DIR } from "../skills/paths.js";
import { evaluateCommandPolicy } from "../workspace/commandPolicy.js";

// 回归:执行前 gate 拒绝一切管道/重定向,而 doc-calc 原本只支持 `echo ... | node calc.mjs`(stdin),
// 等于被 gate 打死。calc.mjs 新增 --json/--file 入参后必须:① 脚本本身能从这两条路读数;
// ② gate 放行文档里的新调用;③ 旧管道喂数仍被拒(这正是改文档的原因)。

const calc = join(BUILTIN_SKILLS_DIR, "capability", "doc-calc", "scripts", "calc.mjs");

type CalcModule = {
  calculateFromArgs: (argv: string[], stdinText?: string) => unknown;
};

let calcModule: CalcModule;

beforeAll(async () => {
  calcModule = await import(pathToFileURL(calc).href) as CalcModule;
});

function runCalc(args: string[], input?: string): unknown {
  return calcModule.calculateFromArgs(args, input);
}

function execCalc(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [calc, ...args], (error, stdout, stderr) => {
      const exitCode = typeof (error as { code?: unknown } | null)?.code === "number"
        ? (error as { code: number }).code
        : 0;
      resolve({ exitCode, stdout, stderr });
    });
  });
}

describe("doc-calc 喂数(gate 兼容)", () => {
  it("--json 内联数组求和", () => {
    expect(runCalc(["sum", "--json", "[1280, 960, 430, 1875]"])).toEqual({
      sum: 4545,
      count: 4,
    });
  });

  it("--json stats", () => {
    expect(runCalc(["stats", "--json", "[12, 34, 56]"])).toMatchObject({
      count: 3,
      sum: 102,
      avg: 34,
      min: 12,
      max: 56,
    });
  });

  it("JSON 数组路径忽略空白串和非数值占位符", () => {
    expect(runCalc(["stats", "--json", JSON.stringify(["缺失", "N/A", ""])])).toEqual({
      error: "no numbers parsed from input",
      count: 0,
    });
    expect(runCalc(["sum", "--json", "[1,\"\",3]"])).toEqual({ sum: 4, count: 2 });
  });

  it("Round12 回归:JSON 数组里的货币/千分位字符串不再被静默漏算", () => {
    // 之前 ["$1,000", 2] 只算出 2(Number(\"$1,000\")=NaN 被丢),现在货币感知解析 → 1000。
    expect(runCalc(["sum", "--json", JSON.stringify(["$1,000", 2])])).toEqual({ sum: 1002, count: 2 });
    expect(runCalc(["sum", "--json", JSON.stringify(["¥1,280", "-$30"])])).toEqual({ sum: 1250, count: 2 });
    // 纯占位符仍丢弃(不被误当 0)
    expect(runCalc(["stats", "--json", JSON.stringify(["缺失", "N/A"])])).toMatchObject({
      error: "no numbers parsed from input",
    });
  });

  it("Round12 回归:全角数字/全角千分位归一化(中文文档常见)", () => {
    expect(runCalc(["sum", "--json", JSON.stringify(["１２３", 2])])).toEqual({ sum: 125, count: 2 });
    expect(runCalc(["sum", "--json", "１，２３４"])).toEqual({ sum: 1234, count: 1 });
  });

  it("Round8 回归:以 [ 开头的坏 JSON 硬报错,绝不静默回退文本抽数(脏路径)", () => {
    // 之前 `[1,2,{"x":3}` 会被当文本抽出 1,2,3 → sum:6(看似合理实则错误)。
    expect(runCalc(["sum", "--json", "[1, 2"])).toEqual({
      error: "invalid JSON array: malformed JSON input",
      count: 0,
    });
    expect(runCalc(["sum", "--json", "[1,2,{\"x\":3}"])).toEqual({
      error: "invalid JSON array: malformed JSON input",
      count: 0,
    });
    // 不以 [ 开头的内联文本仍走容忍式抽数(--json 文档化的双用途:内联数据)。
    expect(runCalc(["sum", "--json", "A=1.5e3\nB=2.5E2\nC=-1e2"])).toEqual({ sum: 1650, count: 3 });
  });

  it("Round3 回归:子进程错误退出时 stdout 仍完整输出 error JSON", async () => {
    const result = await execCalc(["stats", "--json", JSON.stringify(["缺失", "N/A", ""])]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      error: "no numbers parsed from input",
      count: 0,
    });
  });

  it("Round13 回归:sumcol 引号感知 CSV——quoted 字段含逗号/千分位/多行/转义不再错列丢行", () => {
    // 之前裸 split(\",\") 把 \"Alpha, Inc\",100 拆三列、\"1,200\" 拆两列、多行 quoted 拆记录,给错值。
    expect(runCalc(["sumcol", "1"], 'name,amount\n"Alpha, Inc",100\nBeta,200\n')).toEqual({ sum: 300, count: 2 });
    expect(runCalc(["sumcol", "1"], 'a,amt\nx,"1,200"\ny,"2,300"\n')).toEqual({ sum: 3500, count: 2 });
    expect(runCalc(["sumcol", "1"], 'name,amt\n"multi\nline",100\nz,200\n')).toEqual({ sum: 300, count: 2 });
    expect(runCalc(["sumcol", "1"], 'name,amt\n"say ""hi"", ok",100\nz,200\n')).toEqual({ sum: 300, count: 2 });
    // baseline 不回归:tab 千分位 / 简单逗号
    expect(runCalc(["sumcol", "1"], "a\t1,040\nb\t1,200\n")).toEqual({ sum: 2240, count: 2 });
    expect(runCalc(["sumcol", "1"], "a,100\nb,200\n")).toEqual({ sum: 300, count: 2 });
  });

  it("--file 读工作目录文件做按列求和", () => {
    const dir = mkdtempSync(join(tmpdir(), "calc-"));
    const file = join(dir, "table.csv");
    writeFileSync(file, "苹果,1280\n香蕉,960\n");
    const oldCwd = process.cwd();
    try {
      process.chdir(dir);
      expect(runCalc(["sumcol", "1", "--file", "table.csv"])).toEqual({ sum: 2240, count: 2 });
    } finally {
      process.chdir(oldCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Round2 回归:calc.mjs 自身拒绝 --file 越权路径", () => {
    const cases = [
      ["stats", "--file", "/etc/passwd"],
      ["stats", "--file=/etc/passwd"],
      ["stats", "--", "--file", "/etc/passwd"],
      ["stats", "--file", "/etc/../etc/passwd"],
    ];
    for (const args of cases) {
      expect(runCalc(args), args.join(" ")).toMatchObject({
        error: expect.stringMatching(/outside the current workspace/),
        count: 0,
      });
    }
  });

  it("stdin 兜底仍可用(向后兼容)", () => {
    expect(runCalc(["sum"], "[1,2,3]")).toEqual({ sum: 6, count: 3 });
  });

  it("脏文本抽数支持科学计数法", () => {
    expect(runCalc(["sum", "--json", "A=1.5e3\nB=2.5E2\nC=-1e2"])).toEqual({
      sum: 1650,
      count: 3,
    });
  });

  it("负号和数字之间隔着货币符时仍按负数解析", () => {
    expect(runCalc(["sum", "--json", "退款 -¥1,280\n折让 - $250\n手续费 ¥-30"])).toEqual({
      sum: -1560,
      count: 3,
    });
  });

  it("gate 放行 --json / --file 调用,拒绝管道喂数", () => {
    const dir = mkdtempSync(join(tmpdir(), "calc-policy-"));
    const q = JSON.stringify(calc);
    try {
      expect(evaluateCommandPolicy(`node ${q} sum --json '[1,2,3]'`, { workspaceCwd: dir }).action).toBe("allow");
      expect(evaluateCommandPolicy(`node ${q} sumcol 1 --file data/table.csv`, { workspaceCwd: dir }).action).toBe(
        "allow",
      );
      expect(evaluateCommandPolicy(`node ${q} sumcol 1 --file /etc/passwd`, { workspaceCwd: dir }).action).toBe(
        "deny",
      );
      // 旧的管道喂数会被 gate 拒绝——这是本次给 calc.mjs 加 --json/--file 的根因
      expect(evaluateCommandPolicy(`echo '[1,2,3]' | node ${q} sum`, { workspaceCwd: dir }).action).toBe("deny");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
