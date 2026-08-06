import { extractLarkConfigInitUrl } from "../tools/larkConfigUrl.js";
import { PendingStore, PendingStoreError } from "./pendingStore.js";
import { registerConnector } from "./registryCore.js";
import { createConnectorStatus } from "./service.js";
import type { ConnectorAdapter, ConnectorDefinition, ConnectorStatusDto } from "./types.js";
import {
  LARK_AUTH_DOMAINS,
  LARK_DEVICE_CODE,
  LarkCliRunner,
  type LarkAuthDomain,
  type LarkCliRunResult,
} from "./larkCliRunner.js";
import {
  parseLarkAuthStatusOutput,
  parseLarkConfigOutput,
  parseLarkDeviceFlowOutput,
} from "./larkStatusParser.js";

const AUTH_TTL_MS = 10 * 60_000;
const CONFIG_TTL_MS = 15 * 60_000;
const TERMINAL_TTL_MS = 60_000;

interface FeishuPendingValue {
  mode: "authorization" | "configuration";
  domains: LarkAuthDomain[];
  deviceCode?: string;
  configurationUrl?: string;
  outcome: Promise<void>;
}

const feishuConnectorDefinition = {
  id: "feishu",
  name: "飞书",
  icon: "feishu",
  official: true,
  authStrategy: "device-flow-cli",
  authPresentation: "scan",
  custody: "external-cli",
  scopeGroups: [],
  tools: ["feishu_auth_start"],
  usedBySkills: ["feishu"],
} satisfies ConnectorDefinition;

registerConnector(feishuConnectorDefinition, () => new FeishuConnector());

export type FeishuStartResult =
  | {
      mode: "authorization";
      connectorId: "feishu";
      verification_url: string;
      /** 真实 CLI 可能不给顶层 user_code(嵌在 URL 里),卡片侧 code 本就允许 null。 */
      user_code: string | null;
      expiresAt: string;
      pendingId: string;
      reused: boolean;
    }
  | {
      mode: "configuration";
      connectorId: "feishu";
      configuration_url: string;
      expiresAt: string;
      pendingId: string;
      reused: boolean;
    };

type Runner = Pick<LarkCliRunner, "run"> & Partial<Pick<LarkCliRunner, "startConfigInit">>;

export interface FeishuConnectorOptions {
  runner?: Runner;
  pendingStore?: PendingStore<FeishuPendingValue>;
  now?: () => number;
}

const DEFINITIVE_UNAVAILABLE_REASONS = new Set([
  "LARK_CLI_MISSING",
  "LARK_CLI_SPAWN_FAILED",
  "LARK_CLI_VERSION_UNSUPPORTED",
]);

function fail(code: string, message: string, status = 400): never {
  throw Object.assign(new Error(message), { code, status });
}

export class FeishuConnector implements ConnectorAdapter {
  private readonly runner: Runner;
  private readonly pending: PendingStore<FeishuPendingValue>;
  private readonly now: () => number;
  private currentPendingId: string | null = null;
  private currentScope: string | null = null;
  private readonly startFlights = new Map<string, Promise<FeishuStartResult>>();
  private startSequence: Promise<void> = Promise.resolve();
  private generation = 0;
  private readonly terminalByPending = new Map<string, { status: ConnectorStatusDto; expiresAt: number }>();
  private lastKnownStatus: ConnectorStatusDto | null = null;

  constructor(options: FeishuConnectorOptions | Runner = {}) {
    const normalized: FeishuConnectorOptions = "run" in options ? { runner: options } : options;
    this.runner = normalized.runner ?? new LarkCliRunner();
    this.pending = normalized.pendingStore ?? new PendingStore({ ttlMs: CONFIG_TTL_MS });
    if (!normalized.pendingStore) this.pending.attachProcessCleanup();
    this.now = normalized.now ?? Date.now;
  }

