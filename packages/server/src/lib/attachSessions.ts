import { createHash, randomBytes } from "node:crypto";
import type {
  AttachCapabilities,
  AttachCapability,
  AttachIdentity,
} from "@qingagent/contract-ts";
import { ATTACH_CAPABILITY_NAMES } from "@qingagent/contract-ts";

export const ATTACH_SESSION_ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1_000;
export const ATTACH_SESSION_IDLE_TTL_MS = 2 * 60 * 60 * 1_000;
export const ATTACH_SESSION_CAPACITY = 256;
export const ATTACH_SESSION_TOKEN_PREFIX = "qa_attach_";

export const SERVER_ATTACH_CAPABILITIES: Readonly<AttachCapabilities> = Object.freeze({
  folderSelection: false,
  confirmGrant: false,
  diagnosticsExport: false,
  documentExport: false,
  credentialProvider: false,
  modelKeys: false,
  skillMutation: false,
  connectors: false,
  updates: false,
  templateMutation: false,
  derivativeMutation: false,
  lexiconMutation: false,
  deepLink: true,
  docEditing: true,
  review: true,
  assets: true,
});

export interface AttachSession {
  id: string;
  identity: AttachIdentity;
  desktopCapabilities: AttachCapabilities;
  serverCapabilities: AttachCapabilities;
  effectiveCapabilities: AttachCapabilities;
  createdAtMs: number;
  lastSeenAtMs: number;
  absoluteExpiresAtMs: number;
  idleExpiresAtMs: number;
}

export interface CreatedAttachSession {
  token: string;
  session: AttachSession;
}

const sessions = new Map<string, AttachSession>();

function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function negotiateAttachCapabilities(
  desktopCapabilities: AttachCapabilities,
): AttachCapabilities {
  const effective = {} as AttachCapabilities;
  for (const capability of ATTACH_CAPABILITY_NAMES) {
    effective[capability] = SERVER_ATTACH_CAPABILITIES[capability]
      && desktopCapabilities[capability];
  }
  return effective;
}

export function createAttachSession(options: {
  identity: AttachIdentity;
  desktopCapabilities: AttachCapabilities;
  nowMs?: number;
}): CreatedAttachSession {
  const nowMs = options.nowMs ?? Date.now();
  pruneExpiredAttachSessions(nowMs);
  while (sessions.size >= ATTACH_SESSION_CAPACITY) evictLeastRecentlyUsedSession();

  // 前缀只用于把失效 attach bearer 与匿名本机访问明确区分；随机部分仍是完整 256 bit。
  const token = `${ATTACH_SESSION_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
  const effectiveCapabilities = negotiateAttachCapabilities(options.desktopCapabilities);
  const session: AttachSession = {
    id: randomBytes(16).toString("hex"),
    identity: { ...options.identity },
    desktopCapabilities: { ...options.desktopCapabilities },
    serverCapabilities: { ...SERVER_ATTACH_CAPABILITIES },
    effectiveCapabilities,
    createdAtMs: nowMs,
    lastSeenAtMs: nowMs,
    absoluteExpiresAtMs: nowMs + ATTACH_SESSION_ABSOLUTE_TTL_MS,
    idleExpiresAtMs: nowMs + ATTACH_SESSION_IDLE_TTL_MS,
  };
  sessions.set(tokenDigest(token), session);
  return { token, session };
}

export function resolveAttachSession(token: string, nowMs = Date.now()): AttachSession | null {
  if (!token.startsWith(ATTACH_SESSION_TOKEN_PREFIX)) return null;
  const digest = tokenDigest(token);
  const session = sessions.get(digest);
  if (!session) return null;
  if (isExpired(session, nowMs)) {
    sessions.delete(digest);
    return null;
  }
  session.lastSeenAtMs = nowMs;
  session.idleExpiresAtMs = Math.min(
    session.absoluteExpiresAtMs,
    nowMs + ATTACH_SESSION_IDLE_TTL_MS,
  );
  return session;
}

export function revokeAttachSession(token: string): boolean {
  return sessions.delete(tokenDigest(token));
}

export function revokeAllAttachSessions(): void {
  sessions.clear();
}

export function pruneExpiredAttachSessions(nowMs = Date.now()): number {
  let removed = 0;
  for (const [digest, session] of sessions) {
    if (!isExpired(session, nowMs)) continue;
    sessions.delete(digest);
    removed += 1;
  }
  return removed;
}

export function attachSessionHasCapability(
  session: AttachSession,
  capability: AttachCapability | null,
): boolean {
  return capability === null || session.effectiveCapabilities[capability] === true;
}

export function isAttachSessionTokenCandidate(token: string | null): boolean {
  return token?.startsWith(ATTACH_SESSION_TOKEN_PREFIX) === true;
}

function isExpired(session: AttachSession, nowMs: number): boolean {
  return nowMs >= session.absoluteExpiresAtMs || nowMs >= session.idleExpiresAtMs;
}

function evictLeastRecentlyUsedSession(): void {
  let oldest: { digest: string; at: number } | null = null;
  for (const [digest, session] of sessions) {
    if (!oldest || session.lastSeenAtMs < oldest.at) {
      oldest = { digest, at: session.lastSeenAtMs };
    }
  }
  if (oldest) sessions.delete(oldest.digest);
}

export function __attachSessionCountForTest(): number {
  return sessions.size;
}
