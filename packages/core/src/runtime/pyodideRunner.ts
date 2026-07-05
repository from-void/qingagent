import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker, type WorkerOptions } from "node:worker_threads";

const require = createRequire(import.meta.url);

const REQUIRED_PYODIDE_RESOURCE_FILES = [
  "pyodide.mjs",
  "pyodide.asm.js",
  "pyodide.asm.wasm",
  "python_stdlib.zip",
  "pyodide-lock.json",
] as const;

export interface PyodideRuntimeLocation {
  resourceDir: string;
  moduleUrl: string;
}

export type PyodideRuntimeAvailability =
  | { available: true; location: PyodideRuntimeLocation }
  | { available: false; reason: string };

export interface RunPythonWorkerInput {
  code: string;
  input_json?: unknown;
  timeout_ms?: number;
}

export interface RunPythonResult {
  ok: boolean;
  result?: unknown;
  stdout: string;
  stderr: string;
  error?: string | null;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
  result_truncated?: boolean;
  load_ms?: number;
}

const MAX_CODE_CHARS = 20_000;
const MAX_INPUT_JSON_CHARS = 64_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 15_000;
const MAX_STDOUT_CHARS = 16_384;
const MAX_STDERR_CHARS = 16_384;
const MAX_RESULT_STRING_CHARS = 16_384;
const WORKER_RSS_LIMIT_DELTA_BYTES = 1024 * 1024 * 1024;
const WORKER_RSS_POLL_INTERVAL_MS = 100;

function normalizeFlag(value: string | undefined): "enabled" | "disabled" {
  const normalized = (value ?? "").trim().toLowerCase();
  if (["1", "true", "on", "enabled", "yes"].includes(normalized)) return "enabled";
  return "disabled";
}

function getElectronResourcesPath(): string | null {
  const maybeProcess = process as NodeJS.Process & { resourcesPath?: string };
  return typeof maybeProcess.resourcesPath === "string" && maybeProcess.resourcesPath.length > 0
    ? maybeProcess.resourcesPath
    : null;
}

function hasPyodideResources(resourceDir: string): boolean {
  return REQUIRED_PYODIDE_RESOURCE_FILES.every((file) => existsSync(join(resourceDir, file)));
}

function withTrailingSep(path: string): string {
  return path.endsWith(sep) ? path : `${path}${sep}`;
}

function resolvePyodideModuleUrl(resourceDir: string | null): string | null {
  // 打包态:优先用 Resources/pyodide 里随包的 loader(pyodide 不在 apps/desktop 的 node_modules,
  // 因为它是被 esbuild 打进去的 core 的依赖;require.resolve 在打包产物里会失败)。
  if (resourceDir) {
    const bundled = join(resourceDir, "pyodide.mjs");
    if (existsSync(bundled)) return pathToFileURL(bundled).href;
  }
  // dev/server:从 node_modules 解析。
  try {
    const modulePath = require.resolve("pyodide/pyodide.mjs");
    return pathToFileURL(modulePath).href;
  } catch {
    return null;
  }
}

function resolvePyodideResourceDir(): string | null {
  const explicit = process.env.QINGAGENT_PYODIDE_INDEX_URL;
  if (explicit && explicit.trim()) return resolve(explicit.trim());

  const resourcesPath = getElectronResourcesPath();
  if (resourcesPath) return join(resourcesPath, "pyodide");

  try {
    return dirname(require.resolve("pyodide/package.json"));
  } catch {
    return null;
  }
}

export function getPyodideRuntimeAvailability(): PyodideRuntimeAvailability {
  const flag = normalizeFlag(process.env.QINGAGENT_PYODIDE_ENABLED);
  if (flag === "disabled") {
    return { available: false, reason: "QINGAGENT_PYODIDE_ENABLED=0" };
  }

  const resourceDir = resolvePyodideResourceDir();
  if (!resourceDir) {
    return { available: false, reason: "pyodide resource directory not found" };
  }
  if (!hasPyodideResources(resourceDir)) {
    return { available: false, reason: `pyodide resources missing at ${resourceDir}` };
  }

  const moduleUrl = resolvePyodideModuleUrl(resourceDir);
  if (!moduleUrl) {
    return { available: false, reason: "pyodide loader module not found" };
  }

  return {
    available: true,
    location: {
      moduleUrl,
      resourceDir: withTrailingSep(resourceDir),
    },
  };
}

