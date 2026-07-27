import { countVisibleChars, normalizePmDoc, pmToLegacySections, type PmDoc, type PmNode } from "@qingagent/pm-schema";
import type { BridgeFrame, Command, LegacySection } from "@qingagent/contract-ts";
import {
  validateBridgeFrame,
  validateCommand,
} from "../../../system/validators";

function pmTextHasSubstantiveContent(text: string): boolean {
  const normalized = text.replace(/[\u200B\u200C\u200D\uFEFF]/gu, "");
  return countVisibleChars(normalized) > 0;
}

function pmNodeHasSubstantiveContent(node: PmNode): boolean {
  switch (node.type) {
    case "text":
      return pmTextHasSubstantiveContent(node.text);
    case "hardBreak":
      return false;
    case "inlineMath":
    case "blockMath":
      return pmTextHasSubstantiveContent(node.attrs.latex);
    case "image":
      return Boolean(node.attrs.src);
    case "diagram":
      return Boolean(node.attrs.source.trim() || node.attrs.svg);
    case "fileAttachment":
      return Boolean(node.attrs.fileId || node.attrs.filename.trim());
    case "horizontalRule":
      return true;
    default: {
      const content = "content" in node && Array.isArray(node.content) ? node.content : [];
      return content.some((child) => pmNodeHasSubstantiveContent(child as PmNode));
    }
  }
}

export function pmDocHasSubstantiveContent(pmDoc: PmDoc): boolean {
  return pmDoc.content.some((node) => pmNodeHasSubstantiveContent(node));
}

export function createClientMutationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `doc-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

type PageExitSendBeacon = (url: string, data?: BodyInit | null) => boolean;
type PageExitFetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};
type PageExitFetch = (
  url: string,
  init: RequestInit,
) => Promise<PageExitFetchResponse>;

export interface PageExitDocSaveBase {
  expectedDocumentSnapshot: number;
  baseContentHash: string;
}

export class PageExitDocSaveError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = "PageExitDocSaveError";
  }
}

function pageExitFetch(): PageExitFetch | undefined {
  return typeof fetch === "undefined"
    ? undefined
    : (requestUrl, init) => fetch(requestUrl, init);
}

function docWriteResultFromResponse(
  body: unknown,
  clientMutationId: string,
): Extract<BridgeFrame, { kind: "docWriteResult" }>["data"] | null {
  if (!Array.isArray(body)) return null;
  for (const value of body) {
    try {
      validateBridgeFrame(value);
    } catch {
      continue;
    }
    const frame = value as BridgeFrame;
    if (
      frame.kind === "docWriteResult" &&
      frame.data.clientMutationId === clientMutationId
    ) {
      return frame.data;
    }
  }
  return null;
}

async function submitBackgroundDocSave(input: {
  command: Extract<Command, { kind: "updateDoc" }>;
  fetchKeepalive: PageExitFetch;
  url: string;
}): Promise<Extract<BridgeFrame, { kind: "docWriteResult" }>["data"]> {
  let response: PageExitFetchResponse;
  try {
    response = await input.fetchKeepalive(input.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input.command),
      keepalive: true,
    });
  } catch (error) {
    throw new PageExitDocSaveError(
      `后台保存请求未送达：${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
  if (!response.ok) {
    throw new PageExitDocSaveError(
      `后台保存请求失败：HTTP ${response.status}`,
      response.status === 408 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500,
    );
  }
  const body = await response.json().catch(() => null);
  const result = docWriteResultFromResponse(
    body,
    input.command.data.clientMutationId,
  );
  if (!result) {
    throw new PageExitDocSaveError("后台保存未收到服务端确认", true);
  }
  return result;
}

