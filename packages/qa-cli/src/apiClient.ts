import { discoverInstance, type InstanceInfo } from "./discovery.js";
import { QaCliError, type QaErrorCode } from "./errors.js";

export class ApiClient {
  private constructor(private readonly instance: InstanceInfo) {}

  static async create(): Promise<ApiClient> {
    return new ApiClient(await discoverInstance());
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`http://127.0.0.1:${this.instance.port}/api/v1/external${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.instance.token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) as unknown : null;
    if (!res.ok) {
      const body = json as { code?: QaErrorCode; error?: string } | null;
      throw new QaCliError(body?.code ?? "VALIDATION", body?.error ?? res.statusText, body);
    }
    return json as T;
  }

  eventsUrl(sessionId: string): string {
    return `http://127.0.0.1:${this.instance.port}/api/v1/external/sessions/${encodeURIComponent(sessionId)}/events`;
  }

  authHeader(): string {
    return `Bearer ${this.instance.token}`;
  }
}
