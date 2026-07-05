#!/usr/bin/env node
// doc-calc:文档数据计算助手(零依赖 node 脚本)。
// 用法:node calc.mjs <op> [--json '<内联数据>' | --file <路径>]
//   op: sum | stats | sumcol
// 数据来源优先级:--file > --json/--data > stdin(兜底)。
//   注意:沙箱执行前 gate 会拒绝管道/重定向,所以**不要**再用 `echo ... | node calc.mjs`,
//   改用 `--json`(内联数据)或 `--file`(先把数据写进工作目录文件再传路径)。
// 例:node calc.mjs sum --json '[1,2,3]'         → {"sum":6,"count":3}
//    node calc.mjs stats --file nums.txt        → {count,sum,avg,min,max}
//    node calc.mjs sumcol 1 --file table.csv    → 按第1列(0基)求和 → {"sum":30}

import { readFileSync, realpathSync, writeSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CURRENCY_RE = String.raw`[$￥¥€£]`;
const NUMBER_BODY_RE = String.raw`(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?`;
const NUMBER_TOKEN_RE = new RegExp(
  String.raw`[+-]\s*${CURRENCY_RE}\s*${NUMBER_BODY_RE}|${CURRENCY_RE}\s*[+-]?\s*${NUMBER_BODY_RE}|[+-]?${NUMBER_BODY_RE}`,
  "g",
);

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// 全角数字/符号归一到 ASCII:中文文档里货币/数字常用全角(１２３、，．＋－),不归一会被静默漏算
// (R12 codex-2)。
const FULLWIDTH_PUNCT = { "，": ",", "．": ".", "＋": "+", "－": "-" };
function normalizeFullwidth(s) {
  return String(s ?? "")
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[，．＋－]/g, (c) => FULLWIDTH_PUNCT[c]);
}

function parseNumberToken(token) {
  const normalized = normalizeFullwidth(token).replace(/,/g, "").replace(/[^\d.eE+-]/g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : undefined;
}

function extractNumbers(text) {
  const matches = normalizeFullwidth(text).match(NUMBER_TOKEN_RE) ?? [];
  return matches.map(parseNumberToken).filter((n) => n !== undefined);
}

// 引号感知的 CSV 记录/列切分(RFC4180 子集:双引号字段、""转义、字段内逗号/换行)。
// 仅用于 sumcol 列路径——之前裸 split(",") 会把 `"Alpha, Inc",100` / `"1,200"` / 多行 quoted 字段
// 错列或丢行,给错值(R12 codex-2 / R13 codex-4)。quote 未闭合(畸形)时回退按行,避免一处坏引号
// 吞掉后续所有行。
function splitQuotedRecords(text) {
  const records = [];
  let record = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        record += '""';
        i += 1;
      } else {
        inQuotes = !inQuotes;
        record += ch;
      }
      continue;
    }
    if (!inQuotes && (ch === "\n" || ch === "\r")) {
      records.push(record);
      record = "";
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      continue;
    }
    record += ch;
  }
  if (record.trim() !== "") records.push(record);
  return { records, closed: !inQuotes };
}

function hasDelimiterOutsideQuotes(text, delimiter) {
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') i += 1;
      else inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && ch === delimiter) return true;
  }
  return false;
}

function splitCsvLine(line) {
  const cells = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && ch === ",") {
      cells.push(cell);
      cell = "";
      continue;
    }
    cell += ch;
  }
  cells.push(cell);
  return cells;
}

/** calc 输入解析错误:被 calculateFromArgs 捕获后转成 {error} 协议。 */
export class CalcInputError extends Error {}

