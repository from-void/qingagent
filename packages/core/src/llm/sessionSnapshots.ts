import type { RequestContext } from "@mastra/core/request-context";
import { createHash, randomUUID } from "node:crypto";

export const BRANCH_SNAPSHOT_GENERATION_CONTEXT_KEY = "branchSnapshotGeneration";
export const BRANCH_SNAPSHOT_EPOCH_CONTEXT_KEY = "branchSnapshotEpoch";
export const BRANCH_SNAPSHOT_LEASE_CONTEXT_KEY = "branchSnapshotLease";
export const MAX_SESSION_SNAPSHOTS = 256;
export const SESSION_SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;

export type BranchMessage = Record<string, unknown> & {
  role: "system" | "user" | "assistant" | "tool";
};

export interface SessionSnapshot {
  readonly sessionId: string;
  readonly streamId: string | null;
  readonly generation: number;
  readonly leaseId: string;
  readonly ordinal: number;
  readonly epoch: number;
  readonly capturedAt: string;
  readonly endpoint: string;
  readonly bodyText: string;
  readonly safeHeaders: Readonly<Record<string, string>>;
  readonly authFingerprint: string;
}

interface SnapshotRegistryEntry {
  activeGeneration: number;
  leaseId: string;
  nextOrdinal: number;
  epoch: number;
  touchedAt: number;
  snapshot: SessionSnapshot | null;
}

const sessionSnapshots = new Map<string, SnapshotRegistryEntry>();

function pruneSessionSnapshots(now = Date.now()): void {
  for (const [sessionId, entry] of sessionSnapshots) {
    if (now - entry.touchedAt > SESSION_SNAPSHOT_TTL_MS) sessionSnapshots.delete(sessionId);
  }
  while (sessionSnapshots.size > MAX_SESSION_SNAPSHOTS) {
    const oldest = sessionSnapshots.keys().next().value as string | undefined;
    if (!oldest) break;
    sessionSnapshots.delete(oldest);
  }
}

/** 每个主链 turn 先领取单调 generation；旧 turn 的迟到 fetch 不得覆盖新快照。 */
export function beginSessionSnapshotTurn(requestContext?: RequestContext): number | null {
  const sessionId = requestContext?.get("sessionId");
  if (typeof sessionId !== "string" || !sessionId) return null;
  pruneSessionSnapshots();
  const current = sessionSnapshots.get(sessionId);
  const generation = (current?.activeGeneration ?? 0) + 1;
  const entry: SnapshotRegistryEntry = {
    activeGeneration: generation,
    // 随机 lease 避免 clear/TTL 后 generation 从 1 重启形成 ABA。
    leaseId: randomUUID(),
    nextOrdinal: 0,
    epoch: current?.epoch ?? 0,
    touchedAt: Date.now(),
    snapshot: current?.snapshot ?? null,
  };
  sessionSnapshots.delete(sessionId);
  sessionSnapshots.set(sessionId, entry);
  requestContext?.set(BRANCH_SNAPSHOT_GENERATION_CONTEXT_KEY, generation);
  requestContext?.set(BRANCH_SNAPSHOT_EPOCH_CONTEXT_KEY, entry.epoch);
  requestContext?.set(BRANCH_SNAPSHOT_LEASE_CONTEXT_KEY, entry.leaseId);
  return generation;
}

export function getSessionSnapshot(
  source?: RequestContext | string | null,
): SessionSnapshot | null {
  const sessionId = typeof source === "string" ? source : source?.get("sessionId");
  if (typeof sessionId !== "string" || !sessionId) return null;
  const entry = sessionSnapshots.get(sessionId);
  if (!entry) return null;
  if (Date.now() - entry.touchedAt > SESSION_SNAPSHOT_TTL_MS) {
    sessionSnapshots.delete(sessionId);
    return null;
  }
  const snapshot = entry.snapshot;
  // 新主轮已领取代际、但新的 provider fetch 尚未到达时，旧快照不能冒充当前轮。
  // 字符串调用方（如 askMore）也受 lease 约束，避免并发新轮开始后回放过期前缀。
  if (snapshot && (
    entry.activeGeneration !== snapshot.generation ||
    entry.epoch !== snapshot.epoch
  )) return null;
  if (typeof source !== "string" && source && snapshot) {
    const generation = source.get(BRANCH_SNAPSHOT_GENERATION_CONTEXT_KEY);
    const epoch = source.get(BRANCH_SNAPSHOT_EPOCH_CONTEXT_KEY);
    const leaseId = source.get(BRANCH_SNAPSHOT_LEASE_CONTEXT_KEY);
    if (typeof generation === "number" && snapshot.generation !== generation) return null;
    if (typeof epoch === "number" && snapshot.epoch !== epoch) return null;
    if (typeof leaseId === "string" && snapshot.leaseId !== leaseId) return null;
  }
  entry.touchedAt = Date.now();
  sessionSnapshots.delete(sessionId);
  sessionSnapshots.set(sessionId, entry);
  return snapshot;
}

