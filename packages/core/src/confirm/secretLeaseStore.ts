import type { SessionState } from "../session/sessionState.js";

export const SECRET_LEASE_TTL_MS = 60_000;

interface SecretLease {
  confirmId: string;
  toolCallId: string;
  value: string;
  expiresAt: number;
}

/**
 * secret 唯一容器。WeakMap 无法被 SessionState 序列化，也没有枚举/日志出口。
 * value 只由 take() 单次取走；失败、过期和读取成功都会立即删除。
 */
export class SecretLeaseStore {
  readonly #leases = new WeakMap<SessionState, Map<string, SecretLease>>();

  put(
    state: SessionState,
    input: {
      confirmId: string;
      toolCallId: string;
      value: string;
      expiresAt?: number;
    },
  ): void {
    let map = this.#leases.get(state);
    if (!map) {
      map = new Map();
      this.#leases.set(state, map);
    }
    map.set(input.confirmId, {
      confirmId: input.confirmId,
      toolCallId: input.toolCallId,
      value: input.value,
      expiresAt: Math.min(
        input.expiresAt ?? Number.POSITIVE_INFINITY,
        Date.now() + SECRET_LEASE_TTL_MS,
      ),
    });
  }

  has(
    state: SessionState,
    input: { confirmId: string; toolCallId: string },
    now = Date.now(),
  ): boolean {
    const lease = this.#leases.get(state)?.get(input.confirmId);
    if (!lease) return false;
    if (lease.expiresAt <= now || lease.toolCallId !== input.toolCallId) {
      this.delete(state, input.confirmId);
      return false;
    }
    return true;
  }

  hasUsableValue(
    state: SessionState,
    input: { confirmId: string; toolCallId: string },
    now = Date.now(),
  ): boolean {
    const lease = this.#leases.get(state)?.get(input.confirmId);
    if (!lease) return false;
    if (lease.expiresAt <= now || lease.toolCallId !== input.toolCallId) {
      this.delete(state, input.confirmId);
      return false;
    }
    return lease.value.trim().length > 0;
  }

  take(
    state: SessionState,
    input: { confirmId: string; toolCallId: string },
    now = Date.now(),
  ): string | null {
    const map = this.#leases.get(state);
    const lease = map?.get(input.confirmId);
    if (!lease) return null;
    map!.delete(input.confirmId);
    if (map!.size === 0) this.#leases.delete(state);
    if (
      lease.expiresAt <= now ||
      lease.confirmId !== input.confirmId ||
      lease.toolCallId !== input.toolCallId
    ) {
      return null;
    }
    return lease.value;
  }

  delete(state: SessionState, confirmId: string): void {
    const map = this.#leases.get(state);
    map?.delete(confirmId);
    if (map?.size === 0) this.#leases.delete(state);
  }

  clear(state: SessionState): void {
    this.#leases.delete(state);
  }
}

export const secretLeaseStore = new SecretLeaseStore();