  async status(pendingId?: string): Promise<ConnectorStatusDto> {
    if (pendingId) {
      const terminal = this.terminalByPending.get(pendingId);
      if (terminal && terminal.expiresAt > this.now()) return terminal.status;
      if (terminal) this.terminalByPending.delete(pendingId);
      const scope = this.currentPendingId === pendingId ? this.currentScope : null;
      if (!scope) throw new PendingStoreError("授权上下文已丢失，请重新发起", "PENDING_LOST", 410);
      this.pending.get(pendingId, "feishu", scope);
      return createConnectorStatus("pending", { statusFreshness: "fresh", canProbe: true });
    }
    if (this.currentPendingId && this.currentScope) {
      try {
        this.pending.get(this.currentPendingId, "feishu", this.currentScope);
        return createConnectorStatus("pending", { statusFreshness: "fresh", canProbe: true });
      } catch (error) {
        if (error instanceof PendingStoreError) this.clearCurrent(this.currentPendingId);
      }
    }
    return this.readStatus();
  }

  async start(input: { domains?: LarkAuthDomain[] } = {}): Promise<FeishuStartResult> {
    const domains = this.validateDomains(input);
    const key = domains.join(",");
    const existing = this.startFlights.get(key);
    if (existing) return existing;
    const start = this.startSequence.then(() => this.startInternal(domains));
    const flight = start.finally(() => {
      if (this.startFlights.get(key) === flight) this.startFlights.delete(key);
    });
    this.startFlights.set(key, flight);
    this.startSequence = flight.then(() => {}, () => {});
    return flight;
  }

  private async startInternal(domains: LarkAuthDomain[]): Promise<FeishuStartResult> {
    if (this.currentPendingId && this.currentScope) {
      try {
        const existing = this.pending.get(this.currentPendingId, "feishu", this.currentScope);
        if (existing.value.mode === "authorization" && existing.value.deviceCode) {
          fail("FEISHU_AUTH_ALREADY_PENDING", "已有飞书授权正在进行，请先完成或等待过期", 409);
        }
        if (existing.value.mode === "configuration" && existing.value.configurationUrl) {
          return {
            mode: "configuration", connectorId: "feishu",
            configuration_url: existing.value.configurationUrl,
            expiresAt: new Date(existing.expiresAt).toISOString(), pendingId: existing.pendingId, reused: true,
          };
        }
      } catch (error) {
        if (!(error instanceof PendingStoreError)) throw error;
        this.clearCurrent(this.currentPendingId);
      }
    }

    const configResult = await this.runner.run(["config", "show"]);
    if (!configResult.ok) throw Object.assign(new Error(configResult.message), { code: configResult.reasonCode, status: 502 });
    const config = parseLarkConfigOutput(configResult.stdout);
    if (!config.ok) fail(config.reasonCode, config.message, 502);
    if (!config.value.configured) return this.startConfiguration(domains);

    const currentAuth = await this.readAuthStatus();
    if (currentAuth.state === "checking" || currentAuth.state === "unavailable") {
      fail(currentAuth.reasonCode ?? "LARK_CLI_FAILED", "飞书连接状态暂时无法确认", 502);
    }
    if (currentAuth.state === "connected" && this.domainsCovered(domains, currentAuth.scopes)) {
      fail("FEISHU_ALREADY_AUTHORIZED", "飞书已具备本次操作所需授权", 409);
    }

    const domainArg = domains.join(",");
    const deviceResult = await this.runner.run(["auth", "login", "--domain", domainArg, "--no-wait", "--json"]);
    if (!deviceResult.ok) throw Object.assign(new Error(deviceResult.message), { code: deviceResult.reasonCode, status: 502 });
    const parsed = parseLarkDeviceFlowOutput(deviceResult.stdout);
    if (!parsed.ok) fail(parsed.reasonCode, parsed.message, 502);
    const deviceCode = deviceResult[LARK_DEVICE_CODE];
    if (!deviceCode) fail("LARK_CLI_DIRTY_OUTPUT", "device flow 缺少内部 device code", 502);
    const startedAt = this.now();
    const providerExpiresAt = startedAt + parsed.value.expiresIn * 1000;
    const authExpiresAt = startedAt + AUTH_TTL_MS;
    const scope = `auth:${domains.join(",")}`;
    let resolveOutcome!: () => void;
    const outcome = new Promise<void>((resolve) => { resolveOutcome = resolve; });
    const authorizationLaunch: {
      run?: (effectiveExpiresAt: number) => void;
    } = {};
    const started = this.pending.start({
      connectorId: "feishu",
      scope,
      create: ({ pendingId, signal }) => {
        authorizationLaunch.run = (effectiveExpiresAt) => {
          void this.finishAuthorization(
            pendingId,
            scope,
            domains,
            deviceCode,
            signal,
            effectiveExpiresAt,
          ).finally(resolveOutcome);
        };
        return { mode: "authorization", domains, deviceCode, outcome };
      },
    });
    const effectiveExpiresAt = Math.min(
      providerExpiresAt,
      started.entry.expiresAt,
      authExpiresAt,
    );
    authorizationLaunch.run?.(effectiveExpiresAt);
    this.currentPendingId = started.entry.pendingId;
    this.currentScope = scope;
    return {
      mode: "authorization",
      connectorId: "feishu",
      verification_url: parsed.value.verificationUrl,
      user_code: parsed.value.userCode,
      expiresAt: new Date(effectiveExpiresAt).toISOString(),
      pendingId: started.entry.pendingId,
      reused: started.reused,
    };
  }

