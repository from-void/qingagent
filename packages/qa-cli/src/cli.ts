#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApiClient } from "./apiClient.js";
import { discoverInstance } from "./discovery.js";
import { formatQaCliError, QaCliError } from "./errors.js";
import { hasFlag, optionValue, optionValues, printJson } from "./output.js";
import { installPointerSkill, writerSkillMarkdown, type SkillInstallTarget } from "./skill.js";
import {
  validateSkillDirectory,
  validateSkillMarkdownFile,
} from "./skillFiles.js";
import { readTemplateMarkdown, writeTemplateMarkdown } from "./templateFile.js";
import type {
  ExternalAnnotationResponse,
  ExternalChatLogResponse,
  ExternalDocReadResponse,
  ExternalEventsMeta,
  ExternalFilesListResponse,
  ExternalFileTextResponse,
  ExternalProposalResponse,
  ExternalProposeOp,
  ExternalReviewListResponse,
  ExternalReviewPatchResponse,
  ExternalReviewRunResponse,
  ExternalReviewTemplateResponse,
  ExternalReviewTemplatesResponse,
  ExternalSessionCreateResponse,
  ExternalSessionsListResponse,
  ExternalSkillMutationResponse,
  ExternalSkillResponse,
  ExternalSkillsResponse,
} from "./generated/externalApi.js";

interface EventOptions {
  follow: boolean;
  after: string;
  timeoutMs: number | null;
  until: EventTarget | null;
  completion?: (data: string) => string | null;
}

type EventTarget = "reviewed" | "committed" | "review";