async function fetchCurrentDocSaveBase(input: {
  sessionId: string;
  fetchRequest: PageExitFetch;
  historyUrl?: string;
}): Promise<PageExitDocSaveBase> {
  const url =
    input.historyUrl ??
    `/api/v1/history?sessionId=${encodeURIComponent(input.sessionId)}`;
  let response: PageExitFetchResponse;
  try {
    response = await input.fetchRequest(url, { method: "GET" });
  } catch (error) {
    throw new PageExitDocSaveError(
      `读取最新文档版本失败：${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
  if (!response.ok) {
    throw new PageExitDocSaveError(
      `读取最新文档版本失败：HTTP ${response.status}`,
      response.status === 408 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500,
    );
  }
  const body = await response.json().catch(() => null) as {
    entries?: unknown;
  } | null;
  const entries = Array.isArray(body?.entries) ? body.entries : [];
  const latest = entries
    .filter(
      (
        entry,
      ): entry is {
        docVersion: number;
        content_hash: string;
      } =>
        entry !== null &&
        typeof entry === "object" &&
        Number.isInteger((entry as { docVersion?: unknown }).docVersion) &&
        typeof (entry as { content_hash?: unknown }).content_hash === "string" &&
        (entry as { content_hash: string }).content_hash.length > 0,
    )
    .sort((left, right) => right.docVersion - left.docVersion)[0];
  if (!latest) {
    throw new PageExitDocSaveError("服务端没有可用的最新文档版本", true);
  }
  return {
    expectedDocumentSnapshot: latest.docVersion,
    baseContentHash: latest.content_hash,
  };
}

async function settlePendingDocSaveBase(input: {
  fallbackBase: PageExitDocSaveBase;
  pendingBase?: Promise<PageExitDocSaveBase>;
  maxWaitMs: number;
}): Promise<PageExitDocSaveBase> {
  if (!input.pendingBase) return input.fallbackBase;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      input.pendingBase.catch(() => input.fallbackBase),
      new Promise<PageExitDocSaveBase>((resolve) => {
        timer = setTimeout(() => resolve(input.fallbackBase), input.maxWaitMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export function shouldFlushDocSaveOnPageExit(input: {
  pmDoc: PmDoc | null;
  baselineDoc: PmDoc | null | undefined;
  hasPendingDocSave: boolean;
}): boolean {
  if (!input.pmDoc) return false;
  if (input.hasPendingDocSave) return true;
  if (!input.baselineDoc) return false;
  return JSON.stringify(input.pmDoc) !== JSON.stringify(input.baselineDoc);
}

export function pageExitDocSaveFingerprint(input: {
  sessionId: string;
  expectedDocumentSnapshot: number;
  baseContentHash: string;
  pmDoc: PmDoc;
}): string {
  return JSON.stringify({
    sessionId: input.sessionId,
    expectedDocumentSnapshot: input.expectedDocumentSnapshot,
    baseContentHash: input.baseContentHash,
    doc: input.pmDoc,
  });
}

export function buildPageExitDocSaveCommand(input: {
  sessionId: string | null;
  expectedDocumentSnapshot: number;
  baseContentHash: string;
  pmDoc: PmDoc | null;
  baselineDoc?: PmDoc | null;
  hasPendingDocSave: boolean;
  createMutationId?: () => string;
}): Extract<Command, { kind: "updateDoc" }> | null {
  if (!input.sessionId || !input.pmDoc) return null;
  const pmDoc = normalizePmDoc(input.pmDoc);
  // 惰性创建守卫(review #4):服务端还没有 doc(expected=0)且本地文档无实质内容(空白起稿没打字)时,
  // 关页/切页不落库——否则 beacon 会经空文档首写门 createIfMissing 落成"幽灵空文档",
  // 下次打开引导态消失、AI 误走"已有文档编辑"链路。与 handleEditorChange 的惰性口径一致。
  if (input.expectedDocumentSnapshot === 0 && !pmDocHasSubstantiveContent(pmDoc)) {
    return null;
  }
  if (!shouldFlushDocSaveOnPageExit({
    pmDoc,
    baselineDoc: input.baselineDoc ?? null,
    hasPendingDocSave: input.hasPendingDocSave,
  })) {
    return null;
  }
  const command: Extract<Command, { kind: "updateDoc" }> = {
    kind: "updateDoc",
    data: {
      sessionId: input.sessionId,
      expectedDocumentSnapshot: input.expectedDocumentSnapshot,
      baseContentHash: input.baseContentHash,
      doc: pmDoc,
      legacySections: pmToLegacySections(pmDoc) as unknown as LegacySection[],
      clientMutationId: (input.createMutationId ?? createClientMutationId)(),
    },
  };
  validateCommand(command);
  return command;
}

/**
 * 会话切换后的后台保存只走可读取响应的 keepalive fetch：
 * 先等旧写入结算（最多 10 秒），再按其新基底提交最新正文；
 * 若仍撞 CAS，只读取一次服务端最新版本并重试一次。
 */
export async function flushDocSaveInBackground(input: {
  sessionId: string;
  fallbackBase: PageExitDocSaveBase;
  pendingBase?: Promise<PageExitDocSaveBase>;
  maxPendingWaitMs?: number;
  pmDoc: PmDoc;
  baselineDoc?: PmDoc | null;
  hasPendingDocSave: boolean;
  createMutationId?: () => string;
  fetchKeepalive?: PageExitFetch;
  fetchCurrentBase?: () => Promise<PageExitDocSaveBase>;
  url?: string;
}): Promise<"skipped" | "saved"> {
  const fetchKeepalive = input.fetchKeepalive ?? pageExitFetch();
  if (!fetchKeepalive) {
    throw new PageExitDocSaveError("当前环境不支持后台保存", true);
  }
  const base = await settlePendingDocSaveBase({
    fallbackBase: input.fallbackBase,
    pendingBase: input.pendingBase,
    maxWaitMs: input.maxPendingWaitMs ?? 10_000,
  });
  const buildCommand = (nextBase: PageExitDocSaveBase) =>
    buildPageExitDocSaveCommand({
      sessionId: input.sessionId,
      expectedDocumentSnapshot: nextBase.expectedDocumentSnapshot,
      baseContentHash: nextBase.baseContentHash,
      pmDoc: input.pmDoc,
      baselineDoc: input.baselineDoc,
      hasPendingDocSave: input.hasPendingDocSave,
      createMutationId: input.createMutationId,
    });
  const command = buildCommand(base);
  if (!command) return "skipped";

  const first = await submitBackgroundDocSave({
    command,
    fetchKeepalive,
    url: input.url ?? "/api/v1/stream",
  });
  if (first.ok) return "saved";
  if (!("conflict" in first)) {
    throw new PageExitDocSaveError(
      "服务端拒绝了后台保存",
      first.reason === "agent_busy",
    );
  }

  const latestBase = await (
    input.fetchCurrentBase?.() ??
    fetchCurrentDocSaveBase({
      sessionId: input.sessionId,
      fetchRequest: fetchKeepalive,
    })
  );
  const retryCommand = buildCommand(latestBase);
  if (!retryCommand) return "skipped";
  const retried = await submitBackgroundDocSave({
    command: retryCommand,
    fetchKeepalive,
    url: input.url ?? "/api/v1/stream",
  });
  if (retried.ok) return "saved";
  throw new PageExitDocSaveError(
    "按服务端最新版本重试后仍未保存成功",
    "conflict" in retried ||
      ("reason" in retried && retried.reason === "agent_busy"),
  );
}

export function flushDocSaveOnPageExit(input: {
  sessionId: string | null;
  expectedDocumentSnapshot: number;
  baseContentHash: string;
  pmDoc: PmDoc | null;
  baselineDoc?: PmDoc | null;
  hasPendingDocSave: boolean;
  createMutationId?: () => string;
  sendBeacon?: PageExitSendBeacon;
  fetchKeepalive?: PageExitFetch;
  url?: string;
}): "skipped" | "beacon" | "keepalive" {
  const command = buildPageExitDocSaveCommand(input);
  if (!command) return "skipped";

  const url = input.url ?? "/api/v1/stream";
  const body = JSON.stringify(command);
  const beaconBody: BodyInit =
    typeof Blob !== "undefined"
      ? new Blob([body], { type: "application/json" })
      : body;
  const sendBeacon =
    input.sendBeacon ??
    (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function"
      ? navigator.sendBeacon.bind(navigator)
      : undefined);
  if (sendBeacon?.(url, beaconBody)) return "beacon";

  const fetchKeepalive: PageExitFetch | undefined =
    input.fetchKeepalive ??
    pageExitFetch();
  if (!fetchKeepalive) return "skipped";
  void fetchKeepalive(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => undefined);
  return "keepalive";
}