  private async startConfiguration(domains: LarkAuthDomain[]): Promise<FeishuStartResult> {
    const scope = "configuration";
    let resolveOutcome!: () => void;
    const outcome = new Promise<void>((resolve) => { resolveOutcome = resolve; });
    const started = this.pending.start({
      connectorId: "feishu",
      scope,
      create: () => {
        return { mode: "configuration", domains, outcome };
      },
    });
    this.currentPendingId = started.entry.pendingId;
    this.currentScope = scope;
    const background = this.runner.startConfigInit
      ? await this.runner.startConfigInit(started.entry.signal)
      : (() => {
          const completion = this.runner.run(
            ["config", "init", "--new", "--brand", "feishu", "--lang", "zh"],
            { signal: started.entry.signal, timeoutMs: CONFIG_TTL_MS },
          );
          return { initial: completion, completion };
        })();
    const result = await background.initial;
    if (!result.ok) {
      this.expirePending(started.entry.pendingId, scope, result.reasonCode);
      throw Object.assign(new Error(result.message), { code: result.reasonCode, status: 502 });
    }
    const url = extractLarkConfigInitUrl(`${result.stdout}\n${result.stderr}`);
    if (!url) {
      this.expirePending(started.entry.pendingId, scope, "LARK_CONFIG_URL_MISSING");
      fail("LARK_CONFIG_URL_MISSING", "lark-cli 未返回创建应用链接", 502);
    }
    started.entry.value.configurationUrl = url;
    void background.completion
      .then((completion) => this.finishConfiguration(started.entry.pendingId, scope, started.entry.signal, completion))
      .finally(resolveOutcome);
    return {
      mode: "configuration",
      connectorId: "feishu",
      configuration_url: url,
      expiresAt: new Date(started.entry.expiresAt).toISOString(),
      pendingId: started.entry.pendingId,
      reused: started.reused,
    };
  }

  private async finishConfiguration(pendingId: string, scope: string, signal: AbortSignal, completion: LarkCliRunResult): Promise<void> {
    if (signal.aborted) return;
    if (!completion.ok) {
      this.expirePending(pendingId, scope, completion.reasonCode);
      return;
    }
    const result = await this.runner.run(["config", "show"], { signal });
    if (signal.aborted) return;
    const parsed = result.ok ? parseLarkConfigOutput(result.stdout) : null;
    const configured = parsed?.ok === true && parsed.value.configured;
    this.terminalByPending.set(pendingId, {
      status: configured
        ? createConnectorStatus("disconnected", { reasonCode: "LARK_AUTH_MISSING", statusFreshness: "fresh", canProbe: true })
        : createConnectorStatus("unconfigured", { reasonCode: "LARK_APP_UNCONFIGURED", statusFreshness: "fresh" }),
      expiresAt: this.now() + TERMINAL_TTL_MS,
    });
    try { this.pending.complete(pendingId, "feishu", scope); } catch {}
    this.clearCurrent(pendingId);
  }

