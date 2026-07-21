import { randomUUID } from "node:crypto";
import type { ConfirmGrantKind } from "@qingagent/db";
import { isEnvEnabled } from "@qingagent/core/workspace";

export const CONFIRM_UI_GRANT_MAX_TTL_MS = 60_000;

export type ConfirmUiGrantRegistration =
  | {
      purpose: "confirm";
      sessionId: string;
      confirmId: string;
      kind: ConfirmGrantKind;
      ttlMs?: number;
    }
  | {
      purpose: "settings";
      kind: ConfirmGrantKind;
      ttlMs?: number;
    };

export type ConfirmUiGrantConsumption =
  | {
      purpose: "confirm";
      nonce: string | undefined;
      sessionId: string;
      confirmId: string;
      kind: ConfirmGrantKind;
    }
  | {
      purpose: "settings";
      nonce: string | undefined;
      kind: ConfirmGrantKind;
    };

interface StoredUiGrant {
  nonce: string;
  purpose: ConfirmUiGrantRegistration["purpose"];
  kind: ConfirmGrantKind;
  sessionId?: string;
  confirmId?: string;
  expiresAt: number;
}

export interface ConsumeConfirmUiGrantResult {
  ok: boolean;
  reason?: "missing" | "unknown-or-replayed" | "expired" | "mismatch";
}

export class ConfirmUiGrantStore {
  readonly #now: () => number;
  readonly #createNonce: () => string;
  readonly #grants = new Map<string, StoredUiGrant>();

  constructor(options: { now?: () => number; createNonce?: () => string } = {}) {
    this.#now = options.now ?? Date.now;
    this.#createNonce = options.createNonce ?? randomUUID;
  }

  register(input: ConfirmUiGrantRegistration): string {
    this.#prune();
    const nonce = this.#createNonce();
    const ttlMs = Math.min(
      CONFIRM_UI_GRANT_MAX_TTL_MS,
      Math.max(1, input.ttlMs ?? CONFIRM_UI_GRANT_MAX_TTL_MS),
    );
    this.#grants.set(nonce, {
      nonce,
      purpose: input.purpose,
      kind: input.kind,
      ...(input.purpose === "confirm"
        ? { sessionId: input.sessionId, confirmId: input.confirmId }
        : {}),
      expiresAt: this.#now() + ttlMs,
    });
    return nonce;
  }

  consume(input: ConfirmUiGrantConsumption): ConsumeConfirmUiGrantResult {
    if (!input.nonce) return { ok: false, reason: "missing" };
    const grant = this.#grants.get(input.nonce);
    if (!grant) return { ok: false, reason: "unknown-or-replayed" };
    // capability 无论成功、过期还是绑定错配都只尝试一次。
    this.#grants.delete(input.nonce);
    if (grant.expiresAt <= this.#now()) return { ok: false, reason: "expired" };
    if (
      grant.purpose !== input.purpose ||
      grant.kind !== input.kind ||
      (input.purpose === "confirm" && (
        grant.sessionId !== input.sessionId || grant.confirmId !== input.confirmId
      ))
    ) {
      return { ok: false, reason: "mismatch" };
    }
    return { ok: true };
  }

  clear(): void {
    this.#grants.clear();
  }

  #prune(): void {
    const now = this.#now();
    for (const [nonce, grant] of this.#grants) {
      if (grant.expiresAt <= now) this.#grants.delete(nonce);
    }
  }
}

export const confirmUiGrantStore = new ConfirmUiGrantStore();

export function registerConfirmUiGrant(input: ConfirmUiGrantRegistration): string {
  return confirmUiGrantStore.register(input);
}

export function consumeConfirmUiGrant(
  input: ConfirmUiGrantConsumption,
): ConsumeConfirmUiGrantResult {
  return confirmUiGrantStore.consume(input);
}

let insecureModeLogged = false;

export function insecureRememberAllowed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const allowed = isEnvEnabled(env.QINGAGENT_DEV_ALLOW_INSECURE_REMEMBER);
  if (allowed && !insecureModeLogged) {
    insecureModeLogged = true;
    console.warn(
      "[security] QINGAGENT_DEV_ALLOW_INSECURE_REMEMBER 已开启，仅可用于本地开发自测",
    );
  }
  return allowed;
}

export function __resetConfirmUiGrantForTest(): void {
  confirmUiGrantStore.clear();
  insecureModeLogged = false;
}
