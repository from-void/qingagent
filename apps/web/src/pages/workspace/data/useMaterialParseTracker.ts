import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type {
  BridgeFrame,
  Command,
  MaterialResourceMetadata,
  Resource,
} from "@qingagent/contract-ts";
import { validateCommand } from "../../../system/validators";

export interface UploadedAsset {
  fileId: string;
  filename: string;
  mime: string | null;
  size: number;
}

export type MaterialParseRowState = "ready" | "parsing" | "error";

export interface MaterialParseRow {
  id: string;
  fileId: string | null;
  filename: string;
  mime: string | null;
  state: MaterialParseRowState;
  parseError: string | null;
  resource: Resource | null;
  source: "resource" | "local";
}

export interface MaterialParseLocalEntry {
  fileId: string;
  filename: string;
  mime: string | null;
  state: "parsing" | "error";
  errorReason: string | null;
  turnKey: number;
  seenActive: boolean;
  /** retry 时记录旧 resource 的稳定版本签名；只有新的 resource 帧才清掉本地覆盖态。 */
  resourceVersionAtMark: string | null;
}

export interface MaterialParseTrackerState {
  entries: MaterialParseLocalEntry[];
}

export const MATERIAL_PARSE_INCOMPLETE_REASON = "本轮未完成解析，可重试";
export const MATERIAL_PARSE_SEND_FAILED_REASON = "发送失败，请重试";
export const MATERIAL_PARSE_RETRY_FAILED_REASON = "重试发送失败，请重试";
export const MATERIAL_PARSE_BUSY_REASON = "生成进行中，请稍后重试";

export const initialMaterialParseTrackerState: MaterialParseTrackerState = {
  entries: [],
};

export type MaterialParseTrackerAction =
  | {
      type: "markParsing";
      assets: readonly UploadedAsset[];
      agentActive: boolean;
      turnKey: number;
      resources: readonly Resource[];
    }
  | { type: "resourcesChanged"; resources: readonly Resource[] }
  | { type: "agentActiveChanged"; agentActive: boolean }
  | {
      type: "retry";
      fileId: string;
      agentActive: boolean;
      turnKey: number;
      resources: readonly Resource[];
    }
  | { type: "markTurnError"; turnKey: number; reason: string }
  | { type: "markError"; fileId: string; reason: string }
  | { type: "reset" };

export interface UseMaterialParseTrackerInput {
  sessionId: string | null;
  resources: readonly Resource[];
  agentActive: boolean;
  sendCommand: (command: Command) => Promise<unknown>;
}

