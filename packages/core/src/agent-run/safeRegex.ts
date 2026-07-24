import { Worker } from "node:worker_threads";

export type CompileSafeRegexResult =
  | { ok: true; re: RegExp }
  | { ok: false; error: string };

export type ExecSafeRegexResult =
  | { ok: true; matches: RegExpMatchArray[] }
  | { ok: false; error: string };

type WorkerCtor = typeof Worker;

interface WorkerMatch {
  text: string;
  index: number;
  captures: string[];
}

interface WorkerRequest {
  id: number;
  pattern: string;
  flags: string;
  text: string;
  limit: number;
}

type WorkerResponse =
  | { id: number; ok: true; matches: WorkerMatch[] }
  | { id: number; ok: false; error: string };

interface SafeRegexTask {
  request: WorkerRequest;
  resolve: (result: ExecSafeRegexResult) => void;
  totalTimer: ReturnType<typeof setTimeout>;
  runTimer?: ReturnType<typeof setTimeout>;
}

interface PooledWorker {
  worker: Worker;
  busy: boolean;
  task: SafeRegexTask | null;
}

const MAX_PATTERN_LENGTH = 256;
const MAX_TEXT_LENGTH = 20_000;
const DEFAULT_MATCH_LIMIT = 1000;
const RUN_TIMEOUT_MS = 200;
const TOTAL_TIMEOUT_MS = 500;
const ALLOWED_FLAGS = new Set(["i", "u", "m"]);
const EXECUTOR_UNAVAILABLE_ERROR = "安全正则执行器不可用";
const TRUTHY_FLAG_VALUES = new Set(["1", "true", "yes", "on"]);

let nextTaskId = 1;
let workerCtor: WorkerCtor | null = Worker;
let pool: PooledWorker[] = [];
let queue: SafeRegexTask[] = [];
let createdWorkers = 0;
let processExitHookInstalled = false;

function isTruthyFlag(raw: string | undefined): boolean {
  return raw
    ? TRUTHY_FLAG_VALUES.has(raw.trim().toLowerCase())
    : false;
}

function poolSize(): number {
  const raw = Number(process.env.QINGAGENT_SAFE_REGEX_WORKERS ?? "2");
  if (!Number.isFinite(raw) || raw <= 0) return 2;
  return Math.max(1, Math.min(8, Math.floor(raw)));
}

function normalizeFlags(flags = ""): { ok: true; flags: string } | { ok: false; error: string } {
  const seen = new Set<string>();
  for (const flag of flags) {
    if (!ALLOWED_FLAGS.has(flag)) return { ok: false, error: "unsafe regex (flags)" };
    seen.add(flag);
  }
  seen.add("g");
  return { ok: true, flags: [...seen].sort().join("") };
}

function hasBackreference(pattern: string): boolean {
  return /(^|[^\\])\\[1-9]/.test(pattern);
}

function hasLookbehind(pattern: string): boolean {
  return pattern.includes("(?<=") || pattern.includes("(?<!");
}

function hasNestedQuantifier(pattern: string): boolean {
  return /\((?:\?:|\?[:=!])?(?:[^()[\]\\]|\\.|\[[^\]]*\])*[+*](?:[^()[\]\\]|\\.|\[[^\]]*\])*\)\s*(?:[+*]|\{\d*,?\d*\})/.test(pattern);
}

function rejectsEmptyMatch(re: RegExp): boolean {
  try {
    const clone = new RegExp(re.source, re.flags);
    return clone.exec("") !== null;
  } catch {
    return true;
  }
}

