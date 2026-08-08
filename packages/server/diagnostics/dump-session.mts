/**
 * dump-session.mts — 一条命令导出任意会话的完整状态，用于秒级排障。
 *
 * 用法（在 packages/server 目录下运行）:
 *   npx tsx diagnostics/dump-session.mts <sessionId>
 *   npx tsx diagnostics/dump-session.mts --latest           # 选最近更新的 thread
 *   npx tsx diagnostics/dump-session.mts --title "<substr>"  # 按标题子串匹配
 *
 * 复用 @qingagent/core 的 loadSessionFromThread（底层 LibSQLStore + Memory.getThreadById），
 * 由 Mastra/msgpackr 自动解码二进制元数据 —— 绝不手工解 msgpack。
 *
 * 输出同时写到 stdout 和 /tmp/session-dump-<id>.txt。
 *
 * 打印内容：
 *   - thread id / title / docState / docVersion / runId / toolCallId
 *   - suggestions (ids) / patchVerdicts
 *   - legacySections（index, kind, 完整文本）
 *   - chatHistory 中每个 toolCall（name, status；候选建议额外打印
 *     blockIndex / summary / 完整 before / 完整 after / result）
 *
 * 注意 SessionState 的形状（见 packages/core/src/session/sessionState.ts）:
 *   - suggestions / patchVerdicts 是 Map（不是数组）
 *   - chatHistory[i].parts[j] = { kind: "toolCall", data: ToolCallSpec }
 *   - suggestions Map<toolCallId, { suggestion: DocSuggestion, before, after }>
 *     是 before/after 的权威来源；chatHistory body 作为补充。
 */
import { writeFileSync } from "node:fs";
import { loadSessionFromThread, getMemory } from "@qingagent/core";

// ---- 输出收集：同时写 stdout 与文件 ----
const lines: string[] = [];
const suggestionToolName = "docSuggestion";
const legacySuggestionToolName = "propose" + "Patch";

function out(s = "") {
  lines.push(s);
  // eslint-disable-next-line no-console
  console.log(s);
}

