import { afterEach, describe, expect, it } from "vitest";
import { runJsInWorker, runJsTool } from "../tools/runJs.js";
import type { RunJsInput, RunJsResult } from "../tools/runJs.js";

const toolInvocationOptions = { toolCallId: "run-js-test", messages: [] } as never;

async function run(input: RunJsInput): Promise<RunJsResult> {
  if (!runJsTool.execute) throw new Error("run_js execute missing");
  return await runJsTool.execute(input, toolInvocationOptions) as RunJsResult;
}

describe("run_js capability tool", () => {
  afterEach(() => {
    delete process.env.RUN_JS_SECRET_SHOULD_NOT_LEAK;
  });

  it("执行确定性 JS 计算并通过结构化 input_json 传参", async () => {
    const result = await run({
      code: `
console.log("count", input.values.length);
return input.values.reduce((sum, value) => sum + value, 0);
`,
      input_json: { values: [1280, 960, 430, 1875] },
    });

    expect(result).toMatchObject({
      ok: true,
      result: 4545,
    });
    expect(result.stdout).toContain("count 4");
  });

  it("Round3 回归:NaN、Infinity 和 BigInt 返回值不会被静默序列化成 null 或丢精度", async () => {
    const result = await run({
      code: `
return {
  nan: NaN,
  inf: Infinity,
  negInf: -Infinity,
  finite: 1.25,
  big: 9007199254740993123456789n,
  nested: [NaN, Infinity, -Infinity],
};
`,
    });

    expect(result.ok).toBe(true);
    expect(result.result).toEqual({
      nan: "NaN",
      inf: "Infinity",
      negInf: "-Infinity",
      finite: 1.25,
      big: "9007199254740993123456789",
      nested: ["NaN", "Infinity", "-Infinity"],
    });
    expect(JSON.parse(JSON.stringify(result.result))).toEqual(result.result);
    expect(JSON.stringify(result.result)).not.toContain("null");
  });

  it("没有 Node 全局能力:require/module/process/fetch/Buffer 都不可用", async () => {
    const result = await run({
      code: `
return {
  require: typeof globalThis.require,
  module: typeof globalThis.module,
  process: typeof globalThis.process,
  fetch: typeof globalThis.fetch,
  Buffer: typeof globalThis.Buffer,
};
`,
    });

    expect(result).toMatchObject({
      ok: true,
      result: {
        require: "undefined",
        module: "undefined",
        process: "undefined",
        fetch: "undefined",
        Buffer: "undefined",
      },
    });
  });

  it("Round12:structuredClone 可用(纯 vm 内 polyfill,深拷贝/循环/Date·Map·Set/原型本地)", async () => {
    const result = await run({
      code: `
const o = { a: 1, b: { c: [1, 2, 3] } };
const cl = structuredClone(o);
cl.b.c.push(4);
const circ = {}; circ.self = circ;
const cc = structuredClone(circ);
const d = new Date(1700000000000);
const m = new Map([["x", 1]]);
const cd = structuredClone({ d, m });
let funcThrew = false;
try { structuredClone({ f: () => 1 }); } catch { funcThrew = true; }
return {
  typeofSC: typeof structuredClone,
  independent: cl.b.c.length === 4 && o.b.c.length === 3,
  notSameRef: cl !== o && cl.b !== o.b,
  circular: cc.self === cc,
  dateOk: cd.d instanceof Date && cd.d.getTime() === d.getTime(),
  mapOk: cd.m instanceof Map && cd.m.get("x") === 1,
  funcThrew,
  protoLocal: Object.getPrototypeOf(cl) === Object.prototype,
};
`,
    });
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({
      typeofSC: "function",
      independent: true,
      notSameRef: true,
      circular: true,
      dateOk: true,
      mapOk: true,
      funcThrew: true,
      protoLocal: true,
    });
  });

  it("Round13:TextEncoder/TextDecoder/queueMicrotask 纯 vm polyfill 可用且原型本地", async () => {
    const result = await run({
      code: `
const bytes = new TextEncoder().encode("héllo 中文 𝟙");
const back = new TextDecoder().decode(bytes);
let micro = "no";
queueMicrotask(() => { micro = "ran"; });
await Promise.resolve();
return {
  types: [typeof TextEncoder, typeof TextDecoder, typeof queueMicrotask].join(","),
  bytesIsU8: bytes instanceof Uint8Array,
  roundTrip: back === "héllo 中文 𝟙",
  ascii: Array.from(new TextEncoder().encode("AB")),
  micro,
  protoLocal: Object.getPrototypeOf(bytes) === Uint8Array.prototype,
};
`,
    });
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({
      types: "function,function,function",
      bytesIsU8: true,
      roundTrip: true,
      ascii: [65, 66],
      micro: "ran",
      protoLocal: true,
    });
  });

  it("Round15:UTF-8 codec 对畸形输入按 WHATWG 输出 U+FFFD,不解成错字符", async () => {
    const result = await run({
      code: `
const dec = new TextDecoder();
const enc = new TextEncoder();
const cp = (bytes) => Array.from(dec.decode(new Uint8Array(bytes))).map((c) => c.codePointAt(0));
return {
  valid: dec.decode(enc.encode("中文𝟙a")) === "中文𝟙a",
  loneCont: cp([0x80]),
  overlong: cp([0xc0, 0x80]),
  truncated: cp([0xe4, 0xb8]),
  illegalFirst: cp([0xff]),
  surrogateBytes: cp([0xed, 0xa0, 0x80]),
  loneSurrEnc: Array.from(enc.encode(String.fromCharCode(0xd800))),
};
`,
    });
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({
      valid: true,
      loneCont: [0xfffd],
      overlong: [0xfffd, 0xfffd],
      truncated: [0xfffd],
      illegalFirst: [0xfffd],
      surrogateBytes: [0xfffd, 0xfffd, 0xfffd],
      loneSurrEnc: [0xef, 0xbf, 0xbd],
    });
  });

  it("Round14:URLSearchParams 纯 vm polyfill 可用(查询解析/编解码/增删改/迭代)", async () => {
    const result = await run({
      code: `
const p = new URLSearchParams("a=1&b=2&a=3&x=%E4%B8%AD%E6%96%87&y=a+b");
p.append("c", "9"); p.set("a", "99"); p.delete("b");
return {
  type: typeof URLSearchParams,
  getAll: p.getAll("a"),
  cjk: p.get("x"),
  plus: p.get("y"),
  afterMut: p.toString(),
  fromPairs: new URLSearchParams([["q", "hello world"], ["r", "x&y"]]).toString(),
};
`,
    });
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({
      type: "function",
      getAll: ["99"],
      cjk: "中文",
      plus: "a b",
      afterMut: "a=99&x=%E4%B8%AD%E6%96%87&y=a+b&c=9",
      fromPairs: "q=hello+world&r=x%26y",
    });
  });

  it("Round8 纵深防御:eval/Function 在 globalThis 上被置 undefined(sonnet-2 EXTRA-1)", async () => {
    const result = await run({
      code: `
return {
  evalT: typeof globalThis.eval,
  funcT: typeof globalThis.Function,
};
`,
    });

    expect(result).toMatchObject({
      ok: true,
      result: { evalT: "undefined", funcT: "undefined" },
    });
  });

  it("拒绝 require('node:fs')、process.env、fetch 和动态 import('node:fs')", async () => {
    process.env.RUN_JS_SECRET_SHOULD_NOT_LEAK = "secret-value";
    const cases = [
      `return require("node:fs").readFileSync("/etc/passwd", "utf8");`,
      `return process.env.RUN_JS_SECRET_SHOULD_NOT_LEAK;`,
      `return fetch("https://example.com");`,
      `return await import("node:fs");`,
    ];

    for (const code of cases) {
      const result = await run({ code });
      expect(result.ok, code).toBe(false);
      expect(JSON.stringify(result), code).not.toContain("secret-value");
    }
  });

  it("拒绝 Function 构造逃逸,包括 print/input_json 构造器路径", async () => {
    const cases = [
      `return globalThis.constructor.constructor("return process")();`,
      `return print.constructor.constructor("return process")();`,
      `return input_json.constructor.constructor("return process")();`,
    ];

    for (const code of cases) {
      const result = await run({ code, input_json: { a: 1 } });
      expect(result.ok, code).toBe(false);
      expect(result.error, code).toMatch(/Code generation|process|not defined/i);
    }
  });

  it("Round13 回归:超长 error.message 被封顶截断,不无界撑爆回传", async () => {
    const result = await run({ code: 'throw new Error("E".repeat(100000));' });
    expect(result.ok).toBe(false);
    expect((result.error as string).length).toBeLessThan(17_000);
    expect(result.error).toContain("[truncated]");
    // 短 error 不受影响
    const short = await run({ code: 'throw new Error("short error");' });
    expect(short.error).toBe("short error");
    expect(short.failureKind).toBe("codeError");

    const forged = await run({
      code: `
console.error("FATAL ERROR: Reached heap limit heap out of memory");
throw new Error("FATAL ERROR: Reached heap limit heap out of memory");
`,
    });
    expect(forged.failureKind).toBe("codeError");
  });

  it("死循环会被 worker terminate 硬超时杀掉", async () => {
    const startedAt = Date.now();
    const result = await run({ code: "while (true) {}", timeout_ms: 100 });

    expect(result).toMatchObject({
      ok: false,
      error: "timeout",
      failureKind: "timedOut",
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("预取消与 worker 平台启动失败使用独立结构化归因", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runJsInWorker({ code: "return 1;" }, controller.signal)).resolves.toMatchObject({
      ok: false,
      failureKind: "aborted",
    });

    const originalExecPath = process.execPath;
    let platformFailure: RunJsResult;
    try {
      process.execPath = "/qingagent-test/missing-node-executable";
      platformFailure = await runJsInWorker({ code: "throw new Error('用户错误');" });
    } finally {
      process.execPath = originalExecPath;
    }
    expect(platformFailure).toEqual({
      ok: false,
      stdout: "",
      error: "代码执行器不可用",
      failureKind: "platformError",
    });
  });

  it("超大 stdout 和结果会被截断", async () => {
    const result = await run({
      code: `
console.log("x".repeat(100000));
return "y".repeat(100000);
`,
    });

    expect(result.ok).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(16_384);
    expect(result.stdout_truncated).toBe(true);
    expect(typeof result.result).toBe("string");
    expect((result.result as string).length).toBeLessThan(17_000);
    expect(result.result).toContain("[truncated]");
  });

  it("用户覆盖内部 helper 名与 print 后仍不能绕过 stdout/结果截断", async () => {
    const result = await run({
      code: `
globalThis.__sanitize = (value) => value;
globalThis.__appendStdout = (text) => {
  globalThis.__stdout = String(text);
};
print = (...values) => {
  globalThis.__appendStdout(values.join(" "));
};
console.log("x".repeat(100000));
return "y".repeat(100000);
`,
    });

    expect(result.ok).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(16_384);
    expect(result.stdout_truncated).toBe(true);
    expect(typeof result.result).toBe("string");
    expect((result.result as string).length).toBeLessThan(17_000);
    expect(result.result).toContain("[truncated]");
  });
});
