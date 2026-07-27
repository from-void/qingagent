import {
  claimClientMessageIdempotency,
  completeClientMessageIdempotency,
  releaseClientMessageIdempotency,
  touchClientMessageIdempotency,
  CLIENT_MESSAGE_IDEMPOTENCY_INFLIGHT_STALE_MS,
  CLIENT_MESSAGE_IDEMPOTENCY_TTL_MS,
  type ClientMessageIdempotencyClaim as PersistentClaim,
} from "@qingagent/db";

const CLIENT_MESSAGE_ID_MAX_ENTRIES = 4_096;
export const CLIENT_MESSAGE_IDEMPOTENCY_TOUCH_INTERVAL_MS = 30_000;

interface ClientMessageClaim {
  sessionId: string;
  messageId: string;
  token: string | null;
  createdAt: number;
  lastTouched: number;
  completedAt: number | null;
  expiresAt: number;
}

interface ClientMessageIdempotencyOwnedInput {
  id: string;
  sessionId: string;
  messageId: string;
  createdAt: number;
  now: number;
}

export interface ClientMessageIdempotencyStore {
  claim(input: {
    id: string;
    sessionId: string;
    messageId: string;
    now: number;
  }): Promise<PersistentClaim>;
  touch(input: ClientMessageIdempotencyOwnedInput): Promise<boolean>;
  complete(input: ClientMessageIdempotencyOwnedInput): Promise<boolean>;
  release(
    input: Omit<ClientMessageIdempotencyOwnedInput, "now">,
  ): Promise<boolean>;
}

export type ClientMessageClaimResult =
  | {
      kind: "claimed";
      sessionId: string;
      messageId: string;
      token: string;
      createdAt: number;
    }
  | {
      kind: "duplicate";
      sessionId: string;
      messageId: string;
    };

export function normalizeIdempotencyClientMessageId(
  value: unknown,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized.length === 0 || value.length > 64) return null;
  return normalized;
}

function recordExpiresAt(record: {
  lastTouched: number;
  completedAt: number | null;
}): number {
  return record.completedAt === null
    ? record.lastTouched + CLIENT_MESSAGE_IDEMPOTENCY_INFLIGHT_STALE_MS
    : record.completedAt + CLIENT_MESSAGE_IDEMPOTENCY_TTL_MS;
}

export class ClientMessageIdempotencyRegistry {
  private readonly claims = new Map<string, ClientMessageClaim>();
  private tokenSequence = 0;
  private store: ClientMessageIdempotencyStore;

  constructor(
    private readonly now: () => number = Date.now,
    store: ClientMessageIdempotencyStore = sqliteClientMessageIdempotencyStore,
  ) {
    this.store = store;
  }

  async claim(
    clientMessageId: string,
    sessionId: string,
    messageId = clientMessageId,
  ): Promise<ClientMessageClaimResult> {
    this.prune();
    const claimedAt = this.now();
    const current = this.claims.get(clientMessageId);
    if (current && current.expiresAt > claimedAt) {
      return {
        kind: "duplicate",
        sessionId: current.sessionId,
        messageId: current.messageId,
      };
    }
    const claim = await this.store.claim({
      id: clientMessageId,
      sessionId,
      messageId,
      now: claimedAt,
    });
    const raced = this.claims.get(clientMessageId);
    if (!claim.claimed && raced && raced.expiresAt > this.now()) {
      return {
        kind: "duplicate",
        sessionId: raced.sessionId,
        messageId: raced.messageId,
      };
    }
    const token = claim.claimed
      ? `${claim.record.createdAt}:${this.tokenSequence += 1}`
      : null;
    this.claims.set(clientMessageId, {
      sessionId: claim.record.sessionId,
      messageId: claim.record.messageId,
      token,
      createdAt: claim.record.createdAt,
      lastTouched: claim.record.lastTouched,
      completedAt: claim.record.completedAt,
      expiresAt: recordExpiresAt(claim.record),
    });
    this.trim();
    return claim.claimed
      ? {
          kind: "claimed",
          sessionId: claim.record.sessionId,
          messageId: claim.record.messageId,
          token: token!,
          createdAt: claim.record.createdAt,
        }
      : {
          kind: "duplicate",
          sessionId: claim.record.sessionId,
          messageId: claim.record.messageId,
        };
  }

