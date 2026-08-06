import { createTool } from "@mastra/core/tools";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import {
  failureKindFromWorkerError,
  isRunScriptFailureKind,
  RUN_SCRIPT_FAILURE_KINDS,
} from "../runtime/scriptFailure.js";

const MAX_CODE_CHARS = 20_000;
const MAX_INPUT_JSON_CHARS = 64_000;
const DEFAULT_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 5_000;
const MAX_STDOUT_CHARS = 16_384;
const MAX_RESULT_STRING_CHARS = 16_384;

const runJsInputSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(MAX_CODE_CHARS)
    .describe("要执行的 JS 函数体代码。可读取 input/input_json，可用 return 返回结果，可用 console.log/print 输出。"),
  input_json: z.unknown().optional().describe("传给代码的结构化 JSON 输入，在代码里通过 input 或 input_json 读取。"),
  timeout_ms: z
    .number()
    .int()
    .min(1)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(`硬超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}，最大 ${MAX_TIMEOUT_MS}。`),
});

const runJsOutputSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  stdout: z.string(),
  error: z.string().nullable().optional(),
  stdout_truncated: z.boolean().optional(),
  failureKind: z.enum(RUN_SCRIPT_FAILURE_KINDS).optional(),
});

export type RunJsInput = z.infer<typeof runJsInputSchema>;
export type RunJsResult = z.infer<typeof runJsOutputSchema>;

type WorkerMessage = RunJsResult;

