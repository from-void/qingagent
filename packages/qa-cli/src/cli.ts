#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApiClient } from "./apiClient.js";
import { discoverInstance } from "./discovery.js";
import { NEXT_STEP, QaCliError } from "./errors.js";
import { hasFlag, optionValue, optionValues, printJson } from "./output.js";
import { installPointerSkill, writerSkillMarkdown, type SkillInstallTarget } from "./skill.js";
import type {
  ExternalChatLogResponse,
  ExternalDocReadResponse,
  ExternalEventsMeta,
  ExternalFilesListResponse,
  ExternalFileTextResponse,
  ExternalProposalResponse,
  ExternalProposeOp,
  ExternalSessionCreateResponse,
  ExternalSessionsListResponse,
} from "./generated/externalApi.js";

interface EventOptions {
  follow: boolean;
  after: string;
  timeoutMs: number | null;
  until: string | null;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 0 || hasFlag(args, "--help") || hasFlag(args, "-h")) return help();
  const [group, command] = args;
  if (group === "status") return status(hasFlag(args, "--json"));
  if (group === "skills" && command === "read" && args[2] === "writer") {
    process.stdout.write(`${writerSkillMarkdown()}\n`);
    return;
  }
  if (group === "skills" && command === "install") {
    const target = args[2];
    if (target !== "claude" && target !== "codex") throw new QaCliError("VALIDATION", "skills install 只支持 claude|codex");
    const filePath = await installPointerSkill(target as SkillInstallTarget);
    return output({ installed: true, path: filePath }, hasFlag(args, "--json"));
  }
  const client = await ApiClient.create();
  if (group === "sessions" && command === "list") {
    const data = await client.request<ExternalSessionsListResponse>("/sessions");
    return output(data, hasFlag(args, "--json"));
  }
  if (group === "sessions" && command === "create") {
    const data = await client.request<ExternalSessionCreateResponse>("/sessions", { method: "POST", body: JSON.stringify({}) });
    return output(data, hasFlag(args, "--json"));
  }
  if (group === "doc" && command === "read") {
    const sessionId = requireOption(args, "-s");
    const lines = hasFlag(args, "--lines") ? "?lines=1" : "";
    const data = await client.request<ExternalDocReadResponse>(`/sessions/${encodeURIComponent(sessionId)}/doc${lines}`);
    if (hasFlag(args, "--json")) return printJson(data);
    process.stdout.write(`${data.markdownWithLineNumbers ?? data.markdown ?? ""}\n`);
    return;
  }
  if (group === "doc" && command === "state") {
    const sessionId = requireOption(args, "-s");
    const data = await client.request<ExternalDocReadResponse>(`/sessions/${encodeURIComponent(sessionId)}/doc`);
    return output(data, hasFlag(args, "--json"));
  }
  if (group === "doc" && command === "propose") {
    const sessionId = requireOption(args, "-s");
    const expectedDocVersion = Number(requireOption(args, "--expect-version"));
    const ops = await parseOps(args);
    const data: ExternalProposalResponse = await client.propose(sessionId, { expectedDocVersion, ops });
    return output(data, hasFlag(args, "--json"));
  }
  if (group === "doc" && command === "events") {
    const sessionId = requireOption(args, "-s");
    const explicitAfter = optionValue(args, "--after");
    const until = optionValue(args, "--until") ?? null;
    const after = explicitAfter ?? (until ? "tip" : "0");
    if (until && !explicitAfter) {
      process.stderr.write("[qa] warning: --until 未提供 --after,将从当前 tip 开始监听;提案闭环请优先使用 propose 返回的 seq\n");
    }
    return events(client, sessionId, {
      follow: hasFlag(args, "--follow"),
      after,
      timeoutMs: parseDuration(optionValue(args, "--timeout")),
      until,
    });
  }
  if (group === "chat" && command === "send") {
    const sessionId = requireOption(args, "-s");
    const text = chatText(args);
    const data = await client.chat(sessionId, { text });
    return output(data, hasFlag(args, "--json"));
  }
  if (group === "chat" && command === "log") {
    const sessionId = requireOption(args, "-s");
    const limit = optionValue(args, "--limit");
    const query = limit ? `?limit=${encodeURIComponent(limit)}` : "";
    const data = await client.request<ExternalChatLogResponse>(`/sessions/${encodeURIComponent(sessionId)}/chat${query}`);
    if (hasFlag(args, "--json")) return printJson(data);
    for (const message of data.messages) {
      process.stdout.write(`${roleLabel(message.role.kind)}  ${message.text}\n`);
    }
    return;
  }
  if (group === "chat" && command === "tail") {
    const sessionId = requireOption(args, "-s");
    return events(client, sessionId, { follow: true, after: "0", timeoutMs: null, until: null });
  }
  if (group === "files" && command === "list") {
    const sessionId = requireOption(args, "-s");
    const data = await client.request<ExternalFilesListResponse>(`/sessions/${encodeURIComponent(sessionId)}/files`);
    if (hasFlag(args, "--json")) return printJson(data);
    printFilesList(data);
    return;
  }
  if (group === "files" && command === "read") {
    const sessionId = requireOption(args, "-s");
    const materialId = requireOption(args, "--material");
    const maxBytes = optionValue(args, "--max-bytes");
    const query = maxBytes ? `?maxBytes=${encodeURIComponent(maxBytes)}` : "";
    const data = await client.request<ExternalFileTextResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(materialId)}/text${query}`,
    );
    if (hasFlag(args, "--json")) return printJson(data);
    process.stdout.write(data.text);
    if (!data.text.endsWith("\n")) process.stdout.write("\n");
    if (data.truncated) {
      process.stderr.write(`[qa] material truncated id=${data.id} byteLen=${data.byteLen}\n`);
    }
    return;
  }
  throw new QaCliError("VALIDATION", "未知命令");
}

async function status(json: boolean): Promise<void> {
  const info = await discoverInstance();
  const data = { ok: true, version: info.version, pid: info.pid, startedAt: info.startedAt };
  if (json) printJson(data);
  else process.stdout.write(`青简正在运行 version=${info.version} pid=${info.pid}\n`);
}

async function parseOps(args: string[]): Promise<ExternalProposeOp[]> {
  const opsFile = optionValue(args, "--ops");
  if (opsFile) return JSON.parse(await readFile(opsFile, "utf8")) as ExternalProposeOp[];
  const full = optionValue(args, "--full");
  if (full) return [{ kind: "fullDraft", markdown: await readFile(full, "utf8") }];
  const append = optionValue(args, "--append");
  const ops: ExternalProposeOp[] = [];
  if (append) ops.push({ kind: "appendSection", markdown: await readFile(append, "utf8") });
  for (const [oldText, newText] of optionValues(args, "--str-replace", 2)) {
    ops.push({ kind: "strReplace", old: oldText, new: newText });
  }
  if (ops.length === 0) throw new QaCliError("VALIDATION", "缺少提案 ops");
  return ops;
}

async function events(client: ApiClient, sessionId: string, options: EventOptions): Promise<void> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = options.timeoutMs === null ? null : setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  let reader: ReadableStreamDefaultReader<string> | null = null;
  let buffer = "";
  let received = 0;
  let reason: string | null = null;
  let meta: ExternalEventsMeta | null = null;
  let maxSeq = parseAfterSeq(options.after);
  try {
    const res = await client.openEvents(sessionId, options.after, controller.signal);
    process.stderr.write(`[qa] watching session=${sessionId} after=${options.after}\n`);
    reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const event = parseSseEvent(chunk);
        if (!event) continue;
        const data = event.data;
        if (data === "{}") continue;
        if (event.event === "meta") {
          meta = parseEventsMeta(data);
          if (meta?.gap) {
            reason = "gap";
            break;
          }
          continue;
        }
        process.stdout.write(`${data}\n`);
        received += 1;
        maxSeq = Math.max(maxSeq, frameSeq(data));
        const hit = untilHit(options.until, data);
        if (hit) {
          reason = hit;
          break;
        }
      }
      if (reason) break;
      if (!options.follow && !options.until && options.timeoutMs === null && meta && maxSeq >= meta.nextSeq - 1) {
        reason = "limit";
        break;
      }
    }
  } catch (error) {
    if (!timedOut) throw error;
  } finally {
    if (timer) clearTimeout(timer);
    await reader?.cancel().catch(() => undefined);
  }
  if (timedOut && !reason) reason = "timeout";
  if (reason) process.stderr.write(`[qa] events exited reason=${reason} received=${received}\n`);
}

function parseSseEvent(chunk: string): { event: string; data: string } | null {
  let event = "message";
  const data: string[] = [];
  for (const line of chunk.split(/\r?\n/)) {
    if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("data: ")) data.push(line.slice(6));
  }
  if (data.length === 0) return null;
  return { event, data: data.join("\n") };
}

function parseEventsMeta(data: string): ExternalEventsMeta | null {
  try {
    const parsed = JSON.parse(data) as Partial<ExternalEventsMeta>;
    if (
      typeof parsed.epoch === "number" &&
      typeof parsed.minSeq === "number" &&
      typeof parsed.nextSeq === "number" &&
      typeof parsed.gap === "boolean"
    ) {
      return parsed as ExternalEventsMeta;
    }
  } catch {
    return null;
  }
  return null;
}

function parseAfterSeq(after: string): number {
  if (after === "tip") return 0;
  const seq = Number(after);
  return Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : 0;
}

function frameSeq(data: string): number {
  try {
    const parsed = JSON.parse(data) as { seq?: unknown };
    return typeof parsed.seq === "number" && Number.isFinite(parsed.seq) ? parsed.seq : 0;
  } catch {
    return 0;
  }
}

function output(data: unknown, json: boolean): void {
  if (json) printJson(data);
  else process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function requireOption(args: string[], name: string): string {
  const value = optionValue(args, name);
  if (!value) throw new QaCliError("VALIDATION", `缺少 ${name}`);
  return value;
}

function chatText(args: string[]): string {
  const parts: string[] = [];
  for (let i = 2; i < args.length; i += 1) {
    const part = args[i]!;
    if (part === "-s" || part === "--session") {
      i += 1;
      continue;
    }
    if (part.startsWith("--")) continue;
    parts.push(part);
  }
  const text = parts.join(" ").trim();
  if (!text) throw new QaCliError("VALIDATION", "缺少聊天指令");
  return text;
}

function parseDuration(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^(\d+)(ms|s|m)?$/.exec(value);
  if (!match) throw new QaCliError("VALIDATION", "timeout 格式应为 600s/10m/1000ms");
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  if (unit === "m") return amount * 60_000;
  if (unit === "s") return amount * 1_000;
  return amount;
}

function untilHit(until: string | null, data: string): string | null {
  if (!until) return null;
  let frame: { kind?: string; data?: unknown };
  try {
    frame = JSON.parse(data) as { kind?: string; data?: unknown };
  } catch {
    return null;
  }
  if (until === "committed" && frame.kind === "docCommitted") return "committed";
  if (until === "review" && frame.kind === "docDiffReady") return "review";
  if (until === "reviewed") {
    if (frame.kind === "docCommitted") return "reviewed";
    if (frame.kind === "docStateChanged" && docStateKind(frame.data) !== "pendingReview") return "reviewed";
  }
  return null;
}

function docStateKind(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const state = (data as { state?: unknown }).state;
  if (!state || typeof state !== "object") return undefined;
  return (state as { kind?: unknown }).kind as string | undefined;
}

function roleLabel(role: string): string {
  if (role === "user") return "你";
  if (role === "agent") return "青简";
  return role;
}

function printFilesList(data: ExternalFilesListResponse): void {
  process.stdout.write(`材料区 session=${data.sessionId}\n`);
  if (data.materials.length === 0) {
    process.stdout.write("材料: 无\n");
  } else {
    process.stdout.write("材料:\n");
    for (const material of data.materials) {
      const state = material.parseState === "ready" ? "" : ` ${material.parseState}`;
      process.stdout.write(
        `- ${material.id}  ${material.filename}  ${material.wordCount}字${state}\n`,
      );
      const summary = compactText(material.summary, 120);
      if (summary) process.stdout.write(`  摘要: ${summary}\n`);
    }
  }
  if (data.folderSources.length === 0) {
    process.stdout.write("文件夹源: 无\n");
  } else {
    process.stdout.write("文件夹源:\n");
    for (const source of data.folderSources) {
      process.stdout.write(`- ${source.id}  ${source.displayName}  ${source.provider}/${source.status}\n`);
    }
  }
}

function compactText(value: string, maxChars: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > maxChars ? `${singleLine.slice(0, maxChars)}...` : singleLine;
}

function help(): void {
  process.stdout.write(`AI agents MUST read: qa skills read writer —— 不要只凭 --help 猜用法