const DOC_PROPOSE_OPTION_NAMES = new Set([
  "-s",
  "--expect-version",
  "--ops",
  "--full",
  "--append",
  "--str-replace",
  "--json",
]);

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
    if (target === "claude" || target === "codex") {
      const filePath = await installPointerSkill(target as SkillInstallTarget);
      return output({ installed: true, path: filePath }, hasFlag(args, "--json"));
    }
  }
  if (group === "skills" && command === "validate") {
    const directory = requireArgument(args, 2, "缺少技能目录");
    const validated = await validateSkillDirectory(directory);
    return output(
      { valid: true, name: validated.name, files: validated.files.map((file) => file.path) },
      hasFlag(args, "--json"),
    );
  }
  const client = await ApiClient.create();
  if (group === "template" && command === "list") {
    const type = optionValue(args, "--type");
    const query = type ? `?type=${encodeURIComponent(type)}` : "";
    const data = await client.request<ExternalReviewTemplatesResponse>(
      `/review-templates${query}`,
    );
    if (hasFlag(args, "--json")) return printJson(data);
    for (const template of data.templates) {
      process.stdout.write(
        `${template.selected ? "*" : " "} ${template.id}  [${template.type}] ${template.name}${template.builtin ? " (内置)" : ""}\n`,
      );
    }
    return;
  }
  if (group === "template" && command === "show") {
    const id = requireArgument(args, 2, "缺少模板 id");
    const data = await client.request<ExternalReviewTemplateResponse>(
      `/review-templates/${encodeURIComponent(id)}`,
    );
    return output(data, hasFlag(args, "--json"));
  }
  if (group === "template" && command === "pull") {
    const id = requireArgument(args, 2, "缺少模板 id");
    const filePath = requireOption(args, "--out");
    const data = await client.request<ExternalReviewTemplateResponse>(
      `/review-templates/${encodeURIComponent(id)}`,
    );
    await writeTemplateMarkdown(filePath, data.template);
    return output({ pulled: true, id, path: filePath }, hasFlag(args, "--json"));
  }
  if (group === "template" && command === "push") {
    const filePath = requireArgument(args, 2, "缺少模板 Markdown 文件");
    const source = await readTemplateMarkdown(filePath);
    const data = source.id
      ? await client.request<ExternalReviewTemplateResponse>(
          `/review-templates/${encodeURIComponent(source.id)}`,
          {
            method: "PUT",
            body: JSON.stringify({
              name: source.name,
              prompt: source.prompt,
              expectedUpdatedAt: source.updatedAt,
            }),
          },
        )
      : await client.request<ExternalReviewTemplateResponse>("/review-templates", {
          method: "POST",
          body: JSON.stringify({
            type: source.type,
            name: source.name,
            prompt: source.prompt,
          }),
        });
    await writeTemplateMarkdown(filePath, data.template);
    return output(data, hasFlag(args, "--json"));
  }
  if (group === "template" && command === "create") {
    const type = requireOption(args, "--type");
    const name = requireOption(args, "--name");
    const filePath = requireOption(args, "--file");
    const prompt = await readFile(filePath, "utf8");
    const data = await client.request<ExternalReviewTemplateResponse>(
      "/review-templates",
      { method: "POST", body: JSON.stringify({ type, name, prompt }) },
    );
    return output(data, hasFlag(args, "--json"));
  }
  if (group === "template" && command === "select") {
    const id = requireArgument(args, 2, "缺少模板 id");
    const data = await client.request(
      `/review-templates/${encodeURIComponent(id)}/select`,
      { method: "POST", body: JSON.stringify({}) },
    );
    return output(data, hasFlag(args, "--json"));
  }
  if (group === "template" && command === "rm") {
    const id = requireArgument(args, 2, "缺少模板 id");
    const data = await client.request(
      `/review-templates/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    return output(data, hasFlag(args, "--json"));
  }
  if (group === "skills" && command === "list") {
    const data = await client.request<ExternalSkillsResponse>("/skills");
    if (hasFlag(args, "--json")) return printJson(data);
    printSkills(data.skills);
    return;
  }
  if (group === "skills" && command === "show") {
    const name = requireArgument(args, 2, "缺少技能名称");
    const data = await client.request<ExternalSkillResponse>(
      `/skills/${encodeURIComponent(name)}`,
    );
    if (hasFlag(args, "--json")) return printJson(data);
    process.stdout.write(`${data.skill.name} [${data.skill.source}] ${data.skill.enabled ? "enabled" : "disabled"}\n`);
    process.stdout.write(`${data.skill.description}\n\n${data.skill.body ?? ""}`);
    if (data.skill.body && !data.skill.body.endsWith("\n")) process.stdout.write("\n");
    return;
  }
  if (group === "skills" && command === "install") {
    const target = requireArgument(args, 2, "缺少技能目录或 Markdown 文件");
    const payload = await localSkillPayload(target);
    const data = await client.request<ExternalSkillMutationResponse>("/skills", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return output(data, hasFlag(args, "--json"));
  }
  if (group === "skills" && command === "update") {
    const name = requireArgument(args, 2, "缺少技能名称");
    const directory = requireArgument(args, 3, "缺少技能目录");
    const validated = await validateSkillDirectory(directory);
    if (validated.name !== name) {
      throw new QaCliError("VALIDATION", "技能目录中的 name 与命令参数不一致");
    }
    const data = await client.request<ExternalSkillMutationResponse>(
      `/skills/${encodeURIComponent(name)}`,
      { method: "PUT", body: JSON.stringify({ files: validated.files }) },
    );
    return output(data, hasFlag(args, "--json"));
  }
  if (group === "skills" && command === "rm") {
    const name = requireArgument(args, 2, "缺少技能名称");
    const data = await client.request<ExternalSkillMutationResponse>(
      `/skills/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    );
    return output(data, hasFlag(args, "--json"));
  }
  if (group === "skills" && (command === "enable" || command === "disable")) {
    const name = requireArgument(args, 2, "缺少技能名称");
    const data = await client.request<ExternalSkillMutationResponse>(
      `/skills/${encodeURIComponent(name)}/${command}`,
      { method: "POST", body: JSON.stringify({}) },
    );
    return output(data, hasFlag(args, "--json"));
  }
  if (group === "sessions" && command === "list") {
    const json = hasFlag(args, "--json");
    const all = hasFlag(args, "--all");
    const rawLimit = optionValue(args, "--limit");
    const limit = parseSessionsLimit(rawLimit);
    const data = all
      ? await listAllSessions(client, limit)
      : await client.request<ExternalSessionsListResponse>(
          `/sessions${rawLimit === undefined ? "" : `?limit=${limit}`}`,
        );
    output(data, json);
    if (!json && !all && data.hasMore) {
      process.stdout.write(`还有 ${Math.max(0, data.total - data.sessions.length)} 个会话,用 --all 查看\n`);
    }
    return;
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
    const until = parseEventTarget(args);
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
  if (group === "review" && command === "list") {
    const sessionId = requireOption(args, "-s");
    const data = await client.request<ExternalReviewListResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/review`,
    );
    if (hasFlag(args, "--json")) return printJson(data);
    printReviewList(data);
    return;
  }
  if (group === "review" && command === "run") {
    const sessionId = requireOption(args, "-s");
    const type = requireOption(args, "--type");
    const templateId = optionValue(args, "--template");
    const supplement = optionValue(args, "--supplement");
    const data = await client.request<ExternalReviewRunResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/review/run`,
      {
        method: "POST",
        body: JSON.stringify({
          type,
          ...(templateId ? { templateId } : {}),
          ...(supplement !== undefined ? { supplement } : {}),
        }),
      },
    );
    output(data, hasFlag(args, "--json"));
    if (hasFlag(args, "--wait")) {
      const completion = createReviewRunCompletion();
      await events(client, sessionId, {
        follow: true,
        after: String(data.afterSeq),
        timeoutMs: null,
        until: null,
        completion: completion.hit,
      });
      await ensureReviewRunVisible(client, sessionId, completion.annotationIds);
    }
    return;
  }
  if (group === "review" && command === "show") {
    const sessionId = requireOption(args, "-s");
    const patchId = optionValue(args, "--patch");
    const annotationId = optionValue(args, "--annotation");
    requireExactlyOneReviewTarget(patchId, annotationId);
    if (patchId) {
      const data = await client.request<ExternalReviewPatchResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/review/patches/${encodeURIComponent(patchId)}`,
      );
      if (hasFlag(args, "--json")) return printJson(data);
      printReviewPatch(data);
      return;
    }
    const data = await client.request<ExternalAnnotationResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/review/annotations/${encodeURIComponent(annotationId!)}`,
    );
    if (hasFlag(args, "--json")) return printJson(data);
    printAnnotation(data);
    return;
  }
  if (
    group === "review" &&
    (command === "accept" || command === "reject")
  ) {
    const sessionId = requireOption(args, "-s");
    const expectedDocVersion = requireDocumentVersion(args);
    const patchId = optionValue(args, "--patch");
    const all = hasFlag(args, "--all");
    if ((patchId ? 1 : 0) + (all ? 1 : 0) !== 1) {
      throw new QaCliError("VALIDATION", "review accept/reject 必须且只能指定 --patch <id> 或 --all");
    }
    const data = all
      ? await client.reviewCommit(sessionId, {
          expectedDocVersion,
          action: command === "accept" ? "accept_all" : "reject_all",
        })
      : await client.reviewVerdict(sessionId, {
          expectedDocVersion,
          patchId: patchId!,
          verdict: command === "accept" ? "accepted" : "rejected",
        });
    return output(data, hasFlag(args, "--json"));
  }
  if (group === "review" && command === "commit") {
    const sessionId = requireOption(args, "-s");
    const expectedDocVersion = requireDocumentVersion(args);
    const data = await client.reviewCommit(sessionId, {
      expectedDocVersion,
      action: "commit",
    });
    return output(data, hasFlag(args, "--json"));
  }
  if (
    group === "review" &&
    command === "annotation" &&
    args[2] === "ignore"
  ) {
    const sessionId = requireOption(args, "-s");
    const expectedDocVersion = requireDocumentVersion(args);
    const annotationId = requireOption(args, "--annotation");
    const data = await client.ignoreAnnotations(sessionId, {
      expectedDocVersion,
      annotationIds: [annotationId],
      ...(hasFlag(args, "--remember") ? { rememberDismissal: true } : {}),
    });
    return output(data, hasFlag(args, "--json"));
  }
  if (group === "chat" && command === "send") {
    const sessionId = requireOption(args, "-s");
    const text = chatText(args);
    const data = await client.chat(sessionId, { text });
    return output(data, hasFlag(args, "--json"));
  }
  if (group === "chat" && command === "log") {
    const sessionId = requireOption(args, "-s");
    const rawLimit = optionValue(args, "--limit");
    const limit = parsePositiveLimit(rawLimit);
    const query = limit === undefined ? "" : `?limit=${limit}`;
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
  for (const [oldText, newText] of optionValues(args, "--str-replace", 2, {
    knownOptionNames: DOC_PROPOSE_OPTION_NAMES,
    missingMessage: "--str-replace 需要旧文和新文",
  })) {
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
  let received = 0;
  let reason: string | null = null;
  let maxSeq = parseAfterSeq(options.after);
  let cursor = options.after;
  let reconnectAttempt = 0;
  let printWatchingOnNextConnection = true;
  let gapResubscribed = false;
  let epoch: number | null = null;
  try {
    while (!reason && !timedOut) {
      const receivedBeforeConnection = received;
      let reader: ReadableStreamDefaultReader<string> | null = null;
      let meta: ExternalEventsMeta | null = null;
      let buffer = "";
      let resumeAfter: string | null = null;
      try {
        const res = await client.openEvents(sessionId, cursor, controller.signal);
        if (printWatchingOnNextConnection) {
          process.stderr.write(`[qa] watching session=${sessionId} after=${cursor}\n`);
          printWatchingOnNextConnection = false;
        }
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
              if (meta && epoch !== null && meta.epoch !== epoch) {
                epoch = meta.epoch;
                gapResubscribed = false;
                const resumeSeq = Math.max(1, Math.floor(meta.minSeq));
                resumeAfter = String(resumeSeq - 1);
                process.stderr.write(`[qa] log rebuilt, resuming from seq=${resumeSeq}\n`);
                printWatchingOnNextConnection = true;
                break;
              }
              if (meta) epoch = meta.epoch;
              if (meta?.gap) {
                if (received === 0 && !gapResubscribed) {
                  gapResubscribed = true;
                  const resumeSeq = Math.max(1, Math.floor(meta.minSeq));
                  resumeAfter = String(resumeSeq - 1);
                  process.stderr.write(`[qa] log truncated, resuming from seq=${resumeSeq}\n`);
                  printWatchingOnNextConnection = true;
                } else {
                  reason = "gap";
                }
                break;
              }
              if (cursor === "tip" && meta) {
                maxSeq = Math.max(maxSeq, meta.nextSeq - 1);
                cursor = String(maxSeq);
              }
              continue;
            }
            process.stdout.write(`${data}\n`);
            received += 1;
            maxSeq = Math.max(maxSeq, frameSeq(data));
            cursor = String(maxSeq);
            const hit = options.completion?.(data) ?? untilHit(options.until, data);
            if (hit) {
              reason = hit;
              break;
            }
          }
          if (reason || resumeAfter !== null) break;
          if (!options.follow && !options.until && options.timeoutMs === null && meta && maxSeq >= meta.nextSeq - 1) {
            reason = "limit";
            break;
          }
        }
        if (resumeAfter !== null) {
          cursor = resumeAfter;
          maxSeq = parseAfterSeq(cursor);
          continue;
        }
        if (!options.follow && options.until && !reason && !timedOut) {
          reason = "eof";
        }
        if (!options.follow || reason || timedOut) break;
      } catch (error) {
        if (timedOut || controller.signal.aborted) break;
        if (error instanceof QaCliError && (!options.follow || error.code !== "NO_INSTANCE")) throw error;
        if (!options.follow) throw error;
      } finally {
        await reader?.cancel().catch(() => undefined);
      }
      if (!options.follow || reason || timedOut) break;
      reconnectAttempt += 1;
      await abortableReconnectDelay(
        Math.min(2_000, 100 * 2 ** Math.min(reconnectAttempt - 1, 5)),
        controller.signal,
      ).catch(() => undefined);
      if (controller.signal.aborted) break;
      // 只要成功收到过帧，下一次 EOF 重新从短退避开始；游标保证不重不漏。
      if (received > receivedBeforeConnection) reconnectAttempt = 0;
    }
  } catch (error) {
    if (!timedOut) throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (timedOut && !reason) reason = "timeout";
  if (reason) process.stderr.write(`[qa] events exited reason=${reason} received=${received}\n`);
  if (reason === "eof") {
    throw new QaCliError(
      "EVENT_TARGET_NOT_REACHED",
      `事件流提前结束，目标 ${options.until} 尚未到达`,
    );
  }
}

function abortableReconnectDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
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

function requireArgument(args: string[], index: number, message: string): string {
  const value = args[index];
  if (!value || value.startsWith("-")) throw new QaCliError("VALIDATION", message);
  return value;
}

async function localSkillPayload(
  target: string,
): Promise<{ skillMd: string } | { files: Array<{ path: string; content: string }> }> {
  const info = await lstat(target).catch(() => null);
  if (info?.isDirectory()) {
    return { files: (await validateSkillDirectory(target)).files };
  }
  if (info?.isFile()) {
    return { skillMd: (await validateSkillMarkdownFile(target)).skillMd };
  }
  throw new QaCliError("VALIDATION", "技能路径不存在");
}

function parseSessionsLimit(raw: string | undefined): number {
  if (raw === undefined) return 100;
  const limit = Number(raw);
  if (!Number.isFinite(limit)) throw new QaCliError("VALIDATION", "--limit 必须是数字");
  return Math.min(500, Math.max(1, Math.floor(limit)));
}

function parsePositiveLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new QaCliError("VALIDATION", "--limit 必须是正整数");
  }
  return limit;
}

async function listAllSessions(
  client: ApiClient,
  limit: number,
): Promise<ExternalSessionsListResponse> {
  const sessions: ExternalSessionsListResponse["sessions"] = [];
  let cursor: string | null = "start";
  let total = 0;
  while (cursor) {
    const page: ExternalSessionsListResponse = await client.request<ExternalSessionsListResponse>(
      `/sessions?limit=${limit}&cursor=${encodeURIComponent(cursor)}`,
    );
    sessions.push(...page.sessions);
    total = page.total;
    if (!page.hasMore) break;
    if (!page.nextCursor) {
      throw new QaCliError(
        "SERVICE_UNAVAILABLE",
        "青简会话分页响应不完整",
      );
    }
    cursor = page.nextCursor;
  }
  return { sessions, total, hasMore: false };
}

