import { GithubConnectorError } from "./githubErrors.js";

export interface GithubDeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval?: number;
}

export interface GithubToken {
  access_token: string;
  token_type: string;
  scope: string;
}

export interface GithubAuthOptions {
  clientId: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const abort = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    reject(new DOMException("Aborted", "AbortError"));
  };
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", abort);
    resolve();
  }, ms);
  if (signal.aborted) {
    abort();
    return;
  }
  signal.addEventListener("abort", abort, { once: true });
});

export class GithubDeviceAuth {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private readonly sleepImpl: NonNullable<GithubAuthOptions["sleep"]>;
  constructor(private readonly options: GithubAuthOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.baseUrl = (options.baseUrl ?? "https://github.com").replace(/\/$/, "");
    this.sleepImpl = options.sleep ?? sleep;
  }

  async start(scope: string, signal?: AbortSignal): Promise<GithubDeviceCode> {
    const response = await this.fetchImpl(`${this.baseUrl}/login/device/code`, {
      method: "POST", signal,
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "QingAgent-Connector/1.0" },
      body: new URLSearchParams({ client_id: this.options.clientId, scope }),
    });
    const data = await this.json(response);
    if (!response.ok || typeof data.device_code !== "string" || typeof data.user_code !== "string" || typeof data.verification_uri !== "string") {
      throw new GithubConnectorError("GitHub device code 响应非法", "INVALID_RESPONSE", 502);
    }
    return data as unknown as GithubDeviceCode;
  }

  async poll(deviceCode: string, initialInterval: number, expiresAt: number, signal: AbortSignal): Promise<GithubToken> {
    let interval = Math.max(1, initialInterval) * 1000;
    while (Date.now() < expiresAt) {
      await this.sleepImpl(interval, signal);
      const response = await this.fetchImpl(`${this.baseUrl}/login/oauth/access_token`, {
        method: "POST", signal,
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "QingAgent-Connector/1.0" },
        body: new URLSearchParams({ client_id: this.options.clientId, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
      });
      const data = await this.json(response);
      if (typeof data.access_token === "string") return data as unknown as GithubToken;
      switch (data.error) {
        case "authorization_pending": break;
        case "slow_down": interval += 5_000; break;
        case "access_denied": throw new GithubConnectorError("用户拒绝了 GitHub 授权", "ACCESS_DENIED", 403);
        case "expired_token": throw new GithubConnectorError("GitHub 授权码已过期", "PENDING_EXPIRED", 410);
        default: throw new GithubConnectorError("GitHub token 响应非法", "INVALID_RESPONSE", 502);
      }
    }
    throw new GithubConnectorError("GitHub 授权码已过期", "PENDING_EXPIRED", 410);
  }

  private async json(response: Response): Promise<Record<string, unknown>> {
    try { return await response.json() as Record<string, unknown>; }
    catch { throw new GithubConnectorError("GitHub OAuth 返回了畸形 JSON", "INVALID_RESPONSE", 502); }
  }
}
