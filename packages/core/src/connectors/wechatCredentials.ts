import {
  ConnectorCredentialCasError,
  getConnectorCredentialBundle,
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

export async function readWechatCredentialBundle(): Promise<ConnectorCredentialBundle<WechatCredentialPayload> | null> {
  return getConnectorCredentialBundle<WechatCredentialPayload>("wechat-mp");
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
