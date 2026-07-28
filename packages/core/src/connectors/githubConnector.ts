import {
  deleteConnectorCredentialBundle,
  getConnectorCredentialBundle,
  saveConnectorCredentialBundle,
  type ConnectorCredentialBundle,
} from "../credentials/credentialsRepo.js";
import { GithubDeviceAuth, type GithubDeviceCode } from "./github/githubAuth.js";
import { GithubClient } from "./github/githubClient.js";
import { GithubConnectorError } from "./github/githubErrors.js";
import { PendingStore, PendingStoreError } from "./pendingStore.js";
import { registerConnector } from "./registryCore.js";
import { createConnectorStatus } from "./service.js";
import type { ConnectorAdapter, ConnectorDefinition, ConnectorStatusDto } from "./types.js";

// 产品官方 GitHub OAuth App(device flow)。client_id 是公开标识,不含任何权限;
// env QINGAGENT_GITHUB_CLIENT_ID 可覆盖(自建 App/测试用 fake provider)。
const DEFAULT_GITHUB_CLIENT_ID = "Ov23likRIvGi2U1eq42H";

export interface GithubCredentialPayload {
  strategy: "oauth2-device";
  version: 1;
  grantedScopes: string[];
  account: { id: string; displayName: string };
  token: string;
  verification?: {
    state: "connected" | "needs_reauth";
    checkedAt: string;
  };
}

const githubConnectorDefinition = {
  id: "github",
  name: "GitHub",
  icon: "github",
  official: true,
  authStrategy: "oauth2-device",
  authPresentation: "device-code",
  custody: "internal",
  scopeGroups: [
    { id: "public", name: "公开仓库", scopes: ["public_repo"], description: "读取账号可见的公开仓库" },
    { id: "private", name: "私有仓库", scopes: ["repo"], description: "读取账号可见的公开与私有仓库" },
  ],
  tools: ["github_list_repos", "github_repo_tree", "github_read_file", "github_search_code"],
  usedBySkills: ["github-materials"],
} satisfies ConnectorDefinition;

registerConnector(githubConnectorDefinition, () => new GithubConnector());

interface GithubPendingValue {
  device: GithubDeviceCode;
  providerExpiresAt: number;
  targetScopes: string[];
  outcome: Promise<void>;
}

export interface GithubStartResult {
  user_code: string;
  verification_uri: string;
  expiresAt: string;
  pendingId: string;
  reused: boolean;
}

export interface GithubConnectorOptions {
  clientId?: string;
  oauthBaseUrl?: string;
  apiBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
  pendingStore?: PendingStore<GithubPendingValue>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function githubScopesCover(
  requiredScopes: readonly string[],
  grantedScopes: readonly string[],
): boolean {
  const granted = new Set(grantedScopes);
  return requiredScopes.every(
    (scope) =>
      granted.has(scope) ||
      (scope === "public_repo" && granted.has("repo")),
  );
}

export class GithubConnector implements ConnectorAdapter {
  private readonly clientId: string;
  private readonly pending: PendingStore<GithubPendingValue>;
  private readonly auth: GithubDeviceAuth;
  private currentPendingId: string | null = null;
  private lastReasonCode: string | null = null;
  // 最近一次真实核验时间(授权完成/probe 打真实 API 均算),status() 透出为 lastCheckedAt
  private lastCheckedAt: string | null = null;
  private readonly startFlights = new Map<string, Promise<GithubStartResult>>();
  private startSequence: Promise<void> = Promise.resolve();
  private generation = 0;
  private readonly terminalByPending = new Map<string, { status: ConnectorStatusDto; expiresAt: number }>();
  private readonly scopeByPending = new Map<string, "public_repo" | "repo">();

  constructor(private readonly options: GithubConnectorOptions = {}) {
    this.clientId =
      options.clientId ?? process.env.QINGAGENT_GITHUB_CLIENT_ID?.trim() ?? DEFAULT_GITHUB_CLIENT_ID;
    this.pending = options.pendingStore ?? new PendingStore({ ttlMs: 15 * 60_000 });
    this.auth = new GithubDeviceAuth({ clientId: this.clientId, baseUrl: options.oauthBaseUrl ?? process.env.QINGAGENT_GITHUB_OAUTH_BASE_URL, fetch: options.fetch, sleep: options.sleep });
  }

