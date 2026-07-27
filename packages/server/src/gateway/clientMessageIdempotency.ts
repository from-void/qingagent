const CLIENT_MESSAGE_ID_TTL_MS = 30 * 60 * 1_000;
const CLIENT_MESSAGE_ID_MAX_ENTRIES = 4_096;

interface ClientMessageClaim {
  sessionId: string;
  token: string;
  expiresAt: number;
}

export type ClientMessageClaimResult =
  | {
      kind: "claimed";
      sessionId: string;
      token: string;
    }
  | {
      kind: "duplicate";
      sessionId: string;
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

  constructor(
    private readonly now: () => number = Date.now,
  ) {}

  claim(clientMessageId: string, sessionId: string): ClientMessageClaimResult {
    this.prune();
    const current = this.claims.get(clientMessageId);
    if (current && current.expiresAt > this.now()) {
      return {
        kind: "duplicate",
        sessionId: current.sessionId,
      };
    }
    const token = `${this.now()}:${this.tokenSequence += 1}`;
    this.claims.set(clientMessageId, {
      sessionId,
      token,
      expiresAt: this.now() + CLIENT_MESSAGE_ID_TTL_MS,
    });
    this.trim();
    return { kind: "claimed", sessionId, token };
  }

  release(clientMessageId: string, token: string): void {
    const current = this.claims.get(clientMessageId);
    if (current?.token === token) {
      this.claims.delete(clientMessageId);
    }
  }

  clear(): void {
    this.claims.clear();
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

export const clientMessageIdempotency =
  new ClientMessageIdempotencyRegistry();