function runJsWorkerMain() {
  const { parentPort, workerData } = require("node:worker_threads");
  const vm = require("node:vm");

  function buildPreludeScript() {
    const inputText = String(workerData.inputText);
    const stdoutLimit = Number(workerData.stdoutLimit);
    const resultStringLimit = Number(workerData.resultStringLimit);
    return [
      '"use strict";',
      "(() => {",
      "const safeString = String;",
      "const safeJsonStringify = JSON.stringify;",
      "const safeJsonParse = JSON.parse;",
      "const safeArrayIsArray = Array.isArray;",
      "const safeObjectKeys = Object.keys;",
      "const safeNumberIsFinite = Number.isFinite;",
      "const SafeWeakSet = WeakSet;",
      "const SafeWeakMap = WeakMap;",
      `const __inputText = ${JSON.stringify(inputText)};`,
      `const __stdoutLimit = ${JSON.stringify(stdoutLimit)};`,
      `const __resultStringLimit = ${JSON.stringify(resultStringLimit)};`,
      'let __stdout = "";',
      "let __stdoutTruncated = false;",
      "function __capString(value, limit) {",
      "  const text = safeString(value);",
      "  if (text.length <= limit) return text;",
      '  return text.slice(0, limit) + "...[truncated]";',
      "}",
      "function __sanitize(value, depth = 0, seen = new SafeWeakSet()) {",
      "  if (value === null || typeof value === \"boolean\") return value;",
      "  if (typeof value === \"number\") return safeNumberIsFinite(value) ? value : safeString(value);",
      "  if (typeof value === \"string\") return __capString(value, __resultStringLimit);",
      "  if (typeof value === \"bigint\") return __capString(value.toString(), __resultStringLimit);",
      "  if (value === undefined) return null;",
      "  if (typeof value === \"symbol\" || typeof value === \"function\") return safeString(value);",
      "  if (typeof value !== \"object\") return safeString(value);",
      "  if (seen.has(value)) return \"[Circular]\";",
      "  if (depth >= 8) return \"[MaxDepth]\";",
      "  seen.add(value);",
      "  if (safeArrayIsArray(value)) {",
      "    const out = value.slice(0, 100).map((item) => __sanitize(item, depth + 1, seen));",
      "    if (value.length > 100) out.push(\"[Array truncated]\");",
      "    return out;",
      "  }",
      "  const out = {};",
      "  let count = 0;",
      "  for (const key of safeObjectKeys(value)) {",
      "    if (count >= 100) {",
      "      out.__truncated__ = true;",
      "      break;",
      "    }",
      "    out[__capString(key, 200)] = __sanitize(value[key], depth + 1, seen);",
      "    count += 1;",
      "  }",
      "  return out;",
      "}",
      "function __format(value) {",
      "  if (typeof value === \"string\") return value;",
      "  try {",
      "    return safeJsonStringify(__sanitize(value));",
      "  } catch {",
      "    return safeString(value);",
      "  }",
      "}",
      "function __appendStdout(text) {",
      "  if (__stdout.length >= __stdoutLimit) {",
      "    __stdoutTruncated = true;",
      "    return;",
      "  }",
      "  const remaining = __stdoutLimit - __stdout.length;",
      "  if (text.length > remaining) {",
      "    __stdout += text.slice(0, remaining);",
      "    __stdoutTruncated = true;",
      "    return;",
      "  }",
      "  __stdout += text;",
      "}",
      "function print(...values) {",
      "  __appendStdout(values.map(__format).join(\" \") + \"\\n\");",
      "}",
      "const console = Object.freeze({",
      "  log: print,",
      "  info: print,",
      "  warn: print,",
      "  error: print,",
      "});",
      "const input_json = safeJsonParse(__inputText);",
      // structuredClone 是宿主定义的全局,不是 V8 per-context 内建,fresh vm context 里缺失
      // (R12 sonnet-1)。**绝不能注入 worker 真身**:把 vm 对象传给 worker 的 structuredClone 会返回
      // worker realm 对象,其原型链可达 worker 的 Function → 逃逸。这里用纯 vm 内 polyfill(只用本
      // context 内建,返回本 context 对象),支持循环引用/Date/RegExp/Map/Set/TypedArray/ArrayBuffer。
      "function __structuredClone(value, seen) {",
      "  seen = seen || new SafeWeakMap();",
      "  if (value === null || typeof value !== \"object\") {",
      "    if (typeof value === \"function\" || typeof value === \"symbol\") {",
      "      throw new TypeError(\"structuredClone: cannot clone a \" + typeof value);",
      "    }",
      "    return value;",
      "  }",
      "  if (seen.has(value)) return seen.get(value);",
      // 内建对象也登记进 seen,保留"同一引用出现多次→克隆后仍共享同一身份"的标准语义(R15-2)。
      "  if (value instanceof Date) { const c = new Date(value.getTime()); seen.set(value, c); return c; }",
      "  if (value instanceof RegExp) { const c = new RegExp(value.source, value.flags); seen.set(value, c); return c; }",
      "  if (value instanceof ArrayBuffer) { const c = value.slice(0); seen.set(value, c); return c; }",
      "  if (ArrayBuffer.isView(value)) {",
      "    let c;",
      "    if (value instanceof DataView) c = new DataView(value.buffer.slice(0), value.byteOffset, value.byteLength);",
      "    else c = new value.constructor(value);",
      "    seen.set(value, c);",
      "    return c;",
      "  }",
      "  if (value instanceof Map) {",
      "    const m = new Map(); seen.set(value, m);",
      "    for (const entry of value) m.set(__structuredClone(entry[0], seen), __structuredClone(entry[1], seen));",
      "    return m;",
      "  }",
      "  if (value instanceof Set) {",
      "    const s = new Set(); seen.set(value, s);",
      "    for (const v of value) s.add(__structuredClone(v, seen));",
      "    return s;",
      "  }",
      "  if (safeArrayIsArray(value)) {",
      "    const arr = new Array(value.length); seen.set(value, arr);",
      "    for (let i = 0; i < value.length; i += 1) arr[i] = __structuredClone(value[i], seen);",
      "    return arr;",
      "  }",
      "  const out = {}; seen.set(value, out);",
      "  for (const key of safeObjectKeys(value)) out[key] = __structuredClone(value[key], seen);",
      "  return out;",
      "}",
      // queueMicrotask / TextEncoder / TextDecoder:常用无 I/O 标准 API,fresh vm context 缺失
      // (R13-3)。同 structuredClone:绝不注入 host 真身(host 对象进 vm 留跨 realm 面),
      // 用纯 vm 内 polyfill——UTF-8 编解码自实现(含 4 字节/代理对),只用本 context 内建。
      String.raw`
function __queueMicrotask(cb) {
  if (typeof cb !== "function") throw new TypeError("queueMicrotask requires a function");
  Promise.resolve().then(() => { cb(); });
}
function __utf8Encode(str) {
  const s = String(str);
  const bytes = [];
  for (let i = 0; i < s.length; i += 1) {
    let cp = s.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const lo = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (lo >= 0xdc00 && lo <= 0xdfff) { cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00); i += 1; }
      else cp = 0xfffd; // 孤高代理 → U+FFFD(WHATWG,R15-3)
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      cp = 0xfffd; // 孤低代理 → U+FFFD
    }
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return new Uint8Array(bytes);
}
function __utf8Decode(input) {
  let bytes;
  if (input == null) bytes = new Uint8Array();
  else if (input instanceof Uint8Array) bytes = input;
  else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  else bytes = new Uint8Array(input);
  // WHATWG UTF-8 解码:非法序列(overlong/孤代理范围/截断/非法首字节)一律 U+FFFD,不解成错字符(R15-3)。
  const cont = (x) => x >= 0x80 && x <= 0xbf;
  const emit = (cp) => {
    if (cp > 0xffff) { cp -= 0x10000; return String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff)); }
    return String.fromCharCode(cp);
  };
  let out = "";
  for (let i = 0; i < bytes.length;) {
    const b1 = bytes[i];
    if (b1 < 0x80) { out += String.fromCharCode(b1); i += 1; continue; }
    if (b1 >= 0xc2 && b1 <= 0xdf) {
      if (i + 1 < bytes.length && cont(bytes[i + 1])) { out += emit(((b1 & 0x1f) << 6) | (bytes[i + 1] & 0x3f)); i += 2; }
      else { out += "�"; i += 1; }
      continue;
    }
    if (b1 >= 0xe0 && b1 <= 0xef) {
      const b2 = i + 1 < bytes.length ? bytes[i + 1] : -1;
      const lo = b1 === 0xe0 ? 0xa0 : 0x80;
      const hi = b1 === 0xed ? 0x9f : 0xbf;
      if (b2 >= lo && b2 <= hi) {
        if (i + 2 < bytes.length && cont(bytes[i + 2])) { out += emit(((b1 & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (bytes[i + 2] & 0x3f)); i += 3; }
        else { out += "�"; i += 2; }
      } else { out += "�"; i += 1; }
      continue;
    }
    if (b1 >= 0xf0 && b1 <= 0xf4) {
      const b2 = i + 1 < bytes.length ? bytes[i + 1] : -1;
      const lo = b1 === 0xf0 ? 0x90 : 0x80;
      const hi = b1 === 0xf4 ? 0x8f : 0xbf;
      if (b2 >= lo && b2 <= hi) {
        if (i + 2 < bytes.length && cont(bytes[i + 2])) {
          if (i + 3 < bytes.length && cont(bytes[i + 3])) { out += emit(((b1 & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f)); i += 4; }
          else { out += "�"; i += 3; }
        } else { out += "�"; i += 2; }
      } else { out += "�"; i += 1; }
      continue;
    }
    out += "�"; i += 1; // 非法首字节(0x80-0xc1 / 0xf5-0xff)
  }
  return out;
}
class __TextEncoder { encode(s) { return __utf8Encode(s === undefined ? "" : s); } get encoding() { return "utf-8"; } }
class __TextDecoder { constructor(label) { this.encoding = label ? String(label) : "utf-8"; } decode(b) { return __utf8Decode(b); } }
`,
  // URLSearchParams:常见 query 解析/清洗 API(R13-3 / R14-1)。纯 vm 内实现,复用
      // 本 context 的 decodeURIComponent/encodeURIComponent 内建(不注入 host 真身)。
      String.raw`
function __usDecode(value) {
  const s = String(value).replace(/\+/g, " ");
  try { return decodeURIComponent(s); } catch { return s; }
}
function __usEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/%20/g, "+")
    .replace(/[!'()~*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}
class __URLSearchParams {
  constructor(init) {
    this.__list = [];
    if (init == null || init === "") return;
    if (init instanceof __URLSearchParams) { this.__list = init.__list.map((p) => [p[0], p[1]]); return; }
    if (typeof init === "string") {
      const q = init[0] === "?" ? init.slice(1) : init;
      for (const part of q.split("&")) {
        if (part === "") continue;
        const eq = part.indexOf("=");
        const k = eq < 0 ? part : part.slice(0, eq);
        const v = eq < 0 ? "" : part.slice(eq + 1);
        this.__list.push([__usDecode(k), __usDecode(v)]);
      }
    } else if (typeof init[Symbol.iterator] === "function") {
      for (const pair of init) this.__list.push([String(pair[0]), String(pair[1])]);
    } else {
      for (const k of Object.keys(init)) this.__list.push([String(k), String(init[k])]);
    }
  }
  append(k, v) { this.__list.push([String(k), String(v)]); }
  delete(k) { const key = String(k); this.__list = this.__list.filter((p) => p[0] !== key); }
  get(k) { const key = String(k); const f = this.__list.find((p) => p[0] === key); return f ? f[1] : null; }
  getAll(k) { const key = String(k); return this.__list.filter((p) => p[0] === key).map((p) => p[1]); }
  has(k) { const key = String(k); return this.__list.some((p) => p[0] === key); }
  set(k, v) {
    const key = String(k); const val = String(v); const out = []; let done = false;
    for (const p of this.__list) {
      if (p[0] === key) { if (!done) { out.push([key, val]); done = true; } } else out.push(p);
    }
    if (!done) out.push([key, val]);
    this.__list = out;
  }
  sort() { this.__list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); }
  forEach(cb, thisArg) { for (const p of this.__list.slice()) cb.call(thisArg, p[1], p[0], this); }
  keys() { return this.__list.map((p) => p[0])[Symbol.iterator](); }
  values() { return this.__list.map((p) => p[1])[Symbol.iterator](); }
  entries() { return this.__list.map((p) => [p[0], p[1]])[Symbol.iterator](); }
  [Symbol.iterator]() { return this.entries(); }
  toString() { return this.__list.map((p) => __usEncode(p[0]) + "=" + __usEncode(p[1])).join("&"); }
  get size() { return this.__list.length; }
}
`,
      // eval/Function 已被 vm 的 codeGeneration.strings:false 在 V8 层封死(无法编译字符串),
      // 但引用仍在 globalThis 上;显式置 undefined 做纵深防御,即便未来出现 V8 bypass,
      // 这两个动态代码生成入口也直接不可达(Round8 sonnet-2 EXTRA-1)。
      "Object.defineProperties(globalThis, {",
      "  eval: { value: undefined, writable: false, configurable: false },",
      "  Function: { value: undefined, writable: false, configurable: false },",
      "  process: { value: undefined, writable: false, configurable: false },",
      "  require: { value: undefined, writable: false, configurable: false },",
      "  module: { value: undefined, writable: false, configurable: false },",
      "  exports: { value: undefined, writable: false, configurable: false },",
      "  Buffer: { value: undefined, writable: false, configurable: false },",
      "  fetch: { value: undefined, writable: false, configurable: false },",
      "  setTimeout: { value: undefined, writable: false, configurable: false },",
      "  setInterval: { value: undefined, writable: false, configurable: false },",
      "  setImmediate: { value: undefined, writable: false, configurable: false },",
      "  clearTimeout: { value: undefined, writable: false, configurable: false },",
      "  clearInterval: { value: undefined, writable: false, configurable: false },",
      "  clearImmediate: { value: undefined, writable: false, configurable: false },",
      "  input_json: { value: input_json, writable: false, configurable: false },",
      "  input: { value: input_json, writable: false, configurable: false },",
      "  structuredClone: { value: (v) => __structuredClone(v), writable: false, configurable: false },",
      "  queueMicrotask: { value: __queueMicrotask, writable: false, configurable: false },",
      "  TextEncoder: { value: __TextEncoder, writable: false, configurable: false },",
      "  TextDecoder: { value: __TextDecoder, writable: false, configurable: false },",
      "  URLSearchParams: { value: __URLSearchParams, writable: false, configurable: false },",
      "  print: { value: print, writable: true, configurable: false },",
      "  console: { value: console, writable: false, configurable: false },",
      "});",
      "return Object.freeze({",
      "  sanitize(value) { return __sanitize(value); },",
      "  getStdout() { return { stdout: __stdout, stdout_truncated: __stdoutTruncated }; },",
      "});",
      "})()",
    ].join("\n");
  }

  function buildUserScript() {
    const code = String(workerData.code);
    return [
      '"use strict";',
      "async function __runUser() {",
      code,
      "}",
      "__runUser();",
    ].join("\n");
  }

  (async () => {
    let controls: {
      sanitize: (value: unknown) => unknown;
      getStdout: () => { stdout: string; stdout_truncated: boolean };
    } | null = null;
    const stdoutState = () => {
      try {
        return controls && typeof controls.getStdout === "function"
          ? controls.getStdout()
          : { stdout: "", stdout_truncated: false };
      } catch {
        return { stdout: "", stdout_truncated: false };
      }
    };
    const errorMessage = (error: unknown) => {
      let msg: string;
      if (
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof (error as { message?: unknown }).message === "string"
      ) {
        msg = (error as { message: string }).message;
      } else {
        msg = String(error);
      }
      // error.message 也要封顶:用户可 throw new Error("x".repeat(huge)),不 cap 会让 error 字段无界
      // 撑爆回传帧(R13-2)。复用 result string 上限。
      const limit = Number(workerData.resultStringLimit) || 16384;
      return msg.length > limit ? `${msg.slice(0, limit)}...[truncated]` : msg;
    };
    try {
      const context = vm.createContext(Object.create(null), {
        codeGeneration: { strings: false, wasm: false },
        name: "qingagent-run-js",
      });
      controls = new vm.Script(buildPreludeScript(), {
        filename: "run_js_prelude.js",
        displayErrors: true,
      }).runInContext(context, { displayErrors: true });
      const script = new vm.Script(buildUserScript(), {
        filename: "run_js_user_code.js",
        displayErrors: true,
      });
      const value = await script.runInContext(context, { displayErrors: true });
      if (!controls) throw new Error("run_js prelude failed");
      const stdout = stdoutState();
      parentPort.postMessage({
        ok: true,
        result: controls.sanitize(value),
        stdout: stdout.stdout,
        stdout_truncated: stdout.stdout_truncated,
      });
    } catch (error) {
      const stdout = stdoutState();
      parentPort.postMessage({
        ok: false,
        error: errorMessage(error),
        stdout: stdout.stdout,
        stdout_truncated: stdout.stdout_truncated,
        failureKind: "codeError",
      });
    }
  })();
}

