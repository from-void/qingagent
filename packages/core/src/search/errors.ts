export type SearchProviderErrorKind = "auth" | "quota" | "network";

export class SearchProviderError extends Error {
  readonly kind: SearchProviderErrorKind;
  readonly status?: number;
  readonly providerId?: string;

  constructor(
    kind: SearchProviderErrorKind,
    message: string,
    options: { status?: number; providerId?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "SearchProviderError";
    this.kind = kind;
    this.status = options.status;
    this.providerId = options.providerId;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export function classifySearchHttpStatus(status: number): SearchProviderErrorKind {
  // 仍统一归类为 auth 供上层展示；健康状态会按原始 status 将 401 与 403/422 分级。
  if (status === 401 || status === 403 || status === 422) return "auth";
  if (status === 402 || status === 429) return "quota";
  return "network";
}

export function searchProviderErrorFromStatus(
  providerId: string,
  status: number,
): SearchProviderError {
  const kind = classifySearchHttpStatus(status);
  return new SearchProviderError(kind, `${providerId} search failed: HTTP ${status}`, {
    providerId,
    status,
  });
}
