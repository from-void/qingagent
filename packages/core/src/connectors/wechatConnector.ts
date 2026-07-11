import {
  deleteCredentialRecordsBatch,
  getCredentialsForPlatform,
} from "../credentials/credentialsRepo.js";
import { probeWechatSearchbiz, type WechatAuthProbeResult } from "../tools/wechatSearch.js";
import { createConnectorStatus } from "./service.js";
import type { ConnectorAdapter, ConnectorStatusDto } from "./types.js";

const WECHAT_PLATFORM = "wechat";
const WECHAT_CREDENTIAL_KEYS = ["cookie", "expiry", "mp_name", "token"] as const;

interface WechatConnectorDependencies {
  getCredentials: () => Promise<Record<string, string>>;
  probeSearchbiz: (token: string, cookie: string) => Promise<WechatAuthProbeResult>;
  deleteCredentials: () => Promise<void>;
  now: () => Date;
}

export class WechatConnector implements ConnectorAdapter {
  private readonly deps: WechatConnectorDependencies;

  constructor(deps: Partial<WechatConnectorDependencies> = {}) {
    this.deps = {
      getCredentials: () => getCredentialsForPlatform(WECHAT_PLATFORM),
      probeSearchbiz: probeWechatSearchbiz,
      deleteCredentials: () => deleteCredentialRecordsBatch(WECHAT_PLATFORM, WECHAT_CREDENTIAL_KEYS),
      now: () => new Date(),
      ...deps,
    };
  }

  async status(): Promise<ConnectorStatusDto> {
    const credentials = await this.deps.getCredentials();
    return this.statusFromCredentials(credentials);
  }

  async probe(): Promise<ConnectorStatusDto> {
    const credentials = await this.deps.getCredentials();
    const ttlStatus = this.statusFromCredentials(credentials);
    if (ttlStatus.state !== "connected" || !credentials.token) return ttlStatus;
    const checkedAt = this.deps.now().toISOString();
    const result = await this.deps.probeSearchbiz(credentials.token, credentials.cookie ?? "");
    if (result.ok) {
      return { ...ttlStatus, reasonCode: null, lastCheckedAt: checkedAt, statusFreshness: "fresh" };
    }
    if (result.kind === "reauth") {
      return createConnectorStatus("needs_reauth", {
        reasonCode: "SESSION",
        account: ttlStatus.account,
        lastCheckedAt: checkedAt,
        statusFreshness: "fresh",
        canProbe: true,
      });
    }
    const reasonCode = result.kind === "rate_limit" ? "RATE_LIMIT" :
      result.kind === "capability_denied" ? "ACCESS_DENIED" :
        result.kind === "transient" ? "TRANSIENT" : "UNKNOWN";
    // 频控/瞬时错误不能反向证明 session 失效，保留 TTL 判读并如实标新鲜度。
    return { ...ttlStatus, reasonCode, lastCheckedAt: checkedAt, statusFreshness: "ttl" };
  }

  async disconnect(): Promise<ConnectorStatusDto> {
    await this.deps.deleteCredentials();
    return createConnectorStatus("disconnected", {
      reasonCode: "USER_DISCONNECTED",
      lastCheckedAt: this.deps.now().toISOString(),
      statusFreshness: "fresh",
      canProbe: false,
    });
  }

  private statusFromCredentials(credentials: Record<string, string>): ConnectorStatusDto {
    const token = credentials.token;
    const cookie = credentials.cookie;
    const expiryMs = credentials.expiry ? Date.parse(credentials.expiry) : Number.NaN;
    if (!token || !cookie || !Number.isFinite(expiryMs)) {
      return createConnectorStatus("disconnected", {
        reasonCode: "WECHAT_CREDENTIAL_MISSING",
        statusFreshness: "ttl",
        canProbe: false,
      });
    }
    const account = credentials.mp_name ? { displayName: credentials.mp_name } : null;
    if (expiryMs <= this.deps.now().getTime()) {
      return createConnectorStatus("needs_reauth", {
        reasonCode: "SESSION_EXPIRED",
        account,
        statusFreshness: "ttl",
        canProbe: true,
      });
    }
    return createConnectorStatus("connected", {
      account,
      statusFreshness: "ttl",
      canProbe: true,
    });
  }
}
