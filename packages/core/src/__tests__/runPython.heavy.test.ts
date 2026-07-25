import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getPyodideTools, runPythonTool } from "../tools/runPython.js";
import type { RunPythonInput, RunPythonResult } from "../tools/runPython.js";
import {
  PYODIDE_DANGEROUS_BEFORE_LOAD,
  PYODIDE_DANGEROUS_AFTER_LOAD,
} from "../runtime/pyodideRunner.js";

const toolInvocationOptions = { toolCallId: "run-python-test", messages: [] } as never;

async function run(input: RunPythonInput): Promise<RunPythonResult> {
  process.env.QINGAGENT_PYODIDE_ENABLED = "1";
  if (!runPythonTool.execute) throw new Error("run_python execute missing");
  return await runPythonTool.execute(input, toolInvocationOptions) as RunPythonResult;
}

describe("run_python capability tool", () => {
  afterEach(() => {
    delete process.env.RUN_PYTHON_SECRET_SHOULD_NOT_LEAK;
    delete process.env.QINGAGENT_PYODIDE_ENABLED;
  });

  it("Round8 回归:Buffer/process 绝不在 loadPyodide 之前被中和(否则真实 Node worker 里整个 run_python 崩)", () => {
    // 根因:pyodide 0.29.4 的 Node 加载器在 loadPyodide 期间用 Buffer.from / process,
    // 提前删它们会让 worker 抛 "Cannot read properties of undefined (reading 'from')" /
    // wasm "memory access out of bounds"。vitest 的 worker 里 Buffer 不可配置→中和静默失败
    // →掩盖该 bug(假绿);只有真实 Node worker(打包 app / 纯 node / tsx)才暴露。
    // 故用静态不变量守住:before-load 名单绝不含 Buffer/process。
    expect(PYODIDE_DANGEROUS_BEFORE_LOAD).not.toContain("Buffer");
    expect(PYODIDE_DANGEROUS_BEFORE_LOAD).not.toContain("process");
    // 加载后仍要中和,纵深防御不放松。
    expect(PYODIDE_DANGEROUS_AFTER_LOAD).toContain("Buffer");
    expect(PYODIDE_DANGEROUS_AFTER_LOAD).toContain("process");
  });

  it("Round5 回归:未显式设置运行时开关时模型看不到 run_python", () => {
    delete process.env.QINGAGENT_PYODIDE_ENABLED;
    expect(getPyodideTools()).not.toHaveProperty("run_python");
  });

  it("按运行时开关注入工具:显式启用时模型能看到 run_python", () => {
    process.env.QINGAGENT_PYODIDE_ENABLED = "1";
    expect(getPyodideTools()).toHaveProperty("run_python");
  });

  it("审查母技能声明两种代码执行工具，一致性子技能强制真实验算", async () => {
    const skillPath = fileURLToPath(new URL("../../skills/capability/review/SKILL.md", import.meta.url));
    const referencePath = fileURLToPath(new URL("../../skills/capability/review/consistency/SKILL.md", import.meta.url));
    const [skill, reference] = await Promise.all([
      readFile(skillPath, "utf8"),
      readFile(referencePath, "utf8"),
    ]);
    expect(skill).toContain("run_python, run_js");
    expect(reference).toContain("必须调用代码执行工具（`run_python` 或 `run_js` 均可）真实验算");
  });

  it("按运行时开关注入工具:显式关闭时模型看不到 run_python", () => {
    process.env.QINGAGENT_PYODIDE_ENABLED = "0";
    expect(getPyodideTools()).not.toHaveProperty("run_python");
  });

  it("执行确定性 Python 计算并通过结构化 input_json 传参", async () => {
    const result = await run({
      code: `
print(sum([1, 2, 3]))
sum(input_json["values"])
`,
      input_json: { values: [1280, 960, 430, 1875] },
    });

    expect(result).toMatchObject({
      ok: true,
      result: 4545,
    });
    expect(result.stdout).toContain("6");
    expect(result.load_ms).toBeGreaterThan(0);
  }, 15_000);

  it("Round3 回归:NaN、Infinity 和超安全范围整数返回值不会破坏 JSON 协议或丢精度", async () => {
    const result = await run({
      code: `
{
    "nan": float("nan"),
    "inf": float("inf"),
    "neg_inf": float("-inf"),
    "safe_int": 9007199254740991,
    "too_big": 9007199254740992,
    "huge": 9007199254740993123456789,
    "nested": [float("nan"), float("inf"), float("-inf"), 9007199254740992],
}
`,
    });

    expect(result.ok).toBe(true);
    expect(result.result).toEqual({
      nan: "NaN",
      inf: "Infinity",
      neg_inf: "-Infinity",
      safe_int: 9007199254740991,
      too_big: "9007199254740992",
      huge: "9007199254740993123456789",
      nested: ["NaN", "Infinity", "-Infinity", "9007199254740992"],
    });
    expect(JSON.parse(JSON.stringify(result.result))).toEqual(result.result);
    expect(JSON.stringify(result.result)).not.toContain("null");
  }, 15_000);

  it("import js 和 os.environ 都读不到宿主环境变量", async () => {
    process.env.RUN_PYTHON_SECRET_SHOULD_NOT_LEAK = "secret-value";
    const result = await run({
      code: `
import os

try:
    js_value = __import__("js").process.env.RUN_PYTHON_SECRET_SHOULD_NOT_LEAK
except Exception as exc:
    js_value = type(exc).__name__

{
    "js_process_env": js_value,
    "os_environ": os.environ.get("RUN_PYTHON_SECRET_SHOULD_NOT_LEAK"),
}
`,
    });

    expect(result.ok).toBe(true);
    expect(result.result).toEqual({
      js_process_env: "AttributeError",
      os_environ: null,
    });
    expect(JSON.stringify(result)).not.toContain("secret-value");
  }, 15_000);

  it("没有 fetch 网络能力", async () => {
    const result = await run({
      code: `
import js
js.fetch("https://example.com")
`,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/AttributeError: fetch|fetch/i);
  }, 15_000);

  it("文件读取、pyodide_js 和 require/node builtins 都不可达", async () => {
    const cases = [
      `open("/etc/passwd").read()`,
      `import builtins\nbuiltins.open("/etc/passwd").read()`,
      `import pyodide_js\npyodide_js.FS`,
      `import js\njs.eval("globalThis.process")`,
      `import js\njs.require("node:fs")`,
    ];

    for (const code of cases) {
      const result = await run({ code });
      expect(result.ok, code).toBe(false);
      expect(result.error, code).toMatch(/file access is disabled|pyodide_js is disabled|AttributeError: (eval|require)/i);
    }
  }, 30_000);

  it("删除 sys.modules 后也不能通过 importlib、__import__ 或普通 import 重导入封禁模块", async () => {
    const result = await run({
      code: `
import importlib
import sys

out = {}

sys.modules.pop("pyodide_js", None)
try:
    mod = importlib.import_module("pyodide_js")
    out["importlib_pyodide_js"] = {"imported": True, "has_FS": hasattr(mod, "FS")}
except Exception as exc:
    out["importlib_pyodide_js"] = type(exc).__name__

sys.modules.pop("pyodide_js", None)
try:
    mod = __import__("pyodide_js")
    out["dunder_pyodide_js"] = {"imported": True, "has_FS": hasattr(mod, "FS")}
except Exception as exc:
    out["dunder_pyodide_js"] = type(exc).__name__

sys.modules.pop("micropip", None)
try:
    import micropip
    out["import_micropip"] = "imported"
except Exception as exc:
    out["import_micropip"] = type(exc).__name__

out
`,
    });

    expect(result.ok).toBe(true);
    expect(result.result).toEqual({
      importlib_pyodide_js: "ModuleNotFoundError",
      dunder_pyodide_js: "ModuleNotFoundError",
      import_micropip: "ModuleNotFoundError",
    });
  }, 15_000);

  it("死循环会被 worker terminate 硬超时杀掉", async () => {
    const startedAt = Date.now();
    const result = await run({ code: "while True:\n    pass", timeout_ms: 1_800 });

    expect(result).toMatchObject({ ok: false, error: "timeout" });
    // 墙钟 = pyodide 冷启动(不确定,满负载并发下可达数秒) + timeout_ms + worker 回收。
    // 这里只需证明死循环被"有界"杀掉(非无限),放宽到 10s 容忍满负载/冷启动抖动。
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 15_000);

  it("超大 stdout 会被截断且不拖垮主进程", async () => {
    const result = await run({
      code: `
print("x" * 1000000)
"done"
`,
    });

    expect(result.ok).toBe(true);
    expect(result.result).toBe("done");
    expect(result.stdout.length).toBeLessThanOrEqual(16_384);
    expect(result.stdout_truncated).toBe(true);
  }, 15_000);

  it("超大返回字符串会在 Python 侧截断后再传回 JS", async () => {
    const result = await run({
      code: `"y" * 1000000`,
    });

    expect(result.ok).toBe(true);
    expect(typeof result.result).toBe("string");
    expect((result.result as string).length).toBeLessThan(17_000);
    expect(result.result).toContain("[truncated]");
    expect(result.result_truncated).toBe(true);
  }, 15_000);

  it("持续分配大内存会被主线程 RSS 监控终止", async () => {
    const result = await run({
      code: `
chunks = []
while True:
    chunks.append(bytearray(64 * 1024 * 1024))
len(chunks)
`,
      timeout_ms: 15_000,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/memory/i);
  }, 30_000);
});
