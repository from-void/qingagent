import {
  ConnectorCredentialCasError,
  readThroughMigrateConnectorBundle,
  type ConnectorCredentialBundle,
  updateConnectorCredentialBundlePayload,
} from "../credentials/credentialsRepo.js";

export interface WechatSessionIssue {
  reasonCode: "needs_reauth";
  lastCheckedAt: string;
}

export interface WechatCredentialPayload {
  strategy: "qr-session";
  version: 1;
  account: string;
  cookie: string;
  token: string;
  expiry: string;
  sessionIssue?: WechatSessionIssue;
}

const LEGACY_KEYS = ["cookie", "expiry", "mp_name", "token"] as const;

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

export async function markWechatSessionNeedsReauth(
  revision: number,
  now = new Date(),
): Promise<void> {
  const bundle = await readWechatCredentialBundle();
  if (!bundle || bundle.revision !== revision) return;
  try {
    await updateConnectorCredentialBundlePayload(
      "wechat-mp",
      {
        ...bundle.payload,
        sessionIssue: {
          reasonCode: "needs_reauth",
          lastCheckedAt: now.toISOString(),
        },
      },
      revision,
    );
  } catch (error) {
    if (error instanceof ConnectorCredentialCasError) return;
    throw error;
  }
}

export const WECHAT_LEGACY_CREDENTIAL_KEYS = LEGACY_KEYS;
