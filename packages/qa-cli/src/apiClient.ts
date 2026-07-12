import { discoverInstance, type InstanceInfo } from "./discovery.js";
import { QaCliError } from "./errors.js";
import type {
  ExternalChatSendRequest,
  ExternalChatSendResponse,
  ExternalErrorResponse,
  ExternalProposalRequest,
  ExternalProposalResponse,
  ExternalSuccessResponse,
} from "./generated/externalApi.js";

export class ApiClient {
  private constructor(private readonly instance: InstanceInfo) {}

  static async create(): Promise<ApiClient> {
    return new ApiClient(await discoverInstance());
  }

  async request<T extends ExternalSuccessResponse>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`http://127.0.0.1:${this.instance.port}/api/v1/external${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.instance.token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    const json = parseJsonResponse(text);
    if (!res.ok) {
      const body = json as Partial<ExternalErrorResponse> | null;
      if (body && typeof body === "object") {
        throw new QaCliError(body.code ?? "VALIDATION", body.error ?? res.statusText, body);
      }
      throw new QaCliError("VALIDATION", compactErrorText(text, res.statusText));
    }
    return json as T;
  }

  async propose(sessionId: string, body: ExternalProposalRequest): Promise<ExternalProposalResponse> {
    return this.request<ExternalProposalResponse>(`/sessions/${encodeURIComponent(sessionId)}/proposals`, {
      method: "POST",
      headers: { "X-QA-Client": detectQaClient(process.env) },
      body: JSON.stringify(body),
    });
  }

  // chat send 与 propose 一样代用户操作,同样带上调用方身份头,
  // 服务端据此把来源编进消息 id(external-<client>-<uuid>),前端展示"代你发送了一条消息"。
  async chat(sessionId: string, body: ExternalChatSendRequest): Promise<ExternalChatSendResponse> {
    return this.request<ExternalChatSendResponse>(`/sessions/${encodeURIComponent(sessionId)}/chat`, {
      method: "POST",
      headers: { "X-QA-Client": detectQaClient(process.env) },
      body: JSON.stringify(body),
    });
  }

  eventsUrl(sessionId: string, after?: string): string {
    const query = after ? `?after=${encodeURIComponent(after)}` : "";
    return `http://127.0.0.1:${this.instance.port}/api/v1/external/sessions/${encodeURIComponent(sessionId)}/events${query}`;
  }

  authHeader(): string {
    return `Bearer ${this.instance.token}`;
  }
}

export function detectQaClient(env: NodeJS.ProcessEnv): "claudecode" | "codex" | "agent" {
  if (env.CLAUDECODE || env.AI_AGENT?.startsWith("claude-code")) return "claudecode";
  if (Object.keys(env).some((key) => key.startsWith("CODEX_"))) return "codex";
  return "agent";
}

function parseJsonResponse(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function compactErrorText(text: string, fallback: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return fallback;
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}...` : trimmed;
}