export function compileSafeRegex(pattern: string, flags = ""): CompileSafeRegexResult {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { ok: false, error: "unsafe regex (pattern too long)" };
  }
  if (hasBackreference(pattern)) {
    return { ok: false, error: "unsafe regex (backreference)" };
  }
  if (hasLookbehind(pattern)) {
    return { ok: false, error: "unsafe regex (lookbehind)" };
  }
  if (hasNestedQuantifier(pattern)) {
    return { ok: false, error: "unsafe regex (nested quantifier)" };
  }

  const normalized = normalizeFlags(flags);
  if (!normalized.ok) return normalized;

  try {
    const re = new RegExp(pattern, normalized.flags);
    if (rejectsEmptyMatch(re)) {
      return { ok: false, error: "unsafe regex (empty match)" };
    }
    return { ok: true, re };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function makeRegExpMatchArray(input: string, match: WorkerMatch): RegExpMatchArray {
  const array = [match.text, ...match.captures] as unknown as RegExpMatchArray;
  array.index = match.index;
  array.input = input;
  return array;
}

function inlineWorkerSource(): string {
  return `
    function run(input) {
      try {
        const re = new RegExp(input.pattern, input.flags);
        const matches = [];
        let match;
        while ((match = re.exec(input.text)) !== null) {
          if ((match[0] || "").length === 0) {
            re.lastIndex += 1;
            continue;
          }
          if (matches.length >= input.limit) {
            return { ok: false, error: "unsafe regex (too many matches)" };
          }
          matches.push({
            text: match[0] || "",
            index: match.index,
            captures: match.slice(1).map((part) => part || ""),
          });
        }
        return { ok: true, matches };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    const { parentPort } = process.getBuiltinModule("worker_threads");
    parentPort.on("message", (input) => {
      parentPort.postMessage({ id: input.id, ...run(input) });
    });
  `;
}

function createWorker(): PooledWorker {
  const Ctor = workerCtor;
  if (!Ctor || isTruthyFlag(process.env.QINGAGENT_SAFE_REGEX_DISABLE_WORKER)) {
    throw new Error("safeRegex worker unavailable");
  }

  // 始终使用内联源码：core 会被 desktop 的 esbuild 打成单文件 bundle，
  // new URL("./safeRegex.worker.js", import.meta.url) 不会自动产出/携带旁车文件。
  // eval worker 仍在独立线程内执行并受同一墙钟护栏约束；构造失败继续 fail-closed。
  const worker = new Ctor(inlineWorkerSource(), { eval: true });

  createdWorkers += 1;
  const pooled: PooledWorker = { worker, busy: false, task: null };

  worker.on("message", (message: WorkerResponse) => {
    const task = pooled.task;
    if (!task || task.request.id !== message.id) return;
    clearTimeout(task.totalTimer);
    if (task.runTimer) clearTimeout(task.runTimer);
    pooled.busy = false;
    pooled.task = null;
    if (message.ok) {
      task.resolve({
        ok: true,
        matches: message.matches.map((match) => makeRegExpMatchArray(task.request.text, match)),
      });
    } else {
      task.resolve({ ok: false, error: message.error });
    }
    dispatchQueue();
  });

  worker.on("error", (err) => {
    const task = pooled.task;
    dropWorker(pooled);
    if (task) {
      clearTimeout(task.totalTimer);
      if (task.runTimer) clearTimeout(task.runTimer);
      pooled.busy = false;
      pooled.task = null;
      task.resolve({ ok: false, error: EXECUTOR_UNAVAILABLE_ERROR });
    }
    dispatchQueue();
    if (!task) {
      void err;
    }
  });

  worker.on("exit", () => {
    const task = pooled.task;
    dropWorker(pooled);
    if (task) {
      clearTimeout(task.totalTimer);
      if (task.runTimer) clearTimeout(task.runTimer);
      pooled.busy = false;
      pooled.task = null;
      task.resolve({ ok: false, error: EXECUTOR_UNAVAILABLE_ERROR });
    }
    dispatchQueue();
  });

  return pooled;
}

function installProcessExitHook(): void {
  if (processExitHookInstalled) return;
  processExitHookInstalled = true;
  process.once("exit", () => {
    for (const pooled of pool) {
      void pooled.worker.terminate();
    }
    pool = [];
    queue = [];
  });
}

function dropWorker(pooled: PooledWorker): void {
  pool = pool.filter((candidate) => candidate !== pooled);
}

function getIdleWorker(): PooledWorker | null {
  const idle = pool.find((candidate) => !candidate.busy);
  if (idle) return idle;
  if (pool.length >= poolSize()) return null;
  try {
    const created = createWorker();
    pool.push(created);
    installProcessExitHook();
    return created;
  } catch {
    return null;
  }
}

function failQueuedTasksAsUnavailable(): void {
  const unavailable = queue;
  queue = [];
  for (const task of unavailable) {
    clearTimeout(task.totalTimer);
    if (task.runTimer) clearTimeout(task.runTimer);
    task.resolve({ ok: false, error: EXECUTOR_UNAVAILABLE_ERROR });
  }
}

function dispatchQueue(): void {
  if (!workerCtor || isTruthyFlag(process.env.QINGAGENT_SAFE_REGEX_DISABLE_WORKER)) {
    failQueuedTasksAsUnavailable();
    return;
  }
  while (queue.length > 0) {
    const worker = getIdleWorker();
    if (!worker) {
      if (pool.length >= poolSize()) return;
      failQueuedTasksAsUnavailable();
      return;
    }
    const task = queue.shift()!;
    worker.busy = true;
    worker.task = task;
    task.runTimer = setTimeout(() => {
      if (worker.task !== task) return;
      clearTimeout(task.totalTimer);
      worker.task = null;
      worker.busy = false;
      dropWorker(worker);
      void worker.worker.terminate();
      task.resolve({ ok: false, error: "unsafe regex (timeout)" });
      dispatchQueue();
    }, RUN_TIMEOUT_MS);
    worker.worker.postMessage(task.request);
  }
}

async function runInWorkerPool(re: RegExp, text: string, limit: number): Promise<ExecSafeRegexResult> {
  return new Promise<ExecSafeRegexResult>((resolve) => {
    const request: WorkerRequest = {
      id: nextTaskId++,
      pattern: re.source,
      flags: re.flags,
      text,
      limit,
    };
    const task: SafeRegexTask = {
      request,
      resolve,
      totalTimer: setTimeout(() => {
        queue = queue.filter((candidate) => candidate !== task);
        const running = pool.find((candidate) => candidate.task === task);
        if (running) {
          if (task.runTimer) clearTimeout(task.runTimer);
          running.task = null;
          running.busy = false;
          dropWorker(running);
          void running.worker.terminate();
        }
        resolve({ ok: false, error: "unsafe regex (timeout)" });
        dispatchQueue();
      }, TOTAL_TIMEOUT_MS),
    };
    queue.push(task);
    dispatchQueue();
  });
}

export async function execSafeRegexAll(
  re: RegExp,
  text: string,
  limit = DEFAULT_MATCH_LIMIT,
): Promise<ExecSafeRegexResult> {
  if (!workerCtor || isTruthyFlag(process.env.QINGAGENT_SAFE_REGEX_DISABLE_WORKER)) {
    return { ok: false, error: EXECUTOR_UNAVAILABLE_ERROR };
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return { ok: false, error: "unsafe regex (text too long)" };
  }
  const maxMatches = Math.min(limit, DEFAULT_MATCH_LIMIT);
  if (maxMatches <= 0) return { ok: true, matches: [] };

  return runInWorkerPool(re, text, maxMatches);
}

export function __setSafeRegexWorkerCtorForTest(ctor: WorkerCtor | null): void {
  terminateSafeRegexWorkersForTest();
  workerCtor = ctor;
}

export function __getSafeRegexPoolStatsForTest(): { createdWorkers: number; liveWorkers: number } {
  return { createdWorkers, liveWorkers: pool.length };
}

export function terminateSafeRegexWorkersForTest(): void {
  for (const pooled of pool) {
    void pooled.worker.terminate();
  }
  pool = [];
  queue = [];
  createdWorkers = 0;
}