export interface UseMaterialParseTrackerResult {
  rows: MaterialParseRow[];
  localEntries: MaterialParseLocalEntry[];
  markParsing: (assets: readonly UploadedAsset[]) => number | null;
  markTurnError: (turnKey: number, reason: string) => void;
  retry: (fileId: string) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function materialRetryFailureReasonFromCommandResult(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  for (const item of result) {
    const frame = item as Partial<BridgeFrame>;
    if (!isRecord(frame) || frame.kind !== "stream") continue;
    const data = frame.data;
    if (!isRecord(data) || data.kind !== "draftingFailed") continue;
    const payload = data.data;
    if (!isRecord(payload)) return MATERIAL_PARSE_RETRY_FAILED_REASON;
    const reason = typeof payload.reason === "string" ? payload.reason : "";
    if (/生成中|busy/i.test(reason)) return MATERIAL_PARSE_BUSY_REASON;
    return reason || MATERIAL_PARSE_RETRY_FAILED_REASON;
  }
  return null;
}

function materialMetadata(resource: Resource): Partial<MaterialResourceMetadata> {
  return isRecord(resource.metadata) ? resource.metadata : {};
}

function materialFileId(resource: Resource): string | null {
  const fileId = materialMetadata(resource).fileId;
  return typeof fileId === "string" && fileId.length > 0 ? fileId : null;
}

function materialParseState(resource: Resource): "ready" | "error" {
  return materialMetadata(resource).parseState === "error" ? "error" : "ready";
}

function materialParseError(resource: Resource): string | null {
  const error = materialMetadata(resource).parseError;
  return typeof error === "string" && error.length > 0 ? error : null;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function resourceVersionKey(resource: Resource): string {
  const metadata = materialMetadata(resource);
  const metadataRecord = metadata as Record<string, unknown>;
  const resourceRecord = resource as unknown as Record<string, unknown>;
  return JSON.stringify([
    resource.resourceRef.id,
    resource.createdAt,
    materialFileId(resource) ?? "",
    stringField(metadataRecord, "parseState") || "ready",
    stringField(metadataRecord, "parseError"),
    stringField(metadataRecord, "updatedAt"),
    stringField(resourceRecord, "updatedAt"),
    stringField(metadataRecord, "fileId"),
  ]);
}

function resourceByFileId(resources: readonly Resource[]): Map<string, Resource> {
  const byFileId = new Map<string, Resource>();
  for (const resource of resources) {
    const fileId = materialFileId(resource);
    if (fileId && !byFileId.has(fileId)) byFileId.set(fileId, resource);
  }
  return byFileId;
}

function requiresMaterialParseTracking(asset: UploadedAsset): boolean {
  return !asset.mime?.toLowerCase().startsWith("image/");
}

function withMarkedAssets(
  prev: MaterialParseTrackerState,
  assets: readonly UploadedAsset[],
  input: {
    agentActive: boolean;
    turnKey: number;
    resources: readonly Resource[];
  },
): MaterialParseTrackerState {
  if (assets.length === 0) return prev;
  const byFileId = new Map(prev.entries.map((entry) => [entry.fileId, entry]));
  const currentResources = resourceByFileId(input.resources);
  for (const asset of assets) {
    if (!asset.fileId || !requiresMaterialParseTracking(asset)) continue;
    const currentResource = currentResources.get(asset.fileId) ?? null;
    // 上传层会让完全相同的文件复用同一 fileId。普通发送再次带上已有 ready 素材时，
    // 既有资源已经是权威成功态，不应再用一个本地 parsing 覆盖它并在回合结束后误判失败。
    // 显式“重试解析”仍走 retry action；后端若发布新的 error resource 也会照常显示真失败。
    if (currentResource && materialParseState(currentResource) === "ready") {
      byFileId.delete(asset.fileId);
      continue;
    }
    byFileId.set(asset.fileId, {
      fileId: asset.fileId,
      filename: asset.filename,
      mime: asset.mime,
      state: "parsing",
      errorReason: null,
      turnKey: input.turnKey,
      seenActive: input.agentActive,
      resourceVersionAtMark: currentResource ? resourceVersionKey(currentResource) : null,
    });
  }
  return { entries: [...byFileId.values()] };
}

function reconcileResources(
  prev: MaterialParseTrackerState,
  resources: readonly Resource[],
): MaterialParseTrackerState {
  const currentResources = resourceByFileId(resources);
  const entries = prev.entries.filter((entry) => {
    const resource = currentResources.get(entry.fileId);
    if (!resource) return true;
    return entry.resourceVersionAtMark !== null &&
      resourceVersionKey(resource) === entry.resourceVersionAtMark;
  });
  return entries.length === prev.entries.length ? prev : { entries };
}

export function reduceMaterialParseTrackerState(
  prev: MaterialParseTrackerState,
  action: MaterialParseTrackerAction,
): MaterialParseTrackerState {
  switch (action.type) {
    case "markParsing":
      return withMarkedAssets(prev, action.assets, action);
    case "resourcesChanged":
      return reconcileResources(prev, action.resources);
    case "agentActiveChanged": {
      let changed = false;
      const entries = prev.entries.map((entry) => {
        if (entry.state !== "parsing") return entry;
        if (action.agentActive && !entry.seenActive) {
          changed = true;
          return { ...entry, seenActive: true };
        }
        if (!action.agentActive && entry.seenActive) {
          changed = true;
          return {
            ...entry,
            state: "error" as const,
            errorReason: MATERIAL_PARSE_INCOMPLETE_REASON,
          };
        }
        return entry;
      });
      return changed ? { entries } : prev;
    }
    case "retry": {
      const currentResources = resourceByFileId(action.resources);
      const existing = prev.entries.find((entry) => entry.fileId === action.fileId);
      const resource = currentResources.get(action.fileId) ?? null;
      const nextEntry: MaterialParseLocalEntry = {
        fileId: action.fileId,
        filename: existing?.filename ?? resource?.displayName ?? action.fileId,
        mime: existing?.mime ?? resource?.mime ?? null,
        state: "parsing",
        errorReason: null,
        turnKey: action.turnKey,
        seenActive: action.agentActive,
        resourceVersionAtMark: resource ? resourceVersionKey(resource) : null,
      };
      return {
        entries: [
          ...prev.entries.filter((entry) => entry.fileId !== action.fileId),
          nextEntry,
        ],
      };
    }
    case "markTurnError": {
      let changed = false;
      const entries = prev.entries.map((entry) => {
        if (
          entry.turnKey !== action.turnKey ||
          entry.state !== "parsing"
        ) {
          return entry;
        }
        changed = true;
        return {
          ...entry,
          state: "error" as const,
          errorReason: action.reason,
        };
      });
      return changed ? { entries } : prev;
    }
    case "markError": {
      let changed = false;
      const entries = prev.entries.map((entry) => {
        if (entry.fileId !== action.fileId) return entry;
        changed = true;
        return {
          ...entry,
          state: "error" as const,
          errorReason: action.reason,
        };
      });
      return changed ? { entries } : prev;
    }
    case "reset":
      return prev.entries.length === 0 ? prev : initialMaterialParseTrackerState;
  }
}

export function buildMaterialParseRows(
  state: MaterialParseTrackerState,
  resources: readonly Resource[],
): MaterialParseRow[] {
  const rows: MaterialParseRow[] = [];
  const resourceFileIds = new Set<string>();
  const localByFileId = new Map(state.entries.map((entry) => [entry.fileId, entry]));

  for (const resource of resources) {
    const fileId = materialFileId(resource);
    if (fileId) {
      if (resourceFileIds.has(fileId)) continue;
      resourceFileIds.add(fileId);
    }
    const local = fileId ? localByFileId.get(fileId) : undefined;
    const localOverridesCurrentResource =
      Boolean(local) &&
      local!.resourceVersionAtMark !== null &&
      local!.resourceVersionAtMark === resourceVersionKey(resource);
    const stateFromResource = materialParseState(resource);
    rows.push({
      id: resource.resourceRef.id,
      fileId,
      filename: resource.displayName,
      mime: resource.mime,
      state: localOverridesCurrentResource ? local!.state : stateFromResource,
      parseError: localOverridesCurrentResource
        ? local!.errorReason
        : stateFromResource === "error"
          ? materialParseError(resource)
          : null,
      resource,
      source: "resource",
    });
  }

  for (const entry of state.entries) {
    if (resourceFileIds.has(entry.fileId)) continue;
    rows.push({
      id: `local:${entry.fileId}`,
      fileId: entry.fileId,
      filename: entry.filename,
      mime: entry.mime,
      state: entry.state,
      parseError: entry.errorReason,
      resource: null,
      source: "local",
    });
  }

  return rows;
}

export function buildReparseMaterialCommand(
  sessionId: string,
  fileId: string,
): Extract<Command, { kind: "reparseMaterial" }> {
  return {
    kind: "reparseMaterial",
    data: { sessionId, fileId },
  };
}

export function useMaterialParseTracker({
  sessionId,
  resources,
  agentActive,
  sendCommand,
}: UseMaterialParseTrackerInput): UseMaterialParseTrackerResult {
  const [state, dispatch] = useReducer(
    reduceMaterialParseTrackerState,
    initialMaterialParseTrackerState,
  );
  const turnSeqRef = useRef(0);
  const resourcesRef = useRef(resources);
  const agentActiveRef = useRef(agentActive);
  const sessionIdRef = useRef<string | null>(sessionId);

  resourcesRef.current = resources;
  agentActiveRef.current = agentActive;

  useEffect(() => {
    dispatch({ type: "resourcesChanged", resources });
  }, [resources]);

  useEffect(() => {
    dispatch({ type: "agentActiveChanged", agentActive });
  }, [agentActive]);

  useEffect(() => {
    const prevSessionId = sessionIdRef.current;
    if (prevSessionId !== null && prevSessionId !== sessionId) {
      dispatch({ type: "reset" });
    }
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  const markParsing = useCallback((assets: readonly UploadedAsset[]) => {
    if (assets.length === 0) return null;
    turnSeqRef.current += 1;
    const turnKey = turnSeqRef.current;
    dispatch({
      type: "markParsing",
      assets,
      agentActive: agentActiveRef.current,
      turnKey,
      resources: resourcesRef.current,
    });
    return turnKey;
  }, []);

  const markTurnError = useCallback((turnKey: number, reason: string) => {
    dispatch({ type: "markTurnError", turnKey, reason });
  }, []);

  const retry = useCallback(
    async (fileId: string) => {
      if (!sessionId) throw new Error("会话未就绪");
      turnSeqRef.current += 1;
      dispatch({
        type: "retry",
        fileId,
        agentActive: agentActiveRef.current,
        turnKey: turnSeqRef.current,
        resources: resourcesRef.current,
      });
      const command = buildReparseMaterialCommand(sessionId, fileId);
      validateCommand(command);
      let result: unknown;
      try {
        result = await sendCommand(command);
      } catch (error) {
        dispatch({
          type: "markError",
          fileId,
          reason: MATERIAL_PARSE_RETRY_FAILED_REASON,
        });
        throw new Error(MATERIAL_PARSE_RETRY_FAILED_REASON);
      }
      const failureReason = materialRetryFailureReasonFromCommandResult(result);
      if (failureReason) {
        dispatch({
          type: "markError",
          fileId,
          reason: failureReason,
        });
        throw new Error(failureReason);
      }
    },
    [sendCommand, sessionId],
  );

  const rows = useMemo(
    () => buildMaterialParseRows(state, resources),
    [resources, state],
  );

  return {
    rows,
    localEntries: state.entries,
    markParsing,
    markTurnError,
    retry,
  };
}
