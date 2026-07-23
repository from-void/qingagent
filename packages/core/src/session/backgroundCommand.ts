import type { ToolCallSpec } from "@qingagent/contract-ts";
import type { SessionState } from "./sessionState.js";

export function isPersistentBackgroundCommand(spec: ToolCallSpec): boolean {
  return (
    spec.body.kind === "commandCard" &&
    spec.body.data.background === true &&
    typeof spec.body.data.pid === "string" &&
    spec.body.data.pid.length > 0 &&
    spec.body.data.ownerToolCallId === spec.id &&
    spec.body.data.terminalKind === undefined &&
    (spec.status.kind === "pending" || spec.status.kind === "running")
  );
}

export function registerBackgroundCommandOwner(
  state: SessionState,
  pid: string,
  ownerToolCallId: string,
): void {
  if (!pid || !ownerToolCallId) return;
  (state._backgroundCommandOwnerByPid ??= new Map()).set(pid, ownerToolCallId);
}

export function forgetBackgroundCommandOwner(
  state: SessionState,
  pid: string,
): void {
  state._backgroundCommandOwnerByPid?.delete(pid);
}

/**
 * 运行态索引重启后为空时，从持久化卡体恢复一次。
 * 恢复路径仍坚持完整谓词；正常运行中的收口优先使用 spawn 时建立的显式索引。
 */
export function backgroundCommandOwnerToolCallId(
  state: SessionState,
  pid: string,
): string | null {
  const indexed = state._backgroundCommandOwnerByPid?.get(pid);
  if (indexed) return indexed;

  for (const message of state.chatHistory) {
    for (const part of message.parts) {
      if (
        part.kind === "toolCall" &&
        isPersistentBackgroundCommand(part.data) &&
        part.data.body.kind === "commandCard" &&
        part.data.body.data.pid === pid
      ) {
        registerBackgroundCommandOwner(state, pid, part.data.id);
        return part.data.id;
      }
    }
  }
  return null;
}
