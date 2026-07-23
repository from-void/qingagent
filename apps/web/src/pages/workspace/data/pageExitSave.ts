import { countVisibleChars, normalizePmDoc, pmToLegacySections, type PmDoc, type PmNode } from "@qingagent/pm-schema";
import type { Command, LegacySection } from "@qingagent/contract-ts";
import { validateCommand } from "../../../system/validators";

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
type PageExitFetch = (url: string, init: RequestInit) => Promise<unknown>;

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
    (typeof fetch !== "undefined"
      ? (requestUrl, init) => fetch(requestUrl, init)
      : undefined);
  if (!fetchKeepalive) return "skipped";
  void fetchKeepalive(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => undefined);
  return "keepalive";
}