  maintain<T>(
    clientMessageId: string,
    token: string,
    completion: Promise<T>,
  ): Promise<T> {
    const heartbeat = setInterval(() => {
      void this.touch(clientMessageId, token).catch(() => {
        // 在途 touch 是防误清理的附加保护；单次失败交给后续周期重试。
      });
    }, CLIENT_MESSAGE_IDEMPOTENCY_TOUCH_INTERVAL_MS);
    heartbeat.unref();

    const finish = async (): Promise<void> => {
      clearInterval(heartbeat);
      try {
        await this.complete(clientMessageId, token);
      } catch {
        // 命令已经入队，幂等状态收尾失败不能覆盖真实执行结果。
      }
    };
    return completion.then(
      async (value) => {
        await finish();
        return value;
      },
      async (error) => {
        await finish();
        throw error;
      },
    );
  }

  async release(
    clientMessageId: string,
    token: string,
  ): Promise<void> {
    const current = this.claims.get(clientMessageId);
    if (current?.token === token) {
      this.claims.delete(clientMessageId);
      await this.store.release({
        id: clientMessageId,
        sessionId: current.sessionId,
        messageId: current.messageId,
        createdAt: current.createdAt,
      });
    }
  }

  private async touch(
    clientMessageId: string,
    token: string,
  ): Promise<void> {
    const current = this.claims.get(clientMessageId);
    if (current?.token !== token || current.completedAt !== null) return;
    const touchedAt = this.now();
    const touched = await this.store.touch({
      id: clientMessageId,
      sessionId: current.sessionId,
      messageId: current.messageId,
      createdAt: current.createdAt,
      now: touchedAt,
    });
    const latest = this.claims.get(clientMessageId);
    if (touched && latest?.token === token && latest.completedAt === null) {
      latest.lastTouched = Math.max(latest.lastTouched, touchedAt);
      latest.expiresAt = recordExpiresAt(latest);
    }
  }

  private async complete(
    clientMessageId: string,
    token: string,
  ): Promise<void> {
    const current = this.claims.get(clientMessageId);
    if (current?.token !== token || current.completedAt !== null) return;
    const completedAt = this.now();
    const completed = await this.store.complete({
      id: clientMessageId,
      sessionId: current.sessionId,
      messageId: current.messageId,
      createdAt: current.createdAt,
      now: completedAt,
    });
    const latest = this.claims.get(clientMessageId);
    if (completed && latest?.token === token && latest.completedAt === null) {
      latest.token = null;
      latest.lastTouched = Math.max(latest.lastTouched, completedAt);
      latest.completedAt = completedAt;
      latest.expiresAt = recordExpiresAt(latest);
      this.trim();
    }
  }

  clear(): void {
    this.claims.clear();
  }

  useStoreForTest(store: ClientMessageIdempotencyStore): () => void {
    const previous = this.store;
    this.store = store;
    this.clear();
    return () => {
      this.store = previous;
      this.clear();
    };
  }

  private prune(): void {
    const currentTime = this.now();
    for (const [clientMessageId, claim] of this.claims) {
      if (claim.expiresAt <= currentTime) {
        this.claims.delete(clientMessageId);
      }
    }
  }

  private trim(): void {
    if (this.claims.size <= CLIENT_MESSAGE_ID_MAX_ENTRIES) return;
    for (const [clientMessageId, claim] of this.claims) {
      if (this.claims.size <= CLIENT_MESSAGE_ID_MAX_ENTRIES) return;
      // 活跃项维系 SQLite touch，不能为满足内存上限而驱逐；完成项可安全按需重读。
      if (claim.completedAt !== null) this.claims.delete(clientMessageId);
    }
  }
}

const sqliteClientMessageIdempotencyStore: ClientMessageIdempotencyStore = {
  claim: claimClientMessageIdempotency,
  touch: touchClientMessageIdempotency,
  complete: completeClientMessageIdempotency,
  release: releaseClientMessageIdempotency,
};

export const clientMessageIdempotency =
  new ClientMessageIdempotencyRegistry();
