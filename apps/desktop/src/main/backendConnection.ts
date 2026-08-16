import {
  ATTACH_CAPABILITY_NAMES,
  ATTACH_MODEL_OVERRIDE_HEADERS,
  ATTACH_MUST_ENABLE_CAPABILITIES,
  DESKTOP_ATTACH_CAPABILITIES,
  type AttachCapabilities,
  type AttachHandshakeResponse,
  type AttachIdentity,
} from "@qingagent/contract-ts";
import type {
  BackendConnectionSnapshot,
  BackendMode,
} from "../backendConnectionContract.js";
import type { DiscoveredInstance } from "./attachDiscoveryTypes.js";
import {
  createNodeHttpProxyFetch,
  type UpstreamBodyOutcome,
} from "./desktopAppProxyFetch.js";
import { isDesktopCommandMutationPath } from "./desktopCommandAuth.js";

const DATA_REQUEST_QUEUE_LIMIT = 32;
const RENEW_EARLY_MS = 5 * 60 * 1_000;
const ATTACH_IDLE_TTL_MS = 2 * 60 * 60 * 1_000;
const REAUTH_RECOVERY_BUDGET_MS = 30_000;
const REAUTH_REDISCOVERY_INITIAL_BACKOFF_MS = 1_000;
const REAUTH_REDISCOVERY_MAX_BACKOFF_MS = 8_000;
const REDISCOVERY_RATE_WINDOW_MS = 30_000;
const REDISCOVERY_RATE_LIMIT = 8;

export type BackendConnectionListener = (snapshot: BackendConnectionSnapshot) => void;

export interface BackendConnection {
  readonly mode: BackendMode;
  snapshot(): BackendConnectionSnapshot;
  subscribe(listener: BackendConnectionListener): () => void;
  forwardDataRequest(request: Request): Promise<Response>;
  probe(): Promise<boolean>;
  resolveQingjianSession(engineSessionId: string): Promise<"found" | "not-found" | "unavailable">;
  retry(): Promise<void>;
  dispose(): void;
}

export interface EmbeddedBackendInfo extends AttachIdentity {
  commandAuthToken: string;
  externalAuthToken: string;
}

