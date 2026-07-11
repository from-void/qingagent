import {
  deleteConnectorCredentialBundle,
  type ConnectorCredentialBundle,
} from "../credentials/credentialsRepo.js";
import { probeWechatSearchbiz, type WechatAuthProbeResult } from "../tools/wechatSearch.js";
import { createConnectorStatus } from "./service.js";
import type { ConnectorAdapter, ConnectorStatusDto } from "./types.js";
import { wechatAuthService } from "./wechatAuthService.js";
import {
  clearWechatSessionIssue,
  getWechatSessionIssue,
  readWechatCredentialBundle,
  WECHAT_LEGACY_CREDENTIAL_KEYS,
  type WechatCredentialPayload,
} from "./wechatCredentials.js";

interface WechatConnectorDependencies {
  readBundle: () => Promise<ConnectorCredentialBundle<WechatCredentialPayload> | null>;
  probeSearchbiz: (token: string, cookie: string) => Promise<WechatAuthProbeResult>;
  deleteBundle: (revision: number | null) => Promise<void>;
  now: () => Date;
}

export class WechatConnector implements ConnectorAdapter {
  private readonly deps: WechatConnectorDependencies;

  constructor(deps: Partial<WechatConnectorDependencies> = {}) {
    this.deps = {
      readBundle: readWechatCredentialBundle,
      probeSearchbiz: probeWechatSearchbiz,
      deleteBundle: (revision) => deleteConnectorCredentialBundle("wechat-mp", {
        expectedRevision: revision,
        legacy: { platform: "wechat", keys: WECHAT_LEGACY_CREDENTIAL_KEYS },
      }),
      now: () => new Date(),
      ...deps,
    };
  }

  async start(): Promise<unknown> { return wechatAuthService.start(); }

  async status(pendingId?: string): Promise<ConnectorStatusDto> {
    if (pendingId) {
      const pending = await wechatAuthService.status(pendingId);
      if (pending.state === "AUTHORIZING" || pending.state === "VERIFYING") {
        return createConnectorStatus("pending", { reasonCode: null, statusFreshness: "fresh", canProbe: false });
      }
      if (pending.state === "CAPABILITY_DENIED" || pending.state === "TIMEOUT") {
        return createConnectorStatus("disconnected", {
          reasonCode: pending.state === "TIMEOUT" ? "PENDING_EXPIRED" : "ACCESS_DENIED",
          statusFreshness: "fresh", canProbe: false,
        });
      }
    }
    try { return this.statusFromBundle(await this.deps.readBundle()); }
    catch { return createConnectorStatus("disconnected", { reasonCode: "WECHAT_CREDENTIAL_CORRUPT", statusFreshness: "ttl", canProbe: false }); }
  }

  async probe(): Promise<ConnectorStatusDto> {
    const bundle = await this.deps.readBundle();
    const ttlStatus = this.statusFromBundle(bundle);
    if (ttlStatus.state !== "connected" || !bundle) return ttlStatus;
    const checkedAt = this.deps.now().toISOString();
    const result = await this.deps.probeSearchbiz(bundle.payload.token, bundle.payload.cookie);
    if (result.ok) return { ...ttlStatus, reasonCode: null, lastCheckedAt: checkedAt, statusFreshness: "fresh" };
    if (result.kind === "reauth") {
      return createConnectorStatus("needs_reauth", { reasonCode: "needs_reauth", account: ttlStatus.account, lastCheckedAt: checkedAt, statusFreshness: "fresh", canProbe: true });
    }
    const reasonCode = result.kind === "rate_limit"
      ? "rate_limit"
      : result.kind === "capability_denied" ? "ACCESS_DENIED" : "transient";
    return { ...ttlStatus, reasonCode, lastCheckedAt: checkedAt, statusFreshness: "ttl" };
  }

  async disconnect(): Promise<ConnectorStatusDto> {
    wechatAuthService.disconnectPending();
    const bundle = await this.deps.readBundle();
    await this.deps.deleteBundle(bundle?.revision ?? null);
    clearWechatSessionIssue();
    return createConnectorStatus("disconnected", { reasonCode: "USER_DISCONNECTED", lastCheckedAt: this.deps.now().toISOString(), statusFreshness: "fresh", canProbe: false });
  }

  private statusFromBundle(bundle: ConnectorCredentialBundle<WechatCredentialPayload> | null): ConnectorStatusDto {
    if (!bundle?.payload.token || !bundle.payload.cookie || !Number.isFinite(Date.parse(bundle.payload.expiry))) {
      return createConnectorStatus("disconnected", { reasonCode: "WECHAT_CREDENTIAL_MISSING", statusFreshness: "ttl", canProbe: false });
    }
    const account = bundle.payload.account ? { displayName: bundle.payload.account } : null;
    const issue = getWechatSessionIssue(bundle.revision);
    if (issue) return createConnectorStatus("needs_reauth", { reasonCode: issue.reasonCode, account, lastCheckedAt: issue.lastCheckedAt, statusFreshness: "fresh", canProbe: true });
    if (Date.parse(bundle.payload.expiry) <= this.deps.now().getTime()) {
      return createConnectorStatus("needs_reauth", { reasonCode: "needs_reauth", account, statusFreshness: "ttl", canProbe: true });
    }
    return createConnectorStatus("connected", { account, statusFreshness: "ttl", canProbe: true });
  }
}
