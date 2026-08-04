import { discoverInstance, type InstanceInfo } from "./discovery.js";
import { QaCliError } from "./errors.js";
import { createRequestDeadline } from "./requestDeadline.js";
import type {
  ExternalAnnotationIgnoreRequest,
  ExternalAnnotationIgnoreResponse,
  ExternalChatSendRequest,
  ExternalChatSendResponse,
  ExternalErrorResponse,
  ExternalProposalRequest,
  ExternalProposalResponse,
  ExternalReviewCommitRequest,
  ExternalReviewCommitResponse,
  ExternalReviewVerdictRequest,
  ExternalReviewVerdictResponse,
  ExternalSuccessResponse,
} from "./generated/externalApi.js";

export class ApiClient {
  private constructor(private readonly instance: InstanceInfo) {}

  static async create(): Promise<ApiClient> {
    return new ApiClient(await discoverInstance());
  }

  async request<T extends ExternalSuccessResponse>(path: string, init: RequestInit = {}): Promise<T> {
    const deadline = createRequestDeadline(init.signal, API_REQUEST_DEADLINE_MS);
    try {
      let res: Response;
      try {
        res = await fetchWithRateLimitRetry(
          `http://127.0.0.1:${this.instance.port}/api/v1/external${path}`,
          {
            ...init,
            signal: deadline.signal,
            headers: {
              Authorization: `Bearer ${this.instance.token}`,
              ...(init.body ? { "Content-Type": "application/json" } : {}),
              ...(init.method && init.method !== "GET"
                ? { "X-QA-Client": detectQaClient(process.env) }
                : {}),
              ...(init.headers ?? {}),
            },
          },
        );
      } catch {
        throw new QaCliError(
          "NO_INSTANCE",
          deadline.timedOut() ? "实例请求超时" : "实例不可达",
        );
      }
      await this.assertResponseOk(res);
      let text: string;
      try {
        text = await res.text();
      } catch {
        throw new QaCliError("INVALID_RESPONSE", "实例响应读取失败", { endpoint: path });
      }
      return parseSuccessResponse<T>(text, path);
    } finally {
      deadline.dispose();
    }
  }

  async openEvents(sessionId: string, after: string | undefined, signal: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await fetchWithRateLimitRetry(this.eventsUrl(sessionId, after), {
        headers: { Authorization: this.authHeader() },
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
      throw new QaCliError("NO_INSTANCE", `实例不可达${detail}`);
    }
    await this.assertResponseOk(response);
    if (!response.body) throw new QaCliError("NO_INSTANCE", "实例不可达: events 响应缺少数据流");
    return response;
  }

  async propose(sessionId: string, body: ExternalProposalRequest): Promise<ExternalProposalResponse> {
    return this.request<ExternalProposalResponse>(`/sessions/${encodeURIComponent(sessionId)}/proposals`, {
      method: "POST",
      headers: { "X-QA-Client": detectQaClient(process.env) },
      body: JSON.stringify(body),
    });
  }

  async reviewVerdict(
    sessionId: string,
    body: ExternalReviewVerdictRequest,
  ): Promise<ExternalReviewVerdictResponse> {
    return this.request<ExternalReviewVerdictResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/review/verdicts`,
      {
        method: "POST",
        headers: { "X-QA-Client": detectQaClient(process.env) },
        body: JSON.stringify(body),
      },
    );
  }

  async reviewCommit(
    sessionId: string,
    body: ExternalReviewCommitRequest,
  ): Promise<ExternalReviewCommitResponse> {
    return this.request<ExternalReviewCommitResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/review/commit`,
      {
        method: "POST",
        headers: { "X-QA-Client": detectQaClient(process.env) },
        body: JSON.stringify(body),
      },
    );
  }

  async ignoreAnnotations(
    sessionId: string,
    body: ExternalAnnotationIgnoreRequest,
  ): Promise<ExternalAnnotationIgnoreResponse> {
    return this.request<ExternalAnnotationIgnoreResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/review/annotations/ignore`,
      {
        method: "POST",
        headers: { "X-QA-Client": detectQaClient(process.env) },
        body: JSON.stringify(body),
      },
    );
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

  private async assertResponseOk(response: Response): Promise<void> {
    if (response.ok) return;
    const text = await response.text();
    if (response.status >= 500) {
      throw new QaCliError("SERVICE_UNAVAILABLE", "青简服务暂时不可用");
    }
    const json = tryParseJsonResponse(text);
    const body = json as Partial<ExternalErrorResponse> | null;
    const fallbackCode = response.status === 401
      ? "AUTH_FAILED"
      : response.status === 404
        ? "NOT_FOUND"
        : "VALIDATION";
    if (body && typeof body === "object") {
      throw new QaCliError(body.code ?? fallbackCode, body.error ?? response.statusText, body);
    }
    throw new QaCliError(fallbackCode, compactErrorText(text, response.statusText));
  }
}

const MAX_RATE_LIMIT_RETRIES = 6;
const INITIAL_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 4_000;
export const API_REQUEST_DEADLINE_MS = 15_000;

export async function fetchWithRateLimitRetry(
  input: string,
  init: RequestInit,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(input, init);
    if (response.status !== 429 || attempt >= MAX_RATE_LIMIT_RETRIES) return response;

    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    await response.body?.cancel().catch(() => undefined);
    const exponentialMs = Math.min(MAX_RETRY_DELAY_MS, INITIAL_RETRY_DELAY_MS * 2 ** attempt);
    await abortableDelay(Math.max(exponentialMs, retryAfterMs ?? 0), init.signal);
  }
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}

function abortableDelay(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function detectQaClient(env: NodeJS.ProcessEnv): "claudecode" | "codex" | "agent" {
  if (env.CLAUDECODE || env.AI_AGENT?.startsWith("claude-code")) return "claudecode";
  if (Object.keys(env).some((key) => key.startsWith("CODEX_"))) return "codex";
  return "agent";
}

function tryParseJsonResponse(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function parseSuccessResponse<T extends ExternalSuccessResponse>(text: string, endpoint: string): T {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new QaCliError("INVALID_RESPONSE", "实例响应无效(非 JSON)", {
      endpoint,
      bodySnippet: compactResponseBody(text),
    });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new QaCliError("INVALID_RESPONSE", "实例响应无效(响应体必须是 JSON 对象)", {
      endpoint,
      bodySnippet: compactResponseBody(text),
    });
  }
  return value as T;
}

function compactResponseBody(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}...` : trimmed;
}

function compactErrorText(text: string, fallback: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return fallback;
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}...` : trimmed;
}
