#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { ApiClient } from "./apiClient.js";
import { discoverInstance } from "./discovery.js";
import { NEXT_STEP, QaCliError } from "./errors.js";
import { hasFlag, optionValue, optionValues, printJson } from "./output.js";
import { installPointerSkill, writerSkillMarkdown, type SkillInstallTarget } from "./skill.js";

type ExternalProposeOp =
  | { kind: "fullDraft"; markdown: string }
  | { kind: "strReplace"; old: string; new: string; nth?: number }
  | { kind: "appendSection"; markdown: string }
  | { kind: "insertAfterLine"; line: number; markdown: string };

async function main(): Promise<void> {
  const args = process.argv.slice(2);
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
    const data = await client.request<unknown>("/sessions");
    return output(data, hasFlag(args, "--json"));
  }
  if (group === "sessions" && command === "create") {
    const title = optionValue(args, "--title");
    const data = await client.request<unknown>("/sessions", { method: "POST", body: JSON.stringify({ title }) });
    return output(data, hasFlag(args, "--json"));
  }
  if (group === "doc" && command === "read") {
    const sessionId = requireOption(args, "-s");
    const lines = hasFlag(args, "--lines") ? "?lines=1" : "";
    const data = await client.request<{ markdown?: string; markdownWithLineNumbers?: string }>(`/sessions/${encodeURIComponent(sessionId)}/doc${lines}`);
    if (hasFlag(args, "--json")) return printJson(data);
    process.stdout.write(`${data.markdownWithLineNumbers ?? data.markdown ?? ""}\n`);
    return;
  }
  if (group === "doc" && command === "state") {
    const sessionId = requireOption(args, "-s");
    const data = await client.request<unknown>(`/sessions/${encodeURIComponent(sessionId)}/doc`);
    return output(data, hasFlag(args, "--json"));
  }
  if (group === "doc" && command === "propose") {
    const sessionId = requireOption(args, "-s");
    const expectedDocVersion = Number(requireOption(args, "--expect-version"));
    const ops = await parseOps(args);
    const data = await client.request<unknown>(`/sessions/${encodeURIComponent(sessionId)}/proposals`, {
      method: "POST",
      body: JSON.stringify({ expectedDocVersion, ops }),
    });
    return output(data, hasFlag(args, "--json"));
  }
  if (group === "doc" && command === "events") {
    const sessionId = requireOption(args, "-s");
    return events(client, sessionId, hasFlag(args, "--follow"));
  }
  if (group === "chat" && command === "send") {
    const sessionId = requireOption(args, "-s");
    const text = chatText(args);
    const data = await client.request<unknown>(`/sessions/${encodeURIComponent(sessionId)}/chat`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    return output(data, hasFlag(args, "--json"));
  }
  if (group === "chat" && command === "tail") {
    const sessionId = requireOption(args, "-s");
    return events(client, sessionId, true);
  }
  throw new QaCliError("VALIDATION", "未知命令");
}

async function status(json: boolean): Promise<void> {
  const info = await discoverInstance();
  const data = { ok: true, version: info.version, pid: info.pid, startedAt: info.startedAt };
  if (json) printJson(data);
  else process.stdout.write(`清简正在运行 version=${info.version} pid=${info.pid}\n`);
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

async function events(client: ApiClient, sessionId: string, follow: boolean): Promise<void> {
  const res = await fetch(client.eventsUrl(sessionId), { headers: { Authorization: client.authHeader() } });
  if (!res.ok || !res.body) throw new QaCliError("VALIDATION", "events 连接失败");
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const line = chunk.split(/\r?\n/).find((part) => part.startsWith("data: "));
      if (!line) continue;
      const data = line.slice(6);
      if (data === "{}") continue;
      process.stdout.write(`${data}\n`);
    }
    if (!follow) break;
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

function help(): void {
  process.stdout.write(`AI agents MUST read: qa skills read writer —— 不要只凭 --help 猜用法

qa status
qa sessions list [--json]
qa sessions create --title "..."
qa doc read -s <id> [--lines] [--json]
qa doc state -s <id>
qa doc propose -s <id> --expect-version N (--full draft.md | --str-replace <old> <new> | --append section.md | --ops ops.json)
qa doc events -s <id> [--follow]
qa chat send -s <id> "指令"
qa chat tail -s <id>
qa skills read writer
qa skills install claude|codex
`);
}

main().catch((error) => {
  const err = error instanceof QaCliError ? error : new QaCliError("VALIDATION", error instanceof Error ? error.message : String(error));
  process.stderr.write(`${err.code}: ${err.message}\n下一步: ${NEXT_STEP[err.code]}\n`);
  process.exitCode = 1;
});