/** 把任意输入解析成数字数组:优先 JSON,否则按行/CSV 抽数字。 */
export function parseNumbers(raw, colIndex) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    // 以 [ 开头 = 明确的"JSON 数组"意图。解析失败/非数组绝不静默回退到文本抽数——
    // 否则 `[1,2,{"x":3}`(坏 JSON)会被当文本抽出 1,2,3 给出看似合理实则错误的结果。
    // 脏路径铁律:声明了 JSON 就按 JSON 严格校验,坏就硬报错(Round8 codex-2)。
    let arr;
    try {
      arr = JSON.parse(trimmed);
    } catch {
      throw new CalcInputError("invalid JSON array: malformed JSON input");
    }
    if (!Array.isArray(arr)) {
      throw new CalcInputError("invalid JSON: expected an array of numbers");
    }
    return arr
      .map((value) => {
        const text = String(value).trim();
        if (text === "") return undefined;
        const n = Number(text);
        if (Number.isFinite(n)) return n;
        // Number() 失败但含数字(含全角):走与文本路径一致的货币/千分位/全角感知解析,
        // 避免 ["$1,000", 2] 这种 JSON 数组静默只算出 2(脏路径漏算,R12 codex-2);
        // 纯非数字占位符("缺失"/"N/A")无数字 → 仍丢弃。
        if (/[0-9０-９]/.test(text)) {
          const [extracted] = extractNumbers(text);
          return extracted;
        }
        return undefined;
      })
      .filter((n) => n !== undefined);
  }
  const nums = [];
  const useColumn = typeof colIndex === "number";
  // sumcol 用引号感知记录切分(quoted 字段可含逗号/换行);非列路径仍按物理行(抽全行数字)。
  let records;
  if (useColumn) {
    const parsed = splitQuotedRecords(trimmed);
    records = parsed.closed ? parsed.records : trimmed.split(/\r?\n/);
  } else {
    records = trimmed.split(/\r?\n/);
  }
  for (const record of records) {
    if (!record.trim()) continue;
    if (useColumn) {
      // 列分隔优先 tab(避免货币千分位逗号被误当列分隔);无 tab 才用引号感知逗号切分
      const cells = hasDelimiterOutsideQuotes(record, "\t")
        ? record.split("\t")
        : splitCsvLine(record);
      const cell = cells[colIndex];
      const [n] = extractNumbers(cell);
      if (Number.isFinite(n)) nums.push(n);
    } else {
      // 抽该行所有数字求和(容忍千分位/货币符号/科学计数法)
      nums.push(...extractNumbers(record));
    }
  }
  return nums;
}

function round(n) {
  return Math.round(n * 1e6) / 1e6;
}

/** 解析 argv:分离 --file/--json/--data 标志与位置参数(op、列号)。 */
export function parseArgs(argv) {
  const positional = [];
  let file;
  let inline;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--file") file = argv[++i];
    else if (a.startsWith("--file=")) file = a.slice("--file=".length);
    else if (a === "--json" || a === "--data") inline = argv[++i];
    else if (a.startsWith("--json=")) inline = a.slice("--json=".length);
    else if (a.startsWith("--data=")) inline = a.slice("--data=".length);
    else positional.push(a);
  }
  return { positional, file, inline };
}

function normalizeForCompare(path) {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isInsideRoot(path, root) {
  const p = normalizeForCompare(path);
  const r = normalizeForCompare(root);
  return p === r || p.startsWith(r.endsWith(sep) ? r : `${r}${sep}`);
}

function realpathIfExists(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function resolveWorkspaceFile(file) {
  if (typeof file !== "string" || file.trim() === "") {
    return { ok: false, error: "--file must point to a file inside the current workspace" };
  }
  const cwd = process.cwd();
  const resolved = resolve(cwd, file);
  if (!isInsideRoot(resolved, cwd)) {
    return { ok: false, error: "--file path is outside the current workspace" };
  }
  const real = realpathIfExists(resolved);
  if (!isInsideRoot(real, cwd)) {
    return { ok: false, error: "--file path is outside the current workspace" };
  }
  return { ok: true, path: real };
}

/** 按来源优先级取原始输入文本:--file > --json/--data > stdin。 */
function readInput({ file, inline }, stdinText) {
  if (file !== undefined) {
    const checked = resolveWorkspaceFile(file);
    if (!checked.ok) return checked;
    try {
      return { ok: true, text: readFileSync(checked.path, "utf8") };
    } catch {
      return { ok: true, text: "" };
    }
  }
  if (inline !== undefined) return { ok: true, text: inline };
  if (stdinText !== undefined) return { ok: true, text: stdinText };
  return { ok: true, text: readStdin() };
}

export function calculateFromArgs(argv, stdinText) {
  const { positional, file, inline } = parseArgs(argv);
  const op = positional[0] ?? "stats";
  const colArg = positional[1];
  const colIndex = op === "sumcol" ? Number(colArg) : undefined;
  const input = readInput({ file, inline }, stdinText);
  if (!input.ok) {
    return { error: input.error, count: 0 };
  }
  let nums;
  try {
    nums = parseNumbers(input.text, colIndex);
  } catch (err) {
    return { error: err instanceof CalcInputError ? err.message : "invalid input", count: 0 };
  }

  if (nums.length === 0) {
    return { error: "no numbers parsed from input", count: 0 };
  }

  const sum = nums.reduce((a, b) => a + b, 0);
  if (op === "sum" || op === "sumcol") {
    return { sum: round(sum), count: nums.length };
  }
  // stats
  return {
    count: nums.length,
    sum: round(sum),
    avg: round(sum / nums.length),
    min: round(Math.min(...nums)),
    max: round(Math.max(...nums)),
  };
}

function main() {
  const out = calculateFromArgs(process.argv.slice(2));
  writeSync(1, JSON.stringify(out) + "\n");
  if ("error" in out) process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