export interface AttachBackendOptions {
  fetchImpl?: typeof fetch;
  dataProxyFetch?: (request: Request) => Promise<Response>;
  rediscover?: (libraryId: string) => Promise<AttachRediscoveryResult>;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

export type AttachRediscoveryResult =
  | DiscoveredInstance
  | { errorCode: "STARTING_LEASE" }
  | null;

export class AttachConnectionError extends Error {
  constructor(
    readonly code: "AUTH_FAILED" | "INCOMPATIBLE" | "CONFLICT" | "UNREACHABLE" | "MALFORMED",
    readonly status: number | null = null,
  ) {
    super(`attach connection failed: ${code}`);
    this.name = "AttachConnectionError";
  }
}

function allCapabilities(value: boolean): AttachCapabilities {
  return Object.fromEntries(
    ATTACH_CAPABILITY_NAMES.map((name) => [name, value]),
  ) as AttachCapabilities;
}

function identityMatches(actual: AttachIdentity, expected: AttachIdentity): boolean {
  return actual.schemaVersion === expected.schemaVersion
    && actual.port === expected.port
    && actual.pid === expected.pid
    && actual.version === expected.version
    && actual.attachProtocolVersion === expected.attachProtocolVersion
    && actual.instanceId === expected.instanceId
    && actual.libraryId === expected.libraryId
    && actual.startedAt === expected.startedAt;
}

function isAttachCapabilities(value: unknown): value is AttachCapabilities {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return ATTACH_CAPABILITY_NAMES.every((name) => typeof record[name] === "boolean");
}

function parseHandshakeResponse(value: unknown): AttachHandshakeResponse {
  if (!value || typeof value !== "object") throw new AttachConnectionError("MALFORMED");
  const response = value as Partial<AttachHandshakeResponse>;
  if (
    response.schemaVersion !== 2
    || !Number.isInteger(response.port)
    || !Number.isInteger(response.pid)
    || typeof response.version !== "string"
    || !Number.isInteger(response.attachProtocolVersion)
    || typeof response.instanceId !== "string"
    || typeof response.libraryId !== "string"
    || typeof response.startedAt !== "string"
    || typeof response.attachSessionToken !== "string"
    || !/^qa_attach_[0-9a-f]{64}$/i.test(response.attachSessionToken)
    || typeof response.absoluteExpiresAt !== "string"
    || !Number.isFinite(Date.parse(response.absoluteExpiresAt))
    || typeof response.idleExpiresAt !== "string"
    || !Number.isFinite(Date.parse(response.idleExpiresAt))
    || !isAttachCapabilities(response.serverCapabilities)
    || !isAttachCapabilities(response.effectiveCapabilities)
  ) throw new AttachConnectionError("MALFORMED");
  return response as AttachHandshakeResponse;
}

export async function handshakeAttachInstance(
  instance: DiscoveredInstance,
  fetchImpl: typeof fetch = fetch,
): Promise<AttachHandshakeResponse> {
  let response: Response;
  try {
    response = await fetchImpl(`${instance.endpoint}/api/v1/attach/handshake`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${instance.token}`,
        "Content-Type": "application/json",
        Origin: instance.endpoint,
      },
      body: JSON.stringify({ desktopCapabilities: DESKTOP_ATTACH_CAPABILITIES }),
      signal: AbortSignal.timeout(2_000),
    });
  } catch {
    throw new AttachConnectionError("UNREACHABLE");
  }
  if (response.status === 401 || response.status === 403) {
    throw new AttachConnectionError("AUTH_FAILED", response.status);
  }
  if (!response.ok) throw new AttachConnectionError("UNREACHABLE");
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AttachConnectionError("MALFORMED");
  }
  const handshake = parseHandshakeResponse(payload);
  if (!identityMatches(handshake, instance)) throw new AttachConnectionError("CONFLICT");
  if (ATTACH_MUST_ENABLE_CAPABILITIES.some((name) => handshake.effectiveCapabilities[name] !== true)) {
    throw new AttachConnectionError("INCOMPATIBLE");
  }
  for (const name of ATTACH_CAPABILITY_NAMES) {
    if (handshake.effectiveCapabilities[name] && !DESKTOP_ATTACH_CAPABILITIES[name]) {
      throw new AttachConnectionError("INCOMPATIBLE");
    }
  }
  return handshake;
}

function targetRequest(
  request: Request,
  endpoint: string,
  bearer: string | null,
  stripRendererCredentials: boolean,
): Request {
  const source = new URL(request.url);
  const target = new URL(endpoint);
  target.pathname = source.pathname;
  target.search = source.search;
  const headers = new Headers(request.headers);
  headers.delete("host");
  if (stripRendererCredentials) {
    headers.delete("cookie");
    headers.delete("authorization");
    for (const name of ATTACH_MODEL_OVERRIDE_HEADERS) headers.delete(name);
  }
  headers.set("origin", endpoint);
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    signal: request.signal,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }
  return new Request(target, init);
}

function typedUnavailable(code: string, status = 503): Response {
  return Response.json({ error: { code, message: "后台连接暂时不可用" } }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function waitForPromiseOrAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("请求已取消", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      finish(() => reject(signal.reason ?? new DOMException("请求已取消", "AbortError")));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

abstract class BaseBackendConnection implements BackendConnection {
  abstract readonly mode: BackendMode;
  protected listeners = new Set<BackendConnectionListener>();
  protected current!: BackendConnectionSnapshot;

  snapshot(): BackendConnectionSnapshot {
    return {
      ...this.current,
      effectiveCapabilities: { ...this.current.effectiveCapabilities },
    };
  }

  subscribe(listener: BackendConnectionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  protected publish(next: Partial<BackendConnectionSnapshot>): void {
    this.current = { ...this.current, ...next };
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  abstract forwardDataRequest(request: Request): Promise<Response>;
  abstract probe(): Promise<boolean>;
  abstract resolveQingjianSession(engineSessionId: string): Promise<"found" | "not-found" | "unavailable">;
  abstract retry(): Promise<void>;
  dispose(): void {
    this.listeners.clear();
  }
}

export class EmbeddedBackendConnection extends BaseBackendConnection {
  readonly mode = "embedded" as const;
  #proxyFetch = createNodeHttpProxyFetch();
  #info: EmbeddedBackendInfo;

  constructor(info: EmbeddedBackendInfo) {
    super();
    this.#info = info;
    this.current = {
      mode: "embedded",
      status: "attached",
      generation: 0,
      libraryId: info.libraryId,
      instanceId: info.instanceId,
      effectiveCapabilities: allCapabilities(true),
      errorCode: null,
      conflictKind: null,
    };
  }

  async forwardDataRequest(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (this.current.status === "conflict" && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      return typedUnavailable("LIBRARY_CONFLICT", 409);
    }
    const token = request.method === "POST" && isDesktopCommandMutationPath(pathname)
      ? this.#info.commandAuthToken
      : pathname.startsWith("/api/v1/external/")
        ? this.#info.externalAuthToken
        : null;
    return this.#proxyFetch(targetRequest(
      request,
      `http://127.0.0.1:${this.#info.port}`,
      token,
      false,
    ));
  }

