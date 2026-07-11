import {
  readThroughMigrateConnectorBundle,
  type ConnectorCredentialBundle,
} from "../credentials/credentialsRepo.js";

export interface WechatCredentialPayload {
  strategy: "qr-session";
  version: 1;
  account: string;
  cookie: string;
  token: string;
  expiry: string;
}

const LEGACY_KEYS = ["cookie", "expiry", "mp_name", "token"] as const;

let sessionIssue: { revision: number; reasonCode: "needs_reauth"; lastCheckedAt: string } | null = null;

export async function readWechatCredentialBundle(): Promise<ConnectorCredentialBundle<WechatCredentialPayload> | null> {
  const result = await readThroughMigrateConnectorBundle<WechatCredentialPayload>({
    connectorId: "wechat-mp",
    legacyPlatform: "wechat",
    legacyKeys: LEGACY_KEYS,
    migrate: (legacy) => ({
      strategy: "qr-session",
      version: 1,
      account: legacy.mp_name ?? "",
      cookie: legacy.cookie!,
      token: legacy.token!,
      expiry: legacy.expiry!,
    }),
  });
  return result.bundle;
}

export function markWechatSessionNeedsReauth(revision: number, now = new Date()): void {
  sessionIssue = { revision, reasonCode: "needs_reauth", lastCheckedAt: now.toISOString() };
}

export function getWechatSessionIssue(revision: number) {
  return sessionIssue?.revision === revision ? sessionIssue : null;
}

export function clearWechatSessionIssue(): void {
  sessionIssue = null;
}

export const WECHAT_LEGACY_CREDENTIAL_KEYS = LEGACY_KEYS;