function requireDocumentVersion(args: string[]): number {
  const raw = requireOption(args, "--expect-version");
  const version = Number(raw);
  if (!Number.isInteger(version) || version < 0) {
    throw new QaCliError("VALIDATION", "--expect-version 必须是非负整数");
  }
  return version;
}

function requireExactlyOneReviewTarget(
  patchId: string | undefined,
  annotationId: string | undefined,
): void {
  if ((patchId ? 1 : 0) + (annotationId ? 1 : 0) !== 1) {
    throw new QaCliError(
      "VALIDATION",
      "review show 必须且只能指定 --patch <id> 或 --annotation <id>",
    );
  }
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

function parseEventTarget(args: string[]): EventTarget | null {
  if (!hasFlag(args, "--until")) return null;
  const value = optionValue(args, "--until");
  if (value === "reviewed" || value === "committed" || value === "review") {
    return value;
  }
  throw new QaCliError(
    "VALIDATION",
    "--until 必须是 reviewed、committed 或 review",
  );
}

function untilHit(until: EventTarget | null, data: string): string | null {
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

function createReviewRunCompletion(): {
  hit: (data: string) => string | null;
  annotationIds: Set<string>;
} {
  let sawRunStart = false;
  const annotationIds = new Set<string>();
  return {
    annotationIds,
    hit(data) {
      const frame = parseEventFrame(data);
      if (!frame) return null;
      if (frame.kind === "stream") {
        const streamKind = nestedString(frame.data, "kind");
        if (streamKind === "start") {
          sawRunStart = true;
          return null;
        }
        if (streamKind === "end" && sawRunStart) return "review-run-complete";
      }
      if (frame.kind === "docStateChanged") {
        const agentBusy = nestedBoolean(frame.data, "agentBusy");
        if (agentBusy === true) {
          sawRunStart = true;
          return null;
        }
        const stateKind = docStateKind(frame.data);
        if (
          sawRunStart &&
          agentBusy === false &&
          stateKind !== undefined &&
          stateKind !== "editing"
        ) {
          return "review-run-complete";
        }
      }
      if (frame.kind === "annotationGroupsReady" && sawRunStart) {
        for (const id of annotationGroupIds(frame.data)) annotationIds.add(id);
        if (annotationIds.size > 0) return "review-run-complete";
      }
      return null;
    },
  };
}

async function ensureReviewRunVisible(
  client: ApiClient,
  sessionId: string,
  expectedAnnotationIds: ReadonlySet<string>,
): Promise<void> {
  const attempts = expectedAnnotationIds.size > 0 ? 10 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const review = await client.request<ExternalReviewListResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/review`,
    );
    const visible = new Set(review.annotations.map((annotation) => annotation.id));
    if ([...expectedAnnotationIds].every((id) => visible.has(id))) return;
    if (attempt + 1 < attempts) await abortableReconnectDelay(50, new AbortController().signal);
  }
  throw new QaCliError("VALIDATION", "审查回合已结束，但本轮批注尚未进入审查列表");
}

function parseEventFrame(data: string): { kind?: string; data?: unknown } | null {
  try {
    return JSON.parse(data) as { kind?: string; data?: unknown };
  } catch {
    return null;
  }
}

function nestedString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === "string" ? nested : undefined;
}

function nestedBoolean(value: unknown, key: string): boolean | undefined {
  if (!value || typeof value !== "object") return undefined;
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === "boolean" ? nested : undefined;
}

function annotationGroupIds(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const groups = (data as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group) => {
    if (!group || typeof group !== "object") return [];
    const id = (group as { id?: unknown }).id;
    return typeof id === "string" && id ? [id] : [];
  });
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

function printReviewList(data: ExternalReviewListResponse): void {
  process.stdout.write(
    `审查 session=${data.sessionId} v${data.docVersion} state=${data.state}${data.agentBusy ? " busy" : ""}\n`,
  );
  process.stdout.write(`修改建议 (${data.patches.length}):\n`);
  if (data.patches.length === 0) {
    process.stdout.write("- 无\n");
  } else {
    for (const patch of data.patches) {
      process.stdout.write(
        `- ${patch.id}  [${patch.status}] ${compactText(patch.summary, 80)}\n`,
      );
      process.stdout.write(
        `  ${compactText(patch.beforeText, 80) || "（空）"} → ${compactText(patch.afterText, 80) || "（空）"}\n`,
      );
      if (patch.conflict) {
        process.stdout.write(
          `  冲突: ${patch.conflict.kind} ${compactText(patch.conflict.message, 120)}\n`,
        );
      }
    }
  }
  process.stdout.write(`批注 (${data.annotations.length}):\n`);
  if (data.annotations.length === 0) {
    process.stdout.write("- 无\n");
  } else {
    for (const annotation of data.annotations) {
      process.stdout.write(
        `- ${annotation.id}  [${annotation.severity ?? "warn"}/${annotation.status}] ${compactText(annotation.summary, 80)}\n`,
      );
    }
  }
}

function printReviewPatch(data: ExternalReviewPatchResponse): void {
  const patch = data.patch;
  process.stdout.write(
    `修改建议 ${patch.id} [${patch.status}] batch=${patch.reviewBatchId}\n`,
  );
  process.stdout.write(`摘要: ${patch.summary}\n`);
  process.stdout.write(`定位: ${patch.anchor.quote || "（无引用）"}\n`);
  process.stdout.write(`原文:\n${patch.beforeText || "（空）"}\n`);
  process.stdout.write(`改为:\n${patch.afterText || "（空）"}\n`);
  if (patch.diff) {
    process.stdout.write(
      `diff: ${patch.diff.op} blockPath=${patch.diff.blockPath.join(".") || "-"}\n`,
    );
  }
  if (patch.conflict) {
    process.stdout.write(`冲突: ${patch.conflict.kind} ${patch.conflict.message}\n`);
  }
}

function printAnnotation(data: ExternalAnnotationResponse): void {
  const annotation = data.annotation;
  process.stdout.write(
    `批注 ${annotation.id} [${annotation.severity ?? "warn"}/${annotation.status}] origin=${annotation.origin}\n`,
  );
  process.stdout.write(`问题: ${annotation.summary}\n`);
  process.stdout.write(`说明: ${annotation.note}\n`);
  if (annotation.suggestion) process.stdout.write(`建议: ${annotation.suggestion}\n`);
  for (const [index, anchor] of annotation.anchors.entries()) {
    process.stdout.write(`定位 ${index + 1}: ${anchor.quote}\n`);
  }
}

function printSkills(skills: ExternalSkillsResponse["skills"], indent = ""): void {
  for (const skill of skills) {
    process.stdout.write(
      `${indent}${skill.enabled ? "*" : " "} ${skill.name}  [${skill.source}] ${skill.description}\n`,
    );
    printSkills(skill.children, `${indent}  `);
  }
}

function compactText(value: string, maxChars: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > maxChars ? `${singleLine.slice(0, maxChars)}...` : singleLine;
}

function help(): void {
  process.stdout.write(`AI agents MUST read: qa skills read writer —— 不要只凭 --help 猜用法

qa status
qa sessions list [--limit N] [--all] [--json]
qa sessions create
qa doc read -s <id> [--lines] [--json]
qa doc state -s <id>
qa doc propose -s <id> --expect-version N (--full draft.md | --str-replace <old> <new> | --append section.md | --ops ops.json)
qa doc events -s <id> [--follow] [--after <seq>] [--until reviewed|committed|review] [--timeout 10m]
qa review list -s <id> [--json]
qa review run -s <id> --type <t> [--template <id>] [--supplement <text>] [--wait] [--json]
qa review show -s <id> (--patch <id> | --annotation <id>) [--json]
qa review accept -s <id> --expect-version N (--patch <id> | --all) [--json]
qa review reject -s <id> --expect-version N (--patch <id> | --all) [--json]
qa review commit -s <id> --expect-version N [--json]
qa review annotation ignore -s <id> --expect-version N --annotation <id> [--remember] [--json]
qa chat send -s <id> "指令"
qa chat log -s <id> [--limit N] [--json]
qa chat tail -s <id>
qa files list -s <id> [--json]
qa files read -s <id> --material <id> [--max-bytes N] [--json]
qa skills read writer
qa skills install claude|codex
qa template list [--type <t>] [--json]
qa template show <id> [--json]
qa template pull <id> --out <file.md>
qa template push <file.md> [--json]
qa template create --type <t> --name <n> --file <prompt.md> [--json]
qa template select <id> [--json]
qa template rm <id> [--json]
qa skills list [--json]
qa skills show <name> [--json]
qa skills validate <dir> [--json]
qa skills install <dir|file.md> [--json]
qa skills update <name> <dir> [--json]
qa skills rm <name> [--json]
qa skills enable <name> [--json]
qa skills disable <name> [--json]
`);
}

if (isDirectRun()) {
  main().catch((error) => {
    const err = error instanceof QaCliError ? error : new QaCliError("VALIDATION", error instanceof Error ? error.message : String(error));
    process.stderr.write(formatQaCliError(process.argv.slice(2), err));
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