  async status(pendingId?: string): Promise<ConnectorStatusDto> {
    if (!this.clientId) return createConnectorStatus("unconfigured", { reasonCode: "GITHUB_CLIENT_ID_MISSING", statusFreshness: "fresh" });
    if (pendingId) {
      const terminal = this.terminalByPending.get(pendingId);
      if (terminal && terminal.expiresAt > Date.now()) return terminal.status;
      if (terminal) this.terminalByPending.delete(pendingId);
      try { this.pending.get(pendingId, "github", this.pendingScope(this.scopeByPending.get(pendingId))); }
      catch (error) {
        if (error instanceof PendingStoreError) throw error;
        throw error;
      }
    }
    if (this.currentPendingId) {
      try {
        this.pending.get(this.currentPendingId, "github", this.pendingScope(this.scopeByPending.get(this.currentPendingId)));
        return createConnectorStatus("pending", { reasonCode: null, statusFreshness: "fresh" });
      } catch (error) {
        if (error instanceof PendingStoreError) this.currentPendingId = null;
      }
    }
    const bundle = await getConnectorCredentialBundle<GithubCredentialPayload>("github");
    if (!bundle) return createConnectorStatus("disconnected", { reasonCode: this.lastReasonCode, statusFreshness: "fresh", canProbe: false });
    const verification = this.credentialVerification(bundle.payload);
    const needsReauth = verification?.state === "needs_reauth";
    return createConnectorStatus(needsReauth ? "needs_reauth" : "connected", {
      reasonCode: needsReauth ? "NEEDS_REAUTH" : null,
      account: bundle.payload.account,
      scopes: bundle.payload.grantedScopes,
      lastCheckedAt: verification?.checkedAt ?? null,
      statusFreshness: verification ? "fresh" : "unknown",
      canProbe: true,
    });
  }

  async start(input: { scope?: "public_repo" | "repo" } = {}): Promise<GithubStartResult> {
    if (!this.clientId) throw new GithubConnectorError("GitHub client_id 未配置", "GITHUB_CLIENT_ID_MISSING", 409);
    if (input === null || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => key !== "scope")) {
      throw new GithubConnectorError("GitHub start 参数非法", "INVALID_ARGUMENT", 400);
    }
    const scope = input.scope ?? "public_repo";
    if (scope !== "public_repo" && scope !== "repo") throw new GithubConnectorError("GitHub scope 非法", "INVALID_ARGUMENT", 400);
    const key = this.pendingScope(scope);
    const existing = this.startFlights.get(key);
    if (existing) return existing;
    const start = this.startSequence.then(() => this.startInternal(scope));
    const flight = start.finally(() => {
      if (this.startFlights.get(key) === flight) this.startFlights.delete(key);
    });
    this.startFlights.set(key, flight);
    this.startSequence = flight.then(() => {}, () => {});
    return flight;
  }

  private async startInternal(scope: "public_repo" | "repo"): Promise<GithubStartResult> {
    if (this.currentPendingId) {
      const pendingId = this.currentPendingId;
      const currentScope = this.scopeByPending.get(pendingId);
      try {
        if (!currentScope) throw new PendingStoreError("授权上下文已丢失，请重新发起", "PENDING_LOST", 410);
        const existing = this.pending.get(pendingId, "github", this.pendingScope(currentScope));
        if (currentScope === scope) {
          return this.publicStart(existing.value.device, existing.value.providerExpiresAt, existing.pendingId, true);
        }
        this.generation += 1;
        this.pending.disconnect("github", this.pendingScope(currentScope));
        this.scopeByPending.delete(pendingId);
        this.currentPendingId = null;
      } catch (error) {
        if (!(error instanceof PendingStoreError)) throw error;
        this.scopeByPending.delete(pendingId);
        this.currentPendingId = null;
      }
    }
    const device = await this.auth.start(scope);
    const providerExpiresAt = Date.now() + device.expires_in * 1000;
    let resolveOutcome!: () => void;
    const outcome = new Promise<void>((resolve) => { resolveOutcome = resolve; });
    const started = this.pending.start({
      connectorId: "github",
      scope: this.pendingScope(scope),
      create: ({ pendingId, signal }) => {
        void this.finishAuthorization(pendingId, device, [scope], signal).finally(resolveOutcome);
        return { device, providerExpiresAt, targetScopes: [scope], outcome };
      },
    });
    this.currentPendingId = started.entry.pendingId;
    this.scopeByPending.set(started.entry.pendingId, scope);
    this.lastReasonCode = null;
    return this.publicStart(device, providerExpiresAt, started.entry.pendingId, started.reused);
  }

