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
  // 422:Brave 对格式无效的 Subscription Token 返回 422,语义上等同 key 无效。
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