  async probe(): Promise<boolean> {
    try {
      return (await fetch(`http://127.0.0.1:${this.#info.port}/health`, {
        method: "HEAD",
        signal: AbortSignal.timeout(2_000),
      })).ok;
    } catch {
      return false;
    }
  }

  async resolveQingjianSession(engineSessionId: string): Promise<"found" | "not-found" | "unavailable"> {
    try {
      const response = await fetch(
        `http://127.0.0.1:${this.#info.port}/api/v1/external/sessions/${encodeURIComponent(engineSessionId)}/doc?format=pm`,
        {
          method: "HEAD",
          headers: { Authorization: `Bearer ${this.#info.externalAuthToken}` },
          signal: AbortSignal.timeout(2_000),
        },
      );
      if (response.status === 404) return "not-found";
      return response.ok ? "found" : "unavailable";
    } catch {
      return "unavailable";
    }
  }

  reportForeignDiscovery(input: { pending: boolean; conflicting: boolean }): void {
    if (input.conflicting) {
      this.publish({ status: "conflict", errorCode: "CONFLICT", conflictKind: "conflict" });
    } else if (input.pending) {
      this.publish({ errorCode: "CONFLICT", conflictKind: "pending-conflict" });
    } else if (this.current.conflictKind === "pending-conflict") {
      this.publish({ errorCode: null, conflictKind: null });
    }
  }

  async retry(): Promise<void> {
    // embedded 的后台生命周期仍由现有进程管理；这里只清除已失效的 pending 提示。
    if (this.current.conflictKind === "pending-conflict") {
      this.publish({ errorCode: null, conflictKind: null });
    }
  }
}

export class AttachBackendConnection extends BaseBackendConnection {
  readonly mode = "attach" as const;
  #instance: DiscoveredInstance;
  #sessionToken: string;
  #absoluteExpiresAtMs: number;
  #idleExpiresAtMs: number;
  #fetchImpl: typeof fetch;
  #rediscover?: (libraryId: string) => Promise<AttachRediscoveryResult>;
  #now: () => number;
  #sleep?: (delayMs: number) => Promise<void>;
  #rediscoveryStartedAtMs: number[] = [];
  #renewTimer: ReturnType<typeof setTimeout> | null = null;
  #recoveryFlight: Promise<void> | null = null;
  #queuedReads = 0;
  #proxyFetch: (request: Request) => Promise<Response>;
  #disposed = false;
  #disposeController = new AbortController();