  private async finishAuthorization(
    pendingId: string,
    scope: string,
    _domains: LarkAuthDomain[],
    deviceCode: string,
    signal: AbortSignal,
    effectiveExpiresAt: number,
  ): Promise<void> {
    const generation = this.generation;
    const oldStatus = await this.readStatus();
    try {
      const timeoutMs = effectiveExpiresAt - this.now();
      if (timeoutMs <= 0) {
        throw Object.assign(new Error("飞书授权已过期"), { code: "LARK_CLI_TIMEOUT" });
      }
      const finish = await this.runner.run(
        ["auth", "login", "--device-code", deviceCode],
        { signal, timeoutMs },
      );
      if (!finish.ok) throw Object.assign(new Error(finish.message), { code: finish.reasonCode });
      const verified = await this.readStatus(signal);
      if (verified.state !== "connected") throw Object.assign(new Error("飞书 user 身份未 ready"), { code: "LARK_AUTH_NOT_READY" });
      if (signal.aborted || generation !== this.generation) return;
      this.terminalByPending.set(pendingId, { status: verified, expiresAt: this.now() + TERMINAL_TTL_MS });
    } catch (error) {
      if (signal.aborted || generation !== this.generation) return;
      const rawReasonCode = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "LARK_AUTH_FAILED";
      const reasonCode = rawReasonCode === "LARK_CLI_TIMEOUT" ? "PENDING_EXPIRED" : rawReasonCode;
      this.terminalByPending.set(pendingId, {
        status: oldStatus.state === "connected"
          ? { ...oldStatus, reasonCode }
          : createConnectorStatus("disconnected", { reasonCode, statusFreshness: "fresh", canProbe: true }),
        expiresAt: this.now() + TERMINAL_TTL_MS,
      });
    } finally {
      try { this.pending.complete(pendingId, "feishu", scope); } catch {}
      this.clearCurrent(pendingId);
    }
  }

  async probe(): Promise<ConnectorStatusDto> { return this.readStatus(); }

  async cancel(pendingId: string): Promise<ConnectorStatusDto> {
    if (this.currentPendingId !== pendingId || !this.currentScope) {
      throw new PendingStoreError("授权上下文已丢失，请重新发起", "PENDING_LOST", 410);
    }
    const scope = this.currentScope;
    this.generation += 1;
    this.pending.cancel(pendingId, "feishu", scope);
    this.terminalByPending.delete(pendingId);
    this.clearCurrent(pendingId);
    return this.readStatus();
  }

  async disconnect(): Promise<ConnectorStatusDto> {
    this.generation += 1;
    if (this.currentScope) this.pending.disconnect("feishu", this.currentScope);
    this.currentPendingId = null;
    this.currentScope = null;
    this.terminalByPending.clear();
    const result = await this.runner.run(["auth", "logout"]);
    if (!result.ok) return this.statusForFailure(result, new Date(this.now()).toISOString());
    return this.rememberStatus(createConnectorStatus("disconnected", {
      reasonCode: "USER_DISCONNECTED", lastCheckedAt: new Date(this.now()).toISOString(),
      statusFreshness: "fresh", canProbe: true, cliVersion: result.cliVersion,
    }));
  }

  private async readStatus(signal?: AbortSignal): Promise<ConnectorStatusDto> {
    const checkedAt = new Date(this.now()).toISOString();
    const configResult = await this.runner.run(["config", "show"], { signal });
    if (!configResult.ok) return this.statusForFailure(configResult, checkedAt);
    const config = parseLarkConfigOutput(configResult.stdout);
    if (!config.ok) return this.uncertainStatus(config.reasonCode, configResult.cliVersion, checkedAt);
    if (!config.value.configured) return this.rememberStatus(createConnectorStatus("unconfigured", { reasonCode: "LARK_APP_UNCONFIGURED", lastCheckedAt: checkedAt, statusFreshness: "fresh", cliVersion: configResult.cliVersion }));
    return this.readAuthStatus(signal, checkedAt);
  }