export function clearSessionSnapshot(sessionId: string): void {
  sessionSnapshots.delete(sessionId);
}

/** OM 压缩边界推进 epoch；旧 body 不改写，但不再作为未来主轮的默认分支前缀。 */
export function advanceSessionSnapshotEpoch(sessionId: string): number {
  const entry = sessionSnapshots.get(sessionId);
  if (!entry) return 0;
  entry.epoch += 1;
  entry.snapshot = null;
  entry.touchedAt = Date.now();
  return entry.epoch;
}

export function sessionSnapshotAuthFingerprint(
  apiKey: string,
  endpoint: string,
  modelId: unknown,
): string {
  return createHash("sha256")
    .update(`${apiKey}\0${endpoint}\0${String(modelId ?? "")}`)
    .digest("hex");
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const normalized = new Headers(headers);
  normalized.forEach((value, key) => {
    if (key === "authorization" || key === "x-api-key") return;
    out[key] = value;
  });
  return out;
}

function captureSessionSnapshot(
  requestContext: RequestContext | undefined,
  apiKey: string,
  url: RequestInfo | URL,
  init: RequestInit | undefined,
  validateWireMessages: (messages: unknown[]) => string | null,
): void {
  const sessionId = requestContext?.get("sessionId");
  const generation = requestContext?.get(BRANCH_SNAPSHOT_GENERATION_CONTEXT_KEY);
  const leaseId = requestContext?.get(BRANCH_SNAPSHOT_LEASE_CONTEXT_KEY);
  if (
    typeof sessionId !== "string" || !sessionId ||
    typeof generation !== "number" || typeof leaseId !== "string"
  ) return;
  if (typeof init?.body !== "string") return;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return;
  }
  if (!Array.isArray(body.messages)) return;
  const entry = sessionSnapshots.get(sessionId);
  if (!entry || entry.activeGeneration !== generation || entry.leaseId !== leaseId) return;
  {
    // 写入时校验：问题在发生那一步就报警，不潜伏到某次借道才炸。
    const violation = validateWireMessages(body.messages);
    if (violation) {
      console.warn(`[snapshot] session=${sessionId} gen=${generation} INVALID: ${violation}(快照仍存,回放依赖 normalize+preflight)`);
    }
  }
  const endpoint = String(url);
  const ordinal = entry.nextOrdinal + 1;
  entry.nextOrdinal = ordinal;
  entry.touchedAt = Date.now();
  entry.snapshot = Object.freeze({
    sessionId,
    streamId: typeof requestContext?.get("streamId") === "string"
      ? requestContext.get("streamId") as string
      : null,
    generation,
    leaseId,
    ordinal,
    epoch: entry.epoch,
    capturedAt: new Date().toISOString(),
    endpoint,
    bodyText: init.body,
    safeHeaders: Object.freeze(headersToRecord(init.headers)),
    authFingerprint: sessionSnapshotAuthFingerprint(apiKey, endpoint, body.model),
  });
}

export function createBranchSnapshotFetch(
  requestContext: RequestContext | undefined,
  apiKey: string,
  validateWireMessages: (messages: unknown[]) => string | null,
): typeof fetch {
  return async (url, init) => {
    captureSessionSnapshot(requestContext, apiKey, url, init, validateWireMessages);
    return globalThis.fetch(url, init);
  };
}

export function ownsSessionSnapshotLease(snapshot: SessionSnapshot): boolean {
  const entry = sessionSnapshots.get(snapshot.sessionId);
  return entry?.snapshot === snapshot &&
    entry.activeGeneration === snapshot.generation &&
    entry.epoch === snapshot.epoch &&
    entry.leaseId === snapshot.leaseId;
}
