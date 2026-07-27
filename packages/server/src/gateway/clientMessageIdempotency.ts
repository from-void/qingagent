import {
  claimClientMessageIdempotency,
  releaseClientMessageIdempotency,
  CLIENT_MESSAGE_IDEMPOTENCY_TTL_MS,
  type ClientMessageIdempotencyClaim as PersistentClaim,
} from "@qingagent/db";

const CLIENT_MESSAGE_ID_MAX_ENTRIES = 4_096;

interface ClientMessageClaim {
  sessionId: string;
  messageId: string;
  token: string | null;
  createdAt: number;
  expiresAt: number;
}

export interface ClientMessageIdempotencyStore {
  claim(input: {
    id: string;
    sessionId: string;
    messageId: string;
    now: number;
  }): Promise<PersistentClaim>;
  release(input: {
    id: string;
    sessionId: string;
    messageId: string;
    createdAt: number;
  }): Promise<boolean>;
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
    const current = this.claims.get(clientMessageId);
    if (current && current.expiresAt > this.now()) {
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
      now: this.now(),
    });
    const raced = this.claims.get(clientMessageId);
    if (raced && raced.expiresAt > this.now()) {
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
      expiresAt:
        claim.record.createdAt + CLIENT_MESSAGE_IDEMPOTENCY_TTL_MS,
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
    while (this.claims.size > CLIENT_MESSAGE_ID_MAX_ENTRIES) {
      const oldest = this.claims.keys().next().value as string | undefined;
      if (!oldest) return;
      this.claims.delete(oldest);
    }
  }
}

const sqliteClientMessageIdempotencyStore: ClientMessageIdempotencyStore = {
  claim: claimClientMessageIdempotency,
  release: releaseClientMessageIdempotency,
};

export const clientMessageIdempotency =
  new ClientMessageIdempotencyRegistry();