  constructor(
    instance: DiscoveredInstance,
    handshake: AttachHandshakeResponse,
    options: AttachBackendOptions = {},
  ) {
    super();
    this.#instance = instance;
    this.#sessionToken = handshake.attachSessionToken;
    this.#absoluteExpiresAtMs = Date.parse(handshake.absoluteExpiresAt);
    this.#idleExpiresAtMs = Date.parse(handshake.idleExpiresAt);
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#rediscover = options.rediscover;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep;
    this.current = {
      mode: "attach",
      status: "attached",
      generation: 0,
      libraryId: handshake.libraryId,
      instanceId: handshake.instanceId,
      effectiveCapabilities: { ...handshake.effectiveCapabilities },
      errorCode: null,
      conflictKind: null,
    };
    this.#proxyFetch = options.dataProxyFetch ?? createNodeHttpProxyFetch({
      onResponseBodyFinished: (_request, outcome) => this.#handleBodyOutcome(outcome),
    });
    this.#scheduleRenewal();
  }

  async forwardDataRequest(request: Request): Promise<Response> {
    if (this.current.status === "revalidating" || this.current.status === "reauthenticating") {
      if (!isReadMethod(request.method)) return typedUnavailable("BACKEND_RECONNECTING");
      if (!this.#recoveryFlight || this.#queuedReads >= DATA_REQUEST_QUEUE_LIMIT) {
        return typedUnavailable("BACKEND_READ_QUEUE_FULL");
      }
      this.#queuedReads += 1;
      try {
        await waitForPromiseOrAbort(this.#recoveryFlight, request.signal);
      } catch {
        return typedUnavailable("BACKEND_UNAVAILABLE");
      } finally {
        this.#queuedReads -= 1;
      }
    }
    if (this.current.status !== "attached") {
      return typedUnavailable(
        this.current.status === "conflict" ? "LIBRARY_CONFLICT" : "BACKEND_UNAVAILABLE",
        this.current.status === "conflict" ? 409 : 503,
      );
    }

    const upstreamRequest = targetRequest(
      request,
      this.#instance.endpoint,
      this.#sessionToken,
      true,
    );
    let response: Response;
    try {
      response = await this.#proxyFetch(upstreamRequest);
    } catch {
      this.#startRevalidate("TRANSPORT_FAILURE");
      return typedUnavailable(isReadMethod(request.method) ? "BACKEND_RECONNECTING" : "WRITE_RESULT_UNKNOWN");
    }
    this.#touchIdleExpiry();
    if (response.status === 401) {
      const code = await response.clone().json().then((body: unknown) => {
        if (!body || typeof body !== "object") return null;
        const error = (body as { error?: unknown }).error;
        return error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : null;
      }).catch(() => null);
      if (code === "ATTACH_SESSION_EXPIRED") this.#startReauthenticate();
      else if (code === "INSTANCE_AUTH_FAILED") {
        this.#clearRenewal();
        this.publish({ status: "dead", errorCode: "INSTANCE_AUTH_FAILED" });
      }
    }
    return response;
  }

  async probe(): Promise<boolean> {
    const result = await this.#probeIdentity();
    return result === "ok";
  }

  async resolveQingjianSession(engineSessionId: string): Promise<"found" | "not-found" | "unavailable"> {
    try {
      const response = await this.#fetchImpl(
        `${this.#instance.endpoint}/api/v1/external/sessions/${encodeURIComponent(engineSessionId)}/doc?format=pm`,
        {
          method: "HEAD",
          headers: { Authorization: `Bearer ${this.#instance.token}` },
          signal: AbortSignal.timeout(2_000),
        },
      );
      if (response.status === 404) return "not-found";
      return response.ok ? "found" : "unavailable";
    } catch {
      return "unavailable";
    }
  }

  async retry(): Promise<void> {
    if (this.#disposed || !["dead", "incompatible", "conflict"].includes(this.current.status)) return;
    this.#clearRenewal();
    this.publish({
      status: "connecting",
      generation: this.current.generation + 1,
      errorCode: null,
      conflictKind: null,
    });
    if (this.#rediscover && this.current.libraryId) {
      // 用户显式重试不受自动自愈限频窗口约束。
      this.#rediscoveryStartedAtMs = [];
      let next: AttachRediscoveryResult;
      try {
        next = await waitForPromiseOrAbort(
          this.#runRediscovery(),
          this.#disposeController.signal,
        );
      } catch (error) {
        if (this.#disposed) return;
        throw error;
      }
      if (this.#disposed) return;
      if (isDiscoveredInstance(next)) this.#instance = next;
    }
    await this.#authenticate("authenticating");
  }

  override dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#disposeController.abort();
    this.#clearRenewal();
    this.#sessionToken = "";
    super.dispose();
  }

  #handleBodyOutcome(outcome: UpstreamBodyOutcome): void {
    if (outcome === "upstream-abort") this.#startRevalidate("UPSTREAM_ABORT");
  }

  #startRevalidate(errorCode: string): void {
    if (this.#disposed || this.current.status !== "attached" || this.#recoveryFlight) return;
    this.publish({ status: "revalidating", errorCode });
    const operation = (async () => {
      const result = await this.#probeIdentity();
      if (this.#disposed) return;
      if (result === "ok") this.publish({ status: "attached", errorCode: null });
      else if (result === "conflict") {
        this.#clearRenewal();
        this.publish({ status: "conflict", errorCode: "CONFLICT", conflictKind: "conflict" });
      } else {
        this.#clearRenewal();
        this.publish({ status: "dead", errorCode: "UNREACHABLE" });
      }
    })();
    const flight = operation.finally(() => {
      if (this.#recoveryFlight === flight) this.#recoveryFlight = null;
    });
    this.#recoveryFlight = flight;
  }

  #startReauthenticate(visible = true): void {
    if (this.#disposed || this.current.status !== "attached" || this.#recoveryFlight) return;
    const operation = this.#authenticate("reauthenticating", visible);
    const flight = operation.finally(() => {
      if (this.#recoveryFlight === flight) this.#recoveryFlight = null;
    });
    this.#recoveryFlight = flight;
  }

  async #authenticate(
    status: "authenticating" | "reauthenticating",
    publishPending = true,
  ): Promise<void> {
    if (this.#disposed) return;
    if (publishPending) this.publish({ status, errorCode: null });
    try {
      const handshake = await waitForPromiseOrAbort(
        handshakeAttachInstance(this.#instance, this.#fetchImpl),
        this.#disposeController.signal,
      );
      this.#applyHandshake(handshake);
    } catch (error) {
      if (this.#disposed) return;
      if (
        status === "reauthenticating"
        && error instanceof AttachConnectionError
        && error.code === "AUTH_FAILED"
        && error.status === 401
      ) {
        if (!publishPending) this.publish({ status: "reauthenticating", errorCode: null });
        await this.#recoverRestartedInstance();
        return;
      }
      this.#publishAuthenticationFailure(error);
    }
  }

  #applyHandshake(handshake: AttachHandshakeResponse, recovered = false): void {
    if (this.#disposed) return;
    if (this.current.libraryId && handshake.libraryId !== this.current.libraryId) {
      this.#clearRenewal();
      this.publish({ status: "conflict", errorCode: "CONFLICT", conflictKind: "conflict" });
      return;
    }
    this.#rediscoveryStartedAtMs = [];
    this.#sessionToken = handshake.attachSessionToken;
    this.#absoluteExpiresAtMs = Date.parse(handshake.absoluteExpiresAt);
    this.#idleExpiresAtMs = Date.parse(handshake.idleExpiresAt);
    this.publish({
      status: "attached",
      generation: recovered ? this.current.generation + 1 : this.current.generation,
      libraryId: handshake.libraryId,
      instanceId: handshake.instanceId,
      effectiveCapabilities: { ...handshake.effectiveCapabilities },
      errorCode: null,
      conflictKind: null,
    });
    this.#scheduleRenewal();
  }

  #publishAuthenticationFailure(error: unknown): void {
    if (this.#disposed) return;
    this.#clearRenewal();
    const code = error instanceof AttachConnectionError ? error.code : "UNREACHABLE";
    this.publish({
      status: code === "INCOMPATIBLE" ? "incompatible" : code === "CONFLICT" ? "conflict" : "dead",
      errorCode: code,
      conflictKind: code === "CONFLICT" ? "conflict" : null,
    });
  }

  async #recoverRestartedInstance(): Promise<void> {
    try {
      await this.#recoverRestartedInstanceWithinBudget();
    } catch {
      if (this.#disposed) return;
      this.#publishAuthenticationFailure(new AttachConnectionError("AUTH_FAILED", 401));
    }
  }

  async #recoverRestartedInstanceWithinBudget(): Promise<void> {
    if (this.#disposed) return;
    if (!this.#rediscover || !this.current.libraryId) {
      this.#publishAuthenticationFailure(new AttachConnectionError("AUTH_FAILED", 401));
      return;
    }
    const recoveryStartedAtMs = this.#now();
    const deadlineMs = recoveryStartedAtMs + REAUTH_RECOVERY_BUDGET_MS;
    const previousInstanceId = this.#instance.instanceId;
    let backoffMs = REAUTH_REDISCOVERY_INITIAL_BACKOFF_MS;

    while (!this.#disposed && this.#now() < deadlineMs) {
      const rateLimitDelayMs = this.#rediscoveryRateLimitDelayMs();
      if (rateLimitDelayMs > 0) {
        const canRetry = await this.#sleepWithinRecoveryBudget(
          Math.max(backoffMs, rateLimitDelayMs),
          deadlineMs,
        );
        if (!canRetry) break;
        backoffMs = Math.min(backoffMs * 2, REAUTH_REDISCOVERY_MAX_BACKOFF_MS);
        continue;
      }

      const discovered = await waitForPromiseOrAbort(
        this.#runRediscovery(),
        this.#disposeController.signal,
      ).catch(() => null);
      if (this.#disposed) return;
      if (isDiscoveredInstance(discovered)) {
        this.#instance = discovered;
        try {
          const handshake = await waitForPromiseOrAbort(
            handshakeAttachInstance(discovered, this.#fetchImpl),
            this.#disposeController.signal,
          );
          if (this.#disposed) return;
          this.#applyHandshake(handshake, true);
          return;
        } catch (error) {
          if (this.#disposed) return;
          if (
            error instanceof AttachConnectionError
            && (
              error.code === "UNREACHABLE"
              || error.code === "MALFORMED"
              || (
                error.code === "AUTH_FAILED"
                && error.status === 401
                && discovered.instanceId !== previousInstanceId
              )
            )
          ) {
            const canRetry = await this.#sleepBeforeNextRediscovery(backoffMs, deadlineMs);
            if (!canRetry) break;
            backoffMs = Math.min(backoffMs * 2, REAUTH_REDISCOVERY_MAX_BACKOFF_MS);
            continue;
          }
          this.#publishAuthenticationFailure(error);
          return;
        }
      }
      if (
        discovered?.errorCode === "STARTING_LEASE"
        && this.current.errorCode !== "STARTING_LEASE"
      ) {
        this.publish({ errorCode: "STARTING_LEASE" });
      }

      const canRetry = await this.#sleepBeforeNextRediscovery(backoffMs, deadlineMs);
      if (!canRetry) break;
      backoffMs = Math.min(backoffMs * 2, REAUTH_REDISCOVERY_MAX_BACKOFF_MS);
    }

    if (this.#disposed) return;
    this.#publishAuthenticationFailure(new AttachConnectionError("AUTH_FAILED", 401));
  }

  async #sleepBeforeNextRediscovery(backoffMs: number, deadlineMs: number): Promise<boolean> {
    const delayMs = Math.max(backoffMs, this.#rediscoveryRateLimitDelayMs());
    return this.#sleepWithinRecoveryBudget(delayMs, deadlineMs);
  }

  async #sleepWithinRecoveryBudget(delayMs: number, deadlineMs: number): Promise<boolean> {
    const remainingMs = deadlineMs - this.#now();
    if (this.#disposed || remainingMs <= 0 || delayMs >= remainingMs) return false;
    if (this.#sleep) {
      try {
        await waitForPromiseOrAbort(this.#sleep(delayMs), this.#disposeController.signal);
      } catch (error) {
        if (!this.#disposed) throw error;
      }
      return !this.#disposed;
    }
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (timer) clearTimeout(timer);
        this.#disposeController.signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => finish();
      this.#disposeController.signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => finish(), delayMs);
    });
    return !this.#disposed;
  }

  #rediscoveryRateLimitDelayMs(): number {
    const nowMs = this.#now();
    this.#rediscoveryStartedAtMs = this.#rediscoveryStartedAtMs.filter(
      (startedAtMs) => nowMs - startedAtMs < REDISCOVERY_RATE_WINDOW_MS,
    );
    if (this.#rediscoveryStartedAtMs.length < REDISCOVERY_RATE_LIMIT) return 0;
    return Math.max(
      1,
      this.#rediscoveryStartedAtMs[0]! + REDISCOVERY_RATE_WINDOW_MS - nowMs,
    );
  }

  async #runRediscovery(): Promise<AttachRediscoveryResult> {
    if (this.#disposed || !this.#rediscover || !this.current.libraryId) return null;
    const delayMs = this.#rediscoveryRateLimitDelayMs();
    if (delayMs > 0) return null;
    this.#rediscoveryStartedAtMs.push(this.#now());
    return this.#rediscover(this.current.libraryId);
  }

  async #probeIdentity(): Promise<"ok" | "dead" | "conflict"> {
    try {
      const response = await this.#fetchImpl(`${this.#instance.endpoint}/api/v1/external/health`, {
        headers: { Authorization: `Bearer ${this.#instance.token}` },
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) return "dead";
      const body = await response.json() as AttachIdentity;
      return identityMatches(body, this.#instance) ? "ok" : "conflict";
    } catch {
      return "dead";
    }
  }

  #touchIdleExpiry(): void {
    if (this.#disposed) return;
    this.#idleExpiresAtMs = Math.min(
      this.#absoluteExpiresAtMs,
      this.#now() + ATTACH_IDLE_TTL_MS,
    );
    this.#scheduleRenewal();
  }

  #scheduleRenewal(): void {
    this.#clearRenewal();
    if (this.#disposed || this.current.status !== "attached") return;
    const renewAt = Math.min(this.#absoluteExpiresAtMs, this.#idleExpiresAtMs) - RENEW_EARLY_MS;
    const delay = Math.max(1_000, renewAt - this.#now());
    this.#renewTimer = setTimeout(() => {
      this.#renewTimer = null;
      this.#startReauthenticate(false);
    }, delay);
    this.#renewTimer.unref?.();
  }

  #clearRenewal(): void {
    if (this.#renewTimer) clearTimeout(this.#renewTimer);
    this.#renewTimer = null;
  }
}

function isReadMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function isDiscoveredInstance(
  result: AttachRediscoveryResult,
): result is DiscoveredInstance {
  return result !== null && "instanceId" in result;
}

export async function connectAttachBackend(
  instance: DiscoveredInstance,
  options: AttachBackendOptions = {},
): Promise<AttachBackendConnection> {
  const handshake = await handshakeAttachInstance(instance, options.fetchImpl ?? fetch);
  return new AttachBackendConnection(instance, handshake, options);
}

export async function resolveQingjianDeepLink(
  backend: Pick<BackendConnection, "mode" | "resolveQingjianSession">,
  engineSessionId: string,
): Promise<{ mode: BackendMode; result: "found" | "not-found" | "unavailable" }> {
  return {
    mode: backend.mode,
    result: await backend.resolveQingjianSession(engineSessionId),
  };
}
