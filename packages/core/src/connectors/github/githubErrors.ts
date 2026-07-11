export class GithubConnectorError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly resetAt: string | null = null,
  ) {
    super(message);
    this.name = "GithubConnectorError";
  }
}

