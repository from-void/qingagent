import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runJsInWorker,
  type RunJsResult,
} from "../../../../packages/core/src/tools/runJs.js";
import {
  runPythonTool,
  type RunPythonResult,
} from "../../../../packages/core/src/tools/runPython.js";
import {
  compileSafeRegex,
  execSafeRegexAll,
} from "../../../../packages/core/src/agent-run/safeRegex.js";

const DOS_CHILD_ARG = "--run-js-dos-child";
const toolInvocationOptions = { toolCallId: "packaged-worker-smoke", messages: [] } as never;

function fail(message: string, details?: unknown): never {
  const suffix = details === undefined ? "" : `: ${JSON.stringify(details)}`;
  throw new Error(`${message}${suffix}`);
}

async function runPython(code: string): Promise<RunPythonResult> {
  if (!runPythonTool.execute) fail("run_python execute missing");
  return await runPythonTool.execute(
    { code, timeout_ms: 15_000 },
    toolInvocationOptions,
  ) as RunPythonResult;
}

async function runDosChild(): Promise<void> {
  const allocation = await runJsInWorker({
    code: "new Array(5e7).fill(0); return 1;",
    timeout_ms: 5_000,
  });
  const followUp = await runJsInWorker({ code: "return 6 * 7;" });
  process.stdout.write(JSON.stringify({ allocation, followUp, hostSurvived: true }));
}

function assertRunJs(result: RunJsResult): void {
  if (!result.ok || result.result !== 2) {
    fail("打包版 run_js 冒烟失败", result);
  }
}

function assertRunPython(result: RunPythonResult): void {
  if (!result.ok || result.result !== 2) {
    fail("打包版 run_python 冒烟失败", result);
  }
}

async function assertSafeRegex(): Promise<void> {
  const compiled = compileSafeRegex("a\\d");
  if (!compiled.ok) fail("打包版 safeRegex 编译失败", compiled);
  const result = await execSafeRegexAll(compiled.re, "a1 b2 a3");
  if (!result.ok || result.matches.length !== 2) {
    fail("打包版 safeRegex worker 冒烟失败", result);
  }
}

function assertDosHostSurvival(): void {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), DOS_CHILD_ARG], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
    },
    encoding: "utf8",
    timeout: 15_000,
  });
  if (child.error) fail("run_js DoS 子进程启动失败", child.error.message);
  if (child.status !== 0) {
    fail("run_js 单次大分配杀死了宿主进程", {
      status: child.status,
      signal: child.signal,
      stderr: child.stderr.slice(-2_000),
    });
  }
  let result: {
    allocation?: RunJsResult;
    followUp?: RunJsResult;
    hostSurvived?: boolean;
  };
  try {
    result = JSON.parse(child.stdout) as typeof result;
  } catch {
    fail("run_js DoS 子进程未返回 JSON", child.stdout);
  }
  if (
    result.hostSurvived !== true ||
    result.allocation?.ok !== false ||
    result.allocation.failureKind !== "resourceExceeded" ||
    result.followUp?.ok !== true ||
    result.followUp.result !== 42
  ) {
    fail("run_js DoS 归因或宿主存活断言失败", result);
  }
}

async function runPackagedWorkerSmoke(): Promise<void> {
  const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  process.env.QINGAGENT_PYODIDE_ENABLED = "1";
  process.env.QINGAGENT_PYODIDE_INDEX_URL = resolve(desktopDir, "build/pyodide");

  const runJs = await runJsInWorker({ code: "return 1 + 1;" });
  assertRunJs(runJs);

  const pythonResult = await runPython("1 + 1");
  assertRunPython(pythonResult);

  await assertSafeRegex();
  assertDosHostSurvival();

  process.stdout.write("packaged worker smoke passed\n");
}

try {
  if (process.argv.includes(DOS_CHILD_ARG)) {
    await runDosChild();
  } else {
    await runPackagedWorkerSmoke();
  }
  process.exit(0);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
}
