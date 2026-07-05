import type { Command, ToolCallSpec, ViewDocumentSnapshot } from "./protocol";
import type { DocDimensions } from "./docDimensions";

/** 一个生成草稿是否真有内容(sections 非空)。generation_started 刚建出的占位草稿 sections=[]。 */
export function generationDraftHasContent(
  draft: ViewDocumentSnapshot | null,
): boolean {
  return !!draft && draft.sections.length > 0;
}

/**
 * 右侧正文该渲染哪份文档(单一真相源)。关键不变量:
 * - askUser 浮层(中途反问)期间 agent 已挂起,generationDraft 多半是【空占位草稿】,
 *   绝不能盖掉已落库的 canonical doc(否则右侧渲染成空白 = "文档消失")。
 * - 空草稿(sections=[])一律不优先;只有草稿真有内容、且不在 askUser 浮层、且非审阅时才优先草稿。
 */
export function selectRenderDoc(input: {
  viewingHistory: boolean;
  viewingSnapshotDoc: ViewDocumentSnapshot | null;
  doc: ViewDocumentSnapshot | null;
  generationDraftDoc: ViewDocumentSnapshot | null;
  docWithPatches: ViewDocumentSnapshot | null;
  showPatches: boolean;
  overlay: DocDimensions["overlay"];
}): ViewDocumentSnapshot | null {
  const {
    viewingHistory,
    viewingSnapshotDoc,
    doc,
    generationDraftDoc,
    docWithPatches,
    showPatches,
    overlay,
  } = input;
  if (viewingHistory && viewingSnapshotDoc) return viewingSnapshotDoc;
  const preferDraft =
    generationDraftHasContent(generationDraftDoc) && overlay !== "askUser";
  if (preferDraft && !showPatches) return generationDraftDoc;
  if (showPatches) return docWithPatches ?? doc ?? generationDraftDoc;
  return doc ?? generationDraftDoc;
}

export type WorkspaceVisualState = "idle" | "editing" | "bigplan" | "running";
export type WorkspaceToolState =
  | "none"
  | "agentBusy"
  | "askUser"
  | "imageProgress";

export interface WorkspaceDataAttrs {
  content: DocDimensions["content"]["kind"];
  tool: WorkspaceToolState;
}

/** askUser 语义意图的中文短标签（用于浮层/大表单头部的可观测展示）。 */
export function askUserPurposeLabel(kind: string): string {
  switch (kind) {
    case "initialBrief":
      return "确认方向";
    case "quickClarification":
      return "补充说明";
    case "directionChange":
      return "调整方向";
    default:
      return kind;
  }
}

export function selectFullpageAsk(
  dim: DocDimensions,
  openAskUser: ToolCallSpec | null,
): ToolCallSpec | null {
  if (dim.overlay !== "askUser") return null;
  if (openAskUser?.body.kind !== "askUser") return null;
  return openAskUser.body.data.mode.kind === "fullpage" ? openAskUser : null;
}

export function workspaceVisualState(dim: DocDimensions): WorkspaceVisualState {
  switch (dim.editor) {
    case "empty":
      return "idle";
    case "editable":
      return "editing";
    case "locked":
      return dim.overlay === "askUser" ? "bigplan" : "running";
    case "pendingReview":
      return "running";
  }
}

export function workspaceToolState(dim: DocDimensions): WorkspaceToolState {
  if (dim.overlay !== null) return dim.overlay;
  return dim.agentBusy ? "agentBusy" : "none";
}

export function workspaceDataAttrs(dim: DocDimensions): WorkspaceDataAttrs {
  return {
    content: dim.content.kind,
    tool: workspaceToolState(dim),
  };
}

export function canEditDocument(
  dim: DocDimensions,
  viewingVersion: number | null,
): boolean {
  return dim.editor === "editable" && viewingVersion === null;
}

export function buildCancelStreamCommands(streamIds: readonly string[]): Command[] {
  return streamIds.map((streamId) => ({
    kind: "cancelStream",
    data: { streamId },
  }));
}

export function workspaceViewingVersionFromHash(hash: string): number | null {
  const routeHash = hash.split(";")[0] ?? hash;
  const queryIdx = routeHash.indexOf("?");
  if (queryIdx < 0) return null;
  const params = new URLSearchParams(routeHash.slice(queryIdx + 1));
  const raw = params.get("viewingVersion");
  if (raw === null || raw.trim() === "") return null;
  const version = Number(raw);
  return Number.isInteger(version) && version >= 0 ? version : null;
}

export function workspaceViewingVersionIdFromHash(hash: string): string | null {
  const routeHash = hash.split(";")[0] ?? hash;
  const queryIdx = routeHash.indexOf("?");
  if (queryIdx < 0) return null;
  const params = new URLSearchParams(routeHash.slice(queryIdx + 1));
  const raw = params.get("viewingVersionId");
  return raw && raw.trim() ? raw : null;
}

export function workspaceSessionIdFromHash(hash: string): string | null {
  const routeHash = hash.split(";")[0] ?? hash;
  const queryIdx = routeHash.indexOf("?");
  if (queryIdx < 0) return null;
  const params = new URLSearchParams(routeHash.slice(queryIdx + 1));
  const raw = params.get("session");
  return raw && raw.trim() ? raw : null;
}

export function workspaceHistorySnapshotUrl(versionId: string, sessionId: string): string {
  const params = new URLSearchParams({ sessionId });
  return `/api/v1/history/${encodeURIComponent(versionId)}?${params.toString()}`;
}

export function workspaceHashWithViewingVersion(
  hash: string,
  version: number | null,
  versionId: string | null = null,
): string {
  const routeHash = hash.split(";")[0] ?? hash;
  const [path = "#/workspace", query = ""] = routeHash.split("?");
  const params = new URLSearchParams(query);
  if (version === null) {
    params.delete("viewingVersion");
    params.delete("viewingVersionId");
  } else {
    params.set("viewingVersion", String(version));
    if (versionId) params.set("viewingVersionId", versionId);
    else params.delete("viewingVersionId");
  }
  const nextQuery = params.toString();
  return `${path || "#/workspace"}${nextQuery ? `?${nextQuery}` : ""}`;
}