  private async finishAuthorization(pendingId: string, device: GithubDeviceCode, targetScopes: string[], signal: AbortSignal): Promise<void> {
    const generation = this.generation;
    const oldBundle = await getConnectorCredentialBundle<GithubCredentialPayload>("github");
    try {
      const token = await this.auth.poll(device.device_code, device.interval ?? 5, Date.now() + device.expires_in * 1000, signal);
      const grantedScopes = token.scope.split(/[ ,]+/).map((value) => value.trim()).filter(Boolean);
      if (!githubScopesCover(targetScopes, grantedScopes)) throw new GithubConnectorError("GitHub 实际授权范围不足", "INSUFFICIENT_SCOPE", 409);
      const user = (await this.client(token.access_token).user(signal)).data;
      const account = { id: String(user.id), displayName: `@${user.login}` };
      if (oldBundle && oldBundle.payload.account.id !== account.id) throw new GithubConnectorError("GitHub 授权账号发生变化，需显式确认", "ACCOUNT_CHANGE_CONFIRMATION_REQUIRED", 409);
      if (signal.aborted || generation !== this.generation) return;
      const checkedAt = new Date().toISOString();
      await saveConnectorCredentialBundle<GithubCredentialPayload>("github", {
        strategy: "oauth2-device",
        version: 1,
        grantedScopes,
        account,
        token: token.access_token,
        verification: { state: "connected", checkedAt },
      }, {
        expectedRevision: oldBundle?.revision ?? null,
        writeGuard: () => !signal.aborted && generation === this.generation,
      });
      this.lastReasonCode = null;
      this.lastCheckedAt = checkedAt;
      this.terminalByPending.set(pendingId, { status: createConnectorStatus("connected", { account, scopes: grantedScopes, lastCheckedAt: this.lastCheckedAt, statusFreshness: "fresh", canProbe: true }), expiresAt: Date.now() + 60_000 });
      this.pending.complete(pendingId, "github", this.pendingScope(targetScopes[0] as "public_repo" | "repo"));
    } catch (error) {
      if (!signal.aborted) {
        this.lastReasonCode = error instanceof GithubConnectorError ? error.code : "GITHUB_AUTH_FAILED";
        this.terminalByPending.set(pendingId, {
          status: oldBundle
            ? createConnectorStatus("connected", { reasonCode: this.lastReasonCode, account: oldBundle.payload.account, scopes: oldBundle.payload.grantedScopes, statusFreshness: "fresh", canProbe: true })
            : createConnectorStatus("disconnected", { reasonCode: this.lastReasonCode, statusFreshness: "fresh" }),
          expiresAt: Date.now() + 60_000,
        });
        try { this.pending.complete(pendingId, "github", this.pendingScope(targetScopes[0] as "public_repo" | "repo")); } catch {}
      }
    } finally {
      if (this.currentPendingId === pendingId) this.currentPendingId = null;
    }
  }

  async probe(): Promise<ConnectorStatusDto> {
    const bundle = await getConnectorCredentialBundle<GithubCredentialPayload>("github");
    if (!bundle) return this.status();
    const checkedAt = new Date().toISOString();
    let verificationState: "connected" | "needs_reauth" = "connected";
    try {
      await this.client(bundle.payload.token).user();
    } catch (error) {
      if (error instanceof GithubConnectorError && error.code === "NEEDS_REAUTH") {
        verificationState = "needs_reauth";
      } else {
        console.error("[github-connector] probe failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw new GithubConnectorError(
          "GitHub 连接检查暂时失败，请稍后重试",
          "GITHUB_PROBE_FAILED",
          502,
        );
      }
    }
    await saveConnectorCredentialBundle<GithubCredentialPayload>("github", {
      ...bundle.payload,
      verification: { state: verificationState, checkedAt },
    }, { expectedRevision: bundle.revision });
    this.lastReasonCode = verificationState === "needs_reauth" ? "NEEDS_REAUTH" : null;
    this.lastCheckedAt = checkedAt;
    return this.status();
  }

  async disconnect(): Promise<ConnectorStatusDto> {
    this.generation += 1;
    this.pending.disconnect("github", this.pendingScope("public_repo"));
    this.pending.disconnect("github", this.pendingScope("repo"));
    this.currentPendingId = null;
    this.terminalByPending.clear();
    this.scopeByPending.clear();
    const bundle = await getConnectorCredentialBundle<GithubCredentialPayload>("github");
    if (bundle) await deleteConnectorCredentialBundle("github", { expectedRevision: bundle.revision });
    this.lastReasonCode = "USER_DISCONNECTED";
    return this.status();
  }

  createClientFromBundle(bundle: ConnectorCredentialBundle<GithubCredentialPayload> | null): GithubClient {
    return this.client(bundle?.payload.token);
  }

  private client(token?: string) { return new GithubClient({ baseUrl: this.options.apiBaseUrl ?? process.env.QINGAGENT_GITHUB_API_BASE_URL, fetch: this.options.fetch, token }); }
  private credentialVerification(payload: GithubCredentialPayload): GithubCredentialPayload["verification"] {
    const verification = payload.verification;
    if (
      !verification ||
      (verification.state !== "connected" && verification.state !== "needs_reauth") ||
      !Number.isFinite(Date.parse(verification.checkedAt))
    ) {
      return undefined;
    }
    return verification;
  }
  private pendingScope(scope: "public_repo" | "repo" | undefined = "public_repo") { return `default:${scope ?? "public_repo"}`; }
  private publicStart(device: GithubDeviceCode, providerExpiresAt: number, pendingId: string, reused: boolean): GithubStartResult {
    return { user_code: device.user_code, verification_uri: device.verification_uri, expiresAt: new Date(providerExpiresAt).toISOString(), pendingId, reused };
  }
}
