import { createConnectorStatus } from "./service.js";
import type { ConnectorAdapter, ConnectorStatusDto } from "./types.js";

export class GithubConnectorNotImplementedError extends Error {
  readonly status = 501;
  readonly code = "GITHUB_CONNECTOR_NOT_IMPLEMENTED";
}

/** M1b 协议占位；M2a 在此接口后接 device flow，不伪造“已连接”。 */
export class GithubConnector implements ConnectorAdapter {
  constructor(private readonly clientId = process.env.QINGAGENT_GITHUB_CLIENT_ID?.trim() ?? "") {}

  async status(): Promise<ConnectorStatusDto> {
    return this.clientId
      ? createConnectorStatus("unavailable", {
          reasonCode: "GITHUB_CONNECTOR_NOT_IMPLEMENTED",
          statusFreshness: "fresh",
        })
      : createConnectorStatus("unconfigured", {
          reasonCode: "GITHUB_CLIENT_ID_MISSING",
          statusFreshness: "fresh",
        });
  }

  async start(): Promise<never> {
    throw new GithubConnectorNotImplementedError("GitHub 连接将在 M2a 提供");
  }

  async disconnect(): Promise<ConnectorStatusDto> {
    return this.status();
  }
}