// worker 源码由 runJsWorkerMain.toString() 拼成,在 worker 里 eval 执行。若打包器开启
// keepNames(如 tsx 默认),esbuild 会给嵌套函数注入 __name(fn,"name") 调用——worker eval
// 作用域里没有这个 helper 会直接抛 "__name is not defined"。预置一个 no-op shim 兜底,
// 让 worker 不受打包器 keepNames 设置影响(生产 esbuild 默认 keepNames=false,此处仅防御)。
const RUN_JS_WORKER_SOURCE = `globalThis.__name ??= (fn) => fn;\n(${runJsWorkerMain.toString()})();`;

function jsonStringifyInput(value: unknown): { ok: true; text: string } | { ok: false; error: string } {
  try {
    const text = JSON.stringify(value ?? null);
    if (text.length > MAX_INPUT_JSON_CHARS) {
      return { ok: false, error: `input_json 过大,最多 ${MAX_INPUT_JSON_CHARS} 字符` };
    }
    return { ok: true, text };
  } catch (error) {
    return {
      ok: false,
      error: `input_json 不能序列化为 JSON:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function runJsInWorker(input: RunJsInput, abortSignal?: AbortSignal): Promise<RunJsResult> {
  const parsed = runJsInputSchema.safeParse(input);
  if (!parsed.success) {
    return Promise.resolve({
      ok: false,
      stdout: "",
      error: parsed.error.issues.map((issue) => issue.message).join("; "),
      failureKind: "codeError",
    });
  }

  const inputText = jsonStringifyInput(parsed.data.input_json);
  if (!inputText.ok) {
    return Promise.resolve({
      ok: false,
      stdout: "",
      error: inputText.error,
      failureKind: "codeError",
    });
  }
  if (abortSignal?.aborted) {
    return Promise.resolve({
      ok: false,
      stdout: "",
      error: "aborted",
      failureKind: "aborted",
    });
  }

  const timeoutMs = parsed.data.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  return new Promise<RunJsResult>((resolve) => {
    let settled = false;
    const worker = new Worker(RUN_JS_WORKER_SOURCE, {
      eval: true,
      workerData: {
        code: parsed.data.code,
        inputText: inputText.text,
        stdoutLimit: MAX_STDOUT_CHARS,
        resultStringLimit: MAX_RESULT_STRING_CHARS,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 16,
        codeRangeSizeMb: 16,
        stackSizeMb: 4,
      },
    });

    const cleanup = () => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
    };
    const finish = (result: RunJsResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate().catch(() => {});
      resolve(result);
    };
    const terminateWith = (result: RunJsResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate().finally(() => resolve(result));
    };
    const onAbort = () => terminateWith({
      ok: false,
      stdout: "",
      error: "aborted",
      failureKind: "aborted",
    });
    const timer = setTimeout(() => {
      terminateWith({
        ok: false,
        stdout: "",
        error: "timeout",
        failureKind: "timedOut",
      });
    }, timeoutMs);

    abortSignal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message: WorkerMessage) => {
      finish({
        ok: Boolean(message.ok),
        result: message.result,
        stdout: typeof message.stdout === "string" ? message.stdout : "",
        error: message.error ?? null,
        stdout_truncated: Boolean(message.stdout_truncated),
        failureKind: isRunScriptFailureKind(message.failureKind)
          ? message.failureKind
          : message.ok
            ? undefined
            : "codeError",
      });
    });
    worker.once("error", (error) => {
      finish({
        ok: false,
        stdout: "",
        error: error.message,
        failureKind: failureKindFromWorkerError(error),
      });
    });
    worker.once("exit", (code) => {
      if (!settled && code !== 0) {
        finish({
          ok: false,
          stdout: "",
          error: `worker exited with code ${code}`,
          failureKind: "codeError",
        });
      }
    });
  });
}

export const runJsTool = createTool({
  id: "run_js",
  description:
    "进程内执行受限 JS 片段,用于确定性计算、JSON/文本转换和轻量数据处理。代码在 worker_thread + vm 干净 context 中运行," +
    "没有 require/module/process/fetch/fs/net/定时器等 Node 能力;超时会硬 terminate worker。代码可通过 input/input_json 读取结构化输入," +
    "用 return 返回 JSON 结果,用 console.log/print 输出 stdout。",
  inputSchema: runJsInputSchema,
  outputSchema: runJsOutputSchema,
  execute: async (input, context) => runJsInWorker(input, context?.abortSignal),
});