  private async readAuthStatus(signal?: AbortSignal, checkedAt = new Date(this.now()).toISOString()): Promise<ConnectorStatusDto> {
    const authResult = await this.runner.run(["auth", "status", "--json"], { signal });
    if (!authResult.ok) return this.statusForFailure(authResult, checkedAt);
    const auth = parseLarkAuthStatusOutput(authResult.stdout);
    if (!auth.ok) return this.uncertainStatus(auth.reasonCode, authResult.cliVersion, checkedAt);
    if (auth.value.connected) return this.rememberStatus(createConnectorStatus("connected", { reasonCode: auth.value.scopes === null ? "LARK_SCOPES_UNKNOWN" : null, account: auth.value.account, scopes: auth.value.scopes ?? [], lastCheckedAt: checkedAt, statusFreshness: "fresh", canProbe: true, cliVersion: authResult.cliVersion }));
    return this.rememberStatus(createConnectorStatus(auth.value.needsReauth ? "needs_reauth" : "disconnected", { reasonCode: auth.value.needsReauth ? "LARK_AUTH_EXPIRED" : "LARK_AUTH_MISSING", lastCheckedAt: checkedAt, statusFreshness: "fresh", canProbe: true, cliVersion: authResult.cliVersion }));
  }

  private rememberStatus(status: ConnectorStatusDto): ConnectorStatusDto {
    this.lastKnownStatus = status;
    return status;
  }

  private statusForFailure(
    result: Extract<LarkCliRunResult, { ok: false }>,
    checkedAt: string,
  ): ConnectorStatusDto {
    if (DEFINITIVE_UNAVAILABLE_REASONS.has(result.reasonCode)) {
      this.lastKnownStatus = null;
      return createConnectorStatus("unavailable", {
        reasonCode: result.reasonCode,
        lastCheckedAt: checkedAt,
        statusFreshness: "fresh",
        canProbe: false,
        cliVersion: result.cliVersion,
      });
    }
    return this.uncertainStatus(result.reasonCode, result.cliVersion, checkedAt);
  }

  private uncertainStatus(
    reasonCode: string,
    cliVersion: string | null,
    checkedAt: string,
  ): ConnectorStatusDto {
    if (this.lastKnownStatus) {
      return {
        ...this.lastKnownStatus,
        reasonCode,
        statusFreshness: "stale",
        cliVersion: cliVersion ?? this.lastKnownStatus.cliVersion,
      };
    }
    return createConnectorStatus("checking", {
      reasonCode,
      lastCheckedAt: checkedAt,
      statusFreshness: "unknown",
      canProbe: false,
      cliVersion,
    });
  }

  private domainsCovered(domains: LarkAuthDomain[], scopes: string[]): boolean {
    return domains.every((domain) => scopes.some((scope) =>
      scope === domain || scope.startsWith(`${domain}:`) ||
      (domain === "wiki" && (scope.startsWith("wiki:") || scope.startsWith("docs:"))) ||
      (domain === "docs" && (scope.startsWith("docs:") || scope.startsWith("wiki:"))),
    ));
  }

  private validateDomains(input: { domains?: LarkAuthDomain[] }): LarkAuthDomain[] {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => key !== "domains")) fail("INVALID_ARGUMENT", "飞书 start 参数非法");
    if (!Array.isArray(input.domains) || input.domains.length === 0) fail("INVALID_ARGUMENT", "至少选择一个飞书授权域");
    const requested = new Set(input.domains);
    if ([...requested].some((domain) => !(LARK_AUTH_DOMAINS as readonly string[]).includes(domain))) fail("INVALID_ARGUMENT", "飞书授权域非法");
    return LARK_AUTH_DOMAINS.filter((domain) => requested.has(domain));
  }

  private expirePending(pendingId: string, scope: string, reasonCode: string): void {
    try { this.pending.complete(pendingId, "feishu", scope); } catch {}
    this.terminalByPending.set(pendingId, { status: createConnectorStatus("unconfigured", { reasonCode, statusFreshness: "fresh" }), expiresAt: this.now() + TERMINAL_TTL_MS });
    this.clearCurrent(pendingId);
  }

  private clearCurrent(pendingId: string): void {
    if (this.currentPendingId === pendingId) { this.currentPendingId = null; this.currentScope = null; }
  }
}