qa status
qa sessions list [--json]
qa sessions create
qa doc read -s <id> [--lines] [--json]
qa doc state -s <id>
qa doc propose -s <id> --expect-version N (--full draft.md | --str-replace <old> <new> | --append section.md | --ops ops.json)
qa doc events -s <id> [--follow] [--after <seq>] [--until reviewed|committed|review] [--timeout 10m]
qa chat send -s <id> "指令"
qa chat log -s <id> [--limit N] [--json]
qa chat tail -s <id>
qa files list -s <id> [--json]
qa files read -s <id> --material <id> [--max-bytes N] [--json]
qa skills read writer
qa skills install claude|codex
`);
}

if (isDirectRun()) {
  main().catch((error) => {
    const err = error instanceof QaCliError ? error : new QaCliError("VALIDATION", error instanceof Error ? error.message : String(error));
    process.stderr.write(`${err.code}: ${err.message}\n下一步: ${NEXT_STEP[err.code]}\n`);
    process.exitCode = 1;
  });
}

export function isDirectRun(argvPath = process.argv[1]): boolean {
  if (!argvPath) return false;
  try {
    return realpathSync.native(fileURLToPath(import.meta.url)) === realpathSync.native(argvPath);
  } catch {
    return fileURLToPath(import.meta.url) === path.resolve(argvPath);
  }
}
