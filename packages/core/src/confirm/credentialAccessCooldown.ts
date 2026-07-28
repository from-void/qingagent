import type { ApprovalProofSession } from "./approvalProof.js";

/**
 * 用户点了「暂不共享」之后,同一个位置进入冷却:模型再申请也不再弹卡,
 * 直接拿到"已拒绝"的答复。免得一轮里被反复问同一件事。
 */
export const CREDENTIAL_ACCESS_COOLDOWN_MS = 30 * 60 * 1_000;

const cooldowns = new WeakMap<ApprovalProofSession, Map<string, number>>();

export function markCredentialAccessRejected(
  state: ApprovalProofSession,
  declared: string,
  now = Date.now(),
): void {
  let map = cooldowns.get(state);
  if (!map) {
    map = new Map();
    cooldowns.set(state, map);
  }
  map.set(declared, now + CREDENTIAL_ACCESS_COOLDOWN_MS);
}

export function credentialAccessIsCooling(
  state: ApprovalProofSession | undefined,
  declared: string,
  now = Date.now(),
): boolean {
  if (!state) return false;
  const until = cooldowns.get(state)?.get(declared);
  if (until === undefined) return false;
  if (until > now) return true;
  cooldowns.get(state)?.delete(declared);
  return false;
}

/** 仅测试用。 */
export function clearCredentialAccessCooldowns(state: ApprovalProofSession): void {
  cooldowns.delete(state);
}