function fmt(v: unknown): string {
  if (v === undefined) return "<undefined>";
  if (v === null) return "<null>";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// ---- 工具：在任意嵌套结构中向下走，直到找到满足判定的对象 ----
/**
 * 反复进入 .data，直到当前对象自身满足 `has`。
 * 候选建议的历史 body 可能被 Mastra 包多层 .data，
 * 可能还会被 Mastra 再包一层，所以最多向下走 maxDepth 层。
 */
function walkUntil(
  node: any,
  has: (n: any) => boolean,
  maxDepth = 12,
): any {
  let cur = node;
  let depth = 0;
  while (cur && typeof cur === "object" && depth < maxDepth) {
    if (has(cur)) return cur;
    if (cur.data !== undefined) {
      cur = cur.data;
      depth++;
      continue;
    }
    break;
  }
  return has(cur) ? cur : undefined;
}

function pickBeforeAfter(node: any): {
  before?: string;
  after?: string;
  summary?: string;
  blockIndex?: number;
} {
  const target = walkUntil(
    node,
    (n) => n && typeof n === "object" && ("before" in n || "after" in n),
  );
  if (target && typeof target === "object") {
    return {
      before: target.before,
      after: target.after,
      summary: target.summary,
      blockIndex: target.blockIndex,
    };
  }
  return {};
}

/** 段落文本：LegacySection 形态为 { kind, data:{ text|body|caption|alt|... } }。 */
function pickSectionText(section: any): string | undefined {
  if (section == null) return undefined;
  if (typeof section === "string") return section;
  const d = section.data ?? section;
  const candidates = [
    d?.text,
    d?.body,
    d?.caption,
    d?.alt,
    section?.text,
    section?.body,
  ];
  for (const c of candidates) {
    if (typeof c === "string") return c;
  }
  // 表格特殊处理
  if (Array.isArray(d?.rows)) {
    const head = Array.isArray(d.head) ? d.head.join(" | ") : "";
    const rows = d.rows.map((r: string[]) => r.join(" | ")).join("\n");
    return [head, rows].filter(Boolean).join("\n");
  }
  // 兜底：再向下走找 text/body
  const deep = walkUntil(
    section,
    (n) =>
      n &&
      typeof n === "object" &&
      (typeof n.text === "string" || typeof n.body === "string"),
  );
  if (deep) {
    if (typeof deep.text === "string") return deep.text;
    if (typeof deep.body === "string") return deep.body;
  }
  return undefined;
}

function pickSectionKind(section: any): string | undefined {
  if (section == null || typeof section !== "object") return undefined;
  return section.kind ?? section.type;
}

// ---- 从 chatHistory 的 ChatMessage.parts 提取 toolCall 部分 ----
interface ExtractedToolCall {
  toolCallId?: string;
  name: string;
  status?: string;
  bodyKind?: string;
  body?: any;
  result?: any;
}

function extractToolCalls(chatHistory: any[]): ExtractedToolCall[] {
  const calls: ExtractedToolCall[] = [];
  for (const msg of chatHistory ?? []) {
    const parts = msg?.parts ?? [];
    for (const part of parts) {
      if (part?.kind !== "toolCall") continue;
      const spec = part.data ?? {};
      // ToolCallSpec = { id, name, render, status, body, result }
      // status 是 ToolCallStatus = { kind: "..." }
      const status =
        typeof spec.status === "object" ? spec.status?.kind : spec.status;
      const body = spec.body; // ToolCallBody = { kind, data }
      calls.push({
        toolCallId: spec.id,
        name: spec.name ?? body?.kind ?? "<unknown>",
        status,
        bodyKind: body?.kind,
        body,
        result: spec.result,
      });
    }
  }
  return calls;
}

// ---- 解析命令行，定位 threadId ----
async function resolveThreadId(argv: string[]): Promise<string> {
  const latestIdx = argv.indexOf("--latest");
  const titleIdx = argv.indexOf("--title");

  if (latestIdx === -1 && titleIdx === -1) {
    const id = argv.find((a) => !a.startsWith("--"));
    if (!id)
      throw new Error(
        "用法: dump-session.mts <sessionId> | --latest | --title <substr>",
      );
    return id;
  }

  // 复用 app 的 Memory；listThreads 会按 updatedAt 排序。
  const memory = getMemory();
  const QINGAGENT_RESOURCE_ID = "qingagent-user";
  const current = await memory.listThreads({
    filter: { resourceId: QINGAGENT_RESOURCE_ID },
    orderBy: { field: "updatedAt", direction: "DESC" },
    page: 0,
    perPage: 200,
  });
  const all = current.threads;
  if (all.length === 0) throw new Error("数据库中没有任何 thread。");

  if (titleIdx !== -1) {
    const sub = (argv[titleIdx + 1] ?? "").toLowerCase();
    const hit = all.find((t: any) =>
      String(t.title ?? "").toLowerCase().includes(sub),
    );
    if (!hit) throw new Error(`没有标题包含 "${sub}" 的 thread。`);
    return String(hit.id);
  }
  // --latest
  return String(all[0].id);
}

async function main() {
  const argv = process.argv.slice(2);
  const threadId = await resolveThreadId(argv);

  const s = await loadSessionFromThread(threadId);
  if (!s) {
    out(`thread "${threadId}" 不存在（loadSessionFromThread 返回 null）。`);
    const outFile = `/tmp/session-dump-${threadId}.txt`;
    writeFileSync(outFile, lines.join("\n"), "utf8");
    // eslint-disable-next-line no-console
    console.log(`\n[dump-session] 已写入 ${outFile}`);
    return;
  }

  // suggestions / patchVerdicts 是 Map
  const suggestions: Map<string, any> =
    s.suggestions instanceof Map ? s.suggestions : new Map(Object.entries(s.suggestions ?? {}));
  const patchVerdicts: Map<string, any> =
    s.patchVerdicts instanceof Map
      ? s.patchVerdicts
      : new Map(Object.entries(s.patchVerdicts ?? {}));

  out("================ SESSION DUMP ================");
  out(`thread id    : ${s.threadId ?? threadId}`);
  out(`title        : ${s.title ?? "<none>"}`);
  out(`docState     : ${fmt(s.docState)}`);
  out(`docVersion   : ${fmt(s.docVersion)}`);
  out(`runId        : ${fmt(s.runId)}`);
  out(`toolCallId   : ${fmt(s.toolCallId)}`);
  out("");

  // suggestions (ids)
  out("---------------- suggestions -----------------");
  out(`count        : ${suggestions.size}`);
  for (const [id, spec] of suggestions.entries()) {
    const suggestion = spec?.suggestion ?? spec;
    out(
      `  id=${id}  blockIndex=${spec?.blockIndex}  blockId=${fmt(suggestion?.anchor?.blockId)}  summary=${fmt(suggestion?.summary ?? spec?.summary)}`,
    );
  }
  out("");

  // patchVerdicts
  out("--------------- patchVerdicts ----------------");
  out(`count        : ${patchVerdicts.size}`);
  for (const [id, v] of patchVerdicts.entries()) {
    out(`  id=${id} -> ${fmt(v)}`);
  }
  out("");

  // legacySections (index, kind, FULL text)
  out("---------------- legacySections -----------------");
  const sections = s.legacySections ?? [];
  out(`count        : ${sections.length}`);
  for (const [i, sec] of sections.entries()) {
    const kind = pickSectionKind(sec) ?? "<unknown>";
    const text = pickSectionText(sec);
    out(`  --- section[${i}] kind=${kind} ---`);
    out(text === undefined ? "  <no text found>" : text);
    out("");
  }
  out("");

  // chatHistory toolCalls
  out("--------------- chatHistory toolCalls --------");
  const calls = extractToolCalls(s.chatHistory ?? []);
  out(`messages     : ${(s.chatHistory ?? []).length}`);
  out(`toolCalls    : ${calls.length}`);
  out("");
  for (const [i, call] of calls.entries()) {
    out(
      `  === toolCall[${i}] name=${call.name} status=${call.status ?? "?"} id=${call.toolCallId ?? "?"} ===`,
    );
    const isSuggestionTool =
      call.name === suggestionToolName ||
      call.bodyKind === suggestionToolName ||
      call.name === legacySuggestionToolName ||
      call.bodyKind === legacySuggestionToolName;
    if (isSuggestionTool) {
      // 优先从 chatHistory body 里取历史 before/after；
      // 再用 suggestions Map（权威，keyed by toolCallId）补齐。
      const fromBody = pickBeforeAfter(call.body);
      const fromSuggestion = call.toolCallId
        ? suggestions.get(call.toolCallId)
        : undefined;
      const suggestion = fromSuggestion?.suggestion ?? fromSuggestion;
      const before = fromBody.before ?? fromSuggestion?.before ?? suggestion?.preview?.deleteText;
      const after = fromBody.after ?? fromSuggestion?.after ?? suggestion?.preview?.insertText;
      const summary = fromBody.summary ?? suggestion?.summary ?? fromSuggestion?.summary;
      const blockIndex = fromBody.blockIndex ?? fromSuggestion?.blockIndex;
      const source = fromBody.before !== undefined ? "chatHistory.body" : "suggestions";
      out(`    source       : ${source}`);
      out(`    blockIndex : ${fmt(blockIndex)}`);
      out(`    blockId      : ${fmt(suggestion?.anchor?.blockId)}`);
      out(`    summary      : ${fmt(summary)}`);
      out(`    --- BEFORE (full) ---`);
      out(before === undefined ? "    <no before>" : String(before));
      out(`    --- AFTER (full) ----`);
      out(after === undefined ? "    <no after>" : String(after));
      out(`    --- result ---`);
      out(`    ${fmt(call.result)}`);
    } else {
      if (call.body !== undefined) {
        out(`    body   : ${fmt(call.body)}`);
      }
      if (call.result !== undefined) {
        out(`    result : ${fmt(call.result)}`);
      }
    }
    out("");
  }

  // 额外：直接列出 suggestions 的完整 before/after（即使没出现在 chatHistory）
  out("--------- suggestions FULL before/after ------");
  out(`count        : ${suggestions.size}`);
  let pi = 0;
  for (const [id, spec] of suggestions.entries()) {
    const suggestion = spec?.suggestion ?? spec;
    out(
      `  === suggestion[${pi}] id=${id} blockIndex=${spec?.blockIndex} blockId=${fmt(suggestion?.anchor?.blockId)} ===`,
    );
    out(`    summary      : ${fmt(suggestion?.summary ?? spec?.summary)}`);
    out(`    --- BEFORE (full) ---`);
    out(
      spec?.before === undefined && suggestion?.preview?.deleteText === undefined
        ? "    <no before>"
        : String(spec?.before ?? suggestion?.preview?.deleteText),
    );
    out(`    --- AFTER (full) ----`);
    out(
      spec?.after === undefined && suggestion?.preview?.insertText === undefined
        ? "    <no after>"
        : String(spec?.after ?? suggestion?.preview?.insertText),
    );
    out("");
    pi++;
  }

  out("================ END DUMP ====================");

  const outFile = `/tmp/session-dump-${s.threadId ?? threadId}.txt`;
  writeFileSync(outFile, lines.join("\n"), "utf8");
  // eslint-disable-next-line no-console
  console.log(`\n[dump-session] 已写入 ${outFile}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    // eslint-disable-next-line no-console
    console.error("[dump-session] 失败:", err?.stack ?? err);
    process.exit(1);
  },
);