export function isPyodideRuntimeAvailable(): boolean {
  return getPyodideRuntimeAvailability().available;
}

function validateRunPythonInput(input: RunPythonWorkerInput): { ok: true; inputText: string } | { ok: false; result: RunPythonResult } {
  if (typeof input.code !== "string" || input.code.length < 1) {
    return { ok: false, result: { ok: false, stdout: "", stderr: "", error: "code 必须是非空字符串" } };
  }
  if (input.code.length > MAX_CODE_CHARS) {
    return {
      ok: false,
      result: { ok: false, stdout: "", stderr: "", error: `code 过大,最多 ${MAX_CODE_CHARS} 字符` },
    };
  }
  const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    return {
      ok: false,
      result: {
        ok: false,
        stdout: "",
        stderr: "",
        error: `timeout_ms 必须是 1 到 ${MAX_TIMEOUT_MS} 之间的整数`,
      },
    };
  }
  try {
    const inputText = JSON.stringify(input.input_json ?? null);
    if (inputText.length > MAX_INPUT_JSON_CHARS) {
      return {
        ok: false,
        result: { ok: false, stdout: "", stderr: "", error: `input_json 过大,最多 ${MAX_INPUT_JSON_CHARS} 字符` },
      };
    }
    return { ok: true, inputText };
  } catch (error) {
    return {
      ok: false,
      result: {
        ok: false,
        stdout: "",
        stderr: "",
        error: `input_json 不能序列化为 JSON:${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

const PYTHON_RUNNER_SOURCE = String.raw`
import ast
import builtins
import importlib
import json
import sys
import traceback
import types
from _pyodide._base import eval_code_async

_QINGAGENT_BLOCKED_MODULE_NAMES = frozenset(("micropip", "pyodide_js"))
_QINGAGENT_ORIGINAL_IMPORT = builtins.__import__
_QINGAGENT_ORIGINAL_IMPORT_MODULE = importlib.import_module
_QINGAGENT_MAX_SAFE_INTEGER = 9007199254740991

class _QingagentBlockedModule(types.ModuleType):
    def __getattr__(self, name):
        raise RuntimeError(f"{self.__name__} is disabled in run_python")

class _QingagentBlockedImportFinder:
    _qingagent_blocked_import_finder = True

    def find_spec(self, fullname, path=None, target=None):
        if _qingagent_is_blocked_module_name(fullname):
            raise ModuleNotFoundError(f"{fullname} is disabled in run_python")
        return None

class _QingagentCappedWriter:
    def __init__(self, limit):
        self.limit = int(limit)
        self.parts = []
        self.size = 0
        self.truncated = False

    def write(self, value):
        text = str(value)
        remaining = self.limit - self.size
        if remaining > 0:
            chunk = text[:remaining]
            self.parts.append(chunk)
            self.size += len(chunk)
        if len(text) > max(remaining, 0):
            self.truncated = True
        return len(text)

    def flush(self):
        return None

    def getvalue(self):
        return "".join(self.parts)

def _qingagent_cap_string(value, limit):
    text = str(value)
    if len(text) <= limit:
        return text, False
    return text[:limit] + "...[truncated]", True

def _qingagent_sanitize(value, limit, depth=0, seen=None):
    if seen is None:
        seen = set()
    if value is None or isinstance(value, bool):
        return value, False
    if isinstance(value, int):
        if abs(value) > _QINGAGENT_MAX_SAFE_INTEGER:
            return str(value), False
        return value, False
    if isinstance(value, float):
        if value != value:
            return "NaN", False
        if value == float("inf"):
            return "Infinity", False
        if value == float("-inf"):
            return "-Infinity", False
        return value, False
    if isinstance(value, str):
        return _qingagent_cap_string(value, limit)
    if isinstance(value, (bytes, bytearray, memoryview)):
        capped, truncated = _qingagent_cap_string(bytes(value).hex(), limit)
        return {"type": "bytes", "hex": capped}, truncated
    object_id = id(value)
    if object_id in seen:
        return "[Circular]", True
    if depth >= 8:
        return "[MaxDepth]", True
    seen.add(object_id)
    if isinstance(value, (list, tuple, set, frozenset)):
        out = []
        truncated = False
        for index, item in enumerate(value):
            if index >= 100:
                out.append("[Array truncated]")
                truncated = True
                break
            sanitized, item_truncated = _qingagent_sanitize(item, limit, depth + 1, seen)
            out.append(sanitized)
            truncated = truncated or item_truncated
        seen.discard(object_id)
        return out, truncated
    if isinstance(value, dict):
        out = {}
        truncated = False
        for index, (key, item) in enumerate(value.items()):
            if index >= 100:
                out["__truncated__"] = True
                truncated = True
                break
            key_text, key_truncated = _qingagent_cap_string(key, 200)
            sanitized, item_truncated = _qingagent_sanitize(item, limit, depth + 1, seen)
            out[key_text] = sanitized
            truncated = truncated or key_truncated or item_truncated
        seen.discard(object_id)
        return out, truncated
    capped, truncated = _qingagent_cap_string(repr(value), limit)
    seen.discard(object_id)
    return capped, truncated

def _qingagent_file_disabled(*args, **kwargs):
    raise PermissionError("file access is disabled in run_python")

def _qingagent_is_blocked_module_name(name):
    root = str(name).split(".", 1)[0]
    return root in _QINGAGENT_BLOCKED_MODULE_NAMES

def _qingagent_import_blocked_error(name):
    return ModuleNotFoundError(f"{name} is disabled in run_python")

def _qingagent_guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    if level == 0 and _qingagent_is_blocked_module_name(name):
        raise _qingagent_import_blocked_error(name)
    return _QINGAGENT_ORIGINAL_IMPORT(name, globals, locals, fromlist, level)

def _qingagent_guarded_import_module(name, package=None):
    if _qingagent_is_blocked_module_name(name):
        raise _qingagent_import_blocked_error(name)
    return _QINGAGENT_ORIGINAL_IMPORT_MODULE(name, package)

def _qingagent_install_blocked_modules():
    for name in _QINGAGENT_BLOCKED_MODULE_NAMES:
        sys.modules[name] = _QingagentBlockedModule(name)
    if not any(getattr(finder, "_qingagent_blocked_import_finder", False) for finder in sys.meta_path):
        sys.meta_path.insert(0, _QingagentBlockedImportFinder())
    builtins.__import__ = _qingagent_guarded_import
    importlib.import_module = _qingagent_guarded_import_module

async def __qingagent_run_user(code, input_json_text, stdout_limit, stderr_limit, result_string_limit):
    stdout = _QingagentCappedWriter(stdout_limit)
    stderr = _QingagentCappedWriter(stderr_limit)
    old_stdout = sys.stdout
    old_stderr = sys.stderr
    old_open = builtins.open
    old_import = builtins.__import__
    old_import_module = importlib.import_module
    _qingagent_install_blocked_modules()
    try:
        input_value = json.loads(input_json_text)
    except Exception as exc:
        return json.dumps({
            "ok": False,
            "stdout": "",
            "stderr": "",
            "error": f"input_json JSON parse failed: {exc}",
            "stdout_truncated": False,
            "stderr_truncated": False,
            "result_truncated": False,
        }, ensure_ascii=False)

    user_globals = {
        "__name__": "__main__",
        "input": input_value,
        "input_json": input_value,
    }

    try:
        sys.stdout = stdout
        sys.stderr = stderr
        builtins.open = _qingagent_file_disabled
        result = await eval_code_async(
            code,
            globals=user_globals,
            locals=user_globals,
            return_mode="last_expr",
            filename="run_python_user_code.py",
        )
        sanitized, result_truncated = _qingagent_sanitize(result, int(result_string_limit))
        return json.dumps({
            "ok": True,
            "result": sanitized,
            "stdout": stdout.getvalue(),
            "stderr": stderr.getvalue(),
            "error": None,
            "stdout_truncated": stdout.truncated,
            "stderr_truncated": stderr.truncated,
            "result_truncated": result_truncated,
        }, ensure_ascii=False)
    except BaseException:
        err, err_truncated = _qingagent_cap_string(traceback.format_exc(), int(result_string_limit))
        return json.dumps({
            "ok": False,
            "stdout": stdout.getvalue(),
            "stderr": stderr.getvalue(),
            "error": err,
            "stdout_truncated": stdout.truncated,
            "stderr_truncated": stderr.truncated,
            "result_truncated": err_truncated,
        }, ensure_ascii=False)
    finally:
        sys.stdout = old_stdout
        sys.stderr = old_stderr
        builtins.open = old_open
        builtins.__import__ = old_import
        importlib.import_module = old_import_module
`;

// Pyodide 0.29.4's Node loader needs process AND Buffer during loadPyodide:
// deleting process before load triggers a wasm "memory access out of bounds"
// crash, and deleting Buffer before load makes the loader's Buffer.from(...) throw
// "Cannot read properties of undefined (reading 'from')" — both abort the whole
// run_python feature in a real Node worker (the bundled app / plain node; vitest
// masks it because its worker's Buffer is non-configurable so the nuke no-ops).
// Both are safe to neutralize *after* load: user Python never receives globalThis
// (jsglobals points at a frozen empty object), and they're cut before user code.
// These live as module consts (not inline in the worker source string) so the
// invariant "Buffer/process are never neutralized before load" is unit-testable —
// the runtime worker path is masked by vitest, a static assertion is not.
export const PYODIDE_DANGEROUS_BEFORE_LOAD = ["fetch", "require", "module"];
export const PYODIDE_DANGEROUS_AFTER_LOAD = ["process", "fetch", "require", "module", "Buffer"];

const RUN_PYTHON_WORKER_SOURCE = String.raw`
import { parentPort, workerData } from "node:worker_threads";

const DANGEROUS_BEFORE_LOAD = workerData.dangerousBeforeLoad;
const DANGEROUS_AFTER_LOAD = workerData.dangerousAfterLoad;

function neutralizeGlobal(name) {
  try {
    delete globalThis[name];
  } catch {
    // Ignore non-configurable globals.
  }
  try {
    globalThis[name] = undefined;
  } catch {
    // Ignore read-only globals.
  }
}

function safeJsGlobals() {
  return Object.freeze(Object.create(null));
}

function toMessage(raw, loadMs) {
  const parsed = JSON.parse(String(raw));
  return {
    ok: Boolean(parsed.ok),
    result: parsed.result,
    stdout: typeof parsed.stdout === "string" ? parsed.stdout : "",
    stderr: typeof parsed.stderr === "string" ? parsed.stderr : "",
    error: parsed.error ?? null,
    stdout_truncated: Boolean(parsed.stdout_truncated),
    stderr_truncated: Boolean(parsed.stderr_truncated),
    result_truncated: Boolean(parsed.result_truncated),
    load_ms: loadMs,
  };
}

(async () => {
  try {
    const { loadPyodide } = await import(workerData.pyodideModuleUrl);
    for (const name of DANGEROUS_BEFORE_LOAD) neutralizeGlobal(name);

    const startupStdout = [];
    const startupStderr = [];
    const startedAt = Date.now();
    const pyodide = await loadPyodide({
      indexURL: workerData.indexURL,
      jsglobals: safeJsGlobals(),
      env: {},
      packages: [],
      stdin: () => null,
      stdout: (line) => startupStdout.push(String(line)),
      stderr: (line) => startupStderr.push(String(line)),
    });
    const loadMs = Date.now() - startedAt;

    for (const name of DANGEROUS_AFTER_LOAD) neutralizeGlobal(name);
    pyodide.runPython(workerData.pythonRunnerSource);
    const runner = pyodide.globals.get("__qingagent_run_user");
    try {
      const raw = await runner(
        workerData.code,
        workerData.inputText,
        workerData.stdoutLimit,
        workerData.stderrLimit,
        workerData.resultStringLimit
      );
      const message = toMessage(raw, loadMs);
      if (startupStdout.length > 0) {
        message.stdout = startupStdout.join("\n") + "\n" + message.stdout;
      }
      if (startupStderr.length > 0) {
        message.stderr = startupStderr.join("\n") + "\n" + message.stderr;
      }
      parentPort.postMessage(message);
    } finally {
      if (runner && typeof runner.destroy === "function") runner.destroy();
    }
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      stdout: "",
      stderr: "",
      error: error instanceof Error ? error.message : String(error),
      stdout_truncated: false,
      stderr_truncated: false,
      result_truncated: false,
    });
  }
})();
`;

type WorkerMessage = RunPythonResult;

export function runPythonInWorker(input: RunPythonWorkerInput, abortSignal?: AbortSignal): Promise<RunPythonResult> {
  const validated = validateRunPythonInput(input);
  if (!validated.ok) return Promise.resolve(validated.result);

  const availability = getPyodideRuntimeAvailability();
  if (!availability.available) {
    return Promise.resolve({
      ok: false,
      stdout: "",
      stderr: "",
      error: `pyodide runtime unavailable: ${availability.reason}`,
    });
  }

  if (abortSignal?.aborted) {
    return Promise.resolve({ ok: false, stdout: "", stderr: "", error: "aborted" });
  }

  const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  return new Promise<RunPythonResult>((resolveResult) => {
    let settled = false;
    const startedRss = process.memoryUsage().rss;
    const workerOptions: WorkerOptions & { type: "module" } = {
      eval: true,
      type: "module",
      workerData: {
        pyodideModuleUrl: availability.location.moduleUrl,
        indexURL: availability.location.resourceDir,
        pythonRunnerSource: PYTHON_RUNNER_SOURCE,
        dangerousBeforeLoad: PYODIDE_DANGEROUS_BEFORE_LOAD,
        dangerousAfterLoad: PYODIDE_DANGEROUS_AFTER_LOAD,
        code: input.code,
        inputText: validated.inputText,
        stdoutLimit: MAX_STDOUT_CHARS,
        stderrLimit: MAX_STDERR_CHARS,
        resultStringLimit: MAX_RESULT_STRING_CHARS,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: 128,
        maxYoungGenerationSizeMb: 16,
        codeRangeSizeMb: 16,
        stackSizeMb: 4,
      },
    };
    const worker = new Worker(RUN_PYTHON_WORKER_SOURCE, workerOptions);

    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(memoryTimer);
      abortSignal?.removeEventListener("abort", onAbort);
    };
    const finish = (result: RunPythonResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate().catch(() => {});
      resolveResult(result);
    };
    const terminateWith = (result: RunPythonResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate().catch(() => {});
      resolveResult(result);
    };
    const onAbort = () => terminateWith({ ok: false, stdout: "", stderr: "", error: "aborted" });
    const timer = setTimeout(() => {
      terminateWith({ ok: false, stdout: "", stderr: "", error: "timeout" });
    }, timeoutMs);
    // Pyodide 的 WASM 堆不受 V8 worker resourceLimits 约束;主线程轮询 RSS 兜住内存炸弹。
    const memoryTimer = setInterval(() => {
      if (process.memoryUsage().rss > startedRss + WORKER_RSS_LIMIT_DELTA_BYTES) {
        terminateWith({ ok: false, stdout: "", stderr: "", error: "memory limit exceeded" });
      }
    }, WORKER_RSS_POLL_INTERVAL_MS);

    abortSignal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message: WorkerMessage) => {
      finish({
        ok: Boolean(message.ok),
        result: message.result,
        stdout: typeof message.stdout === "string" ? message.stdout : "",
        stderr: typeof message.stderr === "string" ? message.stderr : "",
        error: message.error ?? null,
        stdout_truncated: Boolean(message.stdout_truncated),
        stderr_truncated: Boolean(message.stderr_truncated),
        result_truncated: Boolean(message.result_truncated),
        load_ms: typeof message.load_ms === "number" ? message.load_ms : undefined,
      });
    });
    worker.once("error", (error) => {
      finish({ ok: false, stdout: "", stderr: "", error: error.message });
    });
    worker.once("exit", (code) => {
      if (!settled && code !== 0) {
        finish({ ok: false, stdout: "", stderr: "", error: `worker exited with code ${code}` });
      }
    });
  });
}
