import type { SessionState } from "../session/sessionState.js";

/**
 * proof 的作用域键。本模块只拿它当 WeakMap 不透明键,从不读字段;workspace 等
 * core 低层按分层规则不得直依赖 session 域,统一经本别名取类型。
 */
export type ApprovalProofSession = SessionState;

export const APPROVAL_PROOF_TTL_MS = 60_000;

interface ApprovalProof {
  sessionId: string;
  runId: string;
  toolCallId: string;
  commandDigest: string;
  expiresAt: number;
}

const proofs = new WeakMap<SessionState, Map<string, ApprovalProof>>();

function proofMap(state: SessionState): Map<string, ApprovalProof> {
  let map = proofs.get(state);
  if (!map) {
    map = new Map();
    proofs.set(state, map);
  }
  return map;
}

export function issueApprovalProof(
  state: SessionState,
  input: Omit<ApprovalProof, "expiresAt"> & { expiresAt?: number },
): void {
  proofMap(state).set(input.toolCallId, {
    sessionId: input.sessionId,
    runId: input.runId,
    toolCallId: input.toolCallId,
    commandDigest: input.commandDigest,
    expiresAt: input.expiresAt ?? Date.now() + APPROVAL_PROOF_TTL_MS,
  });
}

/** 精确匹配后原子删除；匹配失败和过期同样删除，任何错误都 fail-closed。 */
export function consumeApprovalProof(
  state: SessionState,
  input: Omit<ApprovalProof, "expiresAt">,
  now = Date.now(),
): boolean {
  const map = proofs.get(state);
  const proof = map?.get(input.toolCallId);
  if (!proof) return false;
  map!.delete(input.toolCallId);
  if (map!.size === 0) proofs.delete(state);
  return (
    proof.expiresAt > now &&
    proof.sessionId === input.sessionId &&
    proof.runId === input.runId &&
    proof.toolCallId === input.toolCallId &&
    proof.commandDigest === input.commandDigest
  );
}

export function clearApprovalProof(state: SessionState, toolCallId: string): void {
  const map = proofs.get(state);
  map?.delete(toolCallId);
  if (map?.size === 0) proofs.delete(state);
}

export function clearAllApprovalProofs(state: SessionState): void {
  proofs.delete(state);
}
