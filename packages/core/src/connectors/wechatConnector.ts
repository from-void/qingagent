import {
  deleteConnectorCredentialBundle,
  type ConnectorCredentialBundle,
} from "../credentials/credentialsRepo.js";
import { probeWechatSearchbiz, type WechatAuthProbeResult } from "../tools/wechatSearch.js";
import { createConnectorStatus } from "./service.js";
import { registerConnector } from "./registryCore.js";
import type { ConnectorAdapter, ConnectorDefinition, ConnectorStatusDto } from "./types.js";
import { wechatAuthService } from "./wechatAuthService.js";
import {
  markWechatSessionNeedsReauth,
  readWechatCredentialBundle,
  WECHAT_LEGACY_CREDENTIAL_KEYS,
  type WechatCredentialPayload,
} from "./wechatCredentials.js";

interface WechatConnectorDependencies {
  readBundle: () => Promise<ConnectorCredentialBundle<WechatCredentialPayload> | null>;
  probeSearchbiz: (token: string, cookie: string) => Promise<WechatAuthProbeResult>;
  markSessionNeedsReauth: (revision: number, now: Date) => Promise<void>;
  deleteBundle: (revision: number | null) => Promise<void>;
  now: () => Date;
}

const wechatConnectorDefinition = {
  id: "wechat-mp",
  name: "微信公众号",
  icon: "wechat",
  official: false,
  authStrategy: "qr-session",
  authPresentation: "scan",
  custody: "internal",
  scopeGroups: [],
  tools: ["wechat_auth_start", "wechat_auth_status", "wechat_search_mp", "wechat_list_articles"],
  usedBySkills: ["wechat-official-account"],
  riskNote: "非官方接口，登录态可能提前失效，并存在平台风控风险。",
} satisfies ConnectorDefinition;

registerConnector(wechatConnectorDefinition, () => new WechatConnector());

export class WechatConnector implements ConnectorAdapter {
  private readonly deps: WechatConnectorDependencies;

  constructor(deps: Partial<WechatConnectorDependencies> = {}) {
    this.deps = {
      readBundle: readWechatCredentialBundle,
      probeSearchbiz: probeWechatSearchbiz,
      markSessionNeedsReauth: markWechatSessionNeedsReauth,
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
        // scanned → reasonCode 透传:前端授权卡据此显示「已扫到,请在手机上确认」。
        return createConnectorStatus("pending", { reasonCode: pending.scanned ? "WECHAT_SCANNED" : null, statusFreshness: "fresh", canProbe: false });
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
      try {
        await this.deps.markSessionNeedsReauth(bundle.revision, this.deps.now());
      } catch {
        // 持久化异常不遮蔽本次探测已经确定的失效结果。
      }
      return createConnectorStatus("needs_reauth", { reasonCode: "needs_reauth", account: ttlStatus.account, lastCheckedAt: checkedAt, statusFreshness: "fresh", canProbe: true });
    }
    if (result.kind === "capability_denied") {
      return createConnectorStatus("disconnected", {
        reasonCode: "ACCESS_DENIED",
        account: ttlStatus.account,
        lastCheckedAt: checkedAt,
        statusFreshness: "fresh",
        canProbe: false,
      });
    }
    const reasonCode = result.kind === "rate_limit" ? "rate_limit" : "transient";
    return { ...ttlStatus, reasonCode, lastCheckedAt: checkedAt, statusFreshness: "ttl" };
  }

  async cancel(pendingId: string): Promise<ConnectorStatusDto> {
    wechatAuthService.cancel(pendingId);
    return this.status();
  }

  async disconnect(): Promise<ConnectorStatusDto> {
    wechatAuthService.disconnectPending();
    let revision: number | null = null;
    try {
      revision = (await this.deps.readBundle())?.revision ?? null;
    } catch {
      // 损坏行没有可信 revision；仓储会在事务内仅删除仍然损坏的原始行。
    }
    await this.deps.deleteBundle(revision);
    return createConnectorStatus("disconnected", { reasonCode: "USER_DISCONNECTED", lastCheckedAt: this.deps.now().toISOString(), statusFreshness: "fresh", canProbe: false });
  }

  private statusFromBundle(bundle: ConnectorCredentialBundle<WechatCredentialPayload> | null): ConnectorStatusDto {
    if (!bundle?.payload.token || !bundle.payload.cookie || !Number.isFinite(Date.parse(bundle.payload.expiry))) {
      return createConnectorStatus("disconnected", { reasonCode: "WECHAT_CREDENTIAL_MISSING", statusFreshness: "ttl", canProbe: false });
    }
    const account = bundle.payload.account ? { displayName: bundle.payload.account } : null;
    const issue = bundle.payload.sessionIssue;
    if (issue) return createConnectorStatus("needs_reauth", { reasonCode: issue.reasonCode, account, lastCheckedAt: issue.lastCheckedAt, statusFreshness: "fresh", canProbe: true });
    if (Date.parse(bundle.payload.expiry) <= this.deps.now().getTime()) {
      return createConnectorStatus("needs_reauth", { reasonCode: "needs_reauth", account, statusFreshness: "ttl", canProbe: true });
    }
    return createConnectorStatus("connected", { account, statusFreshness: "ttl", canProbe: true });
  }
}
