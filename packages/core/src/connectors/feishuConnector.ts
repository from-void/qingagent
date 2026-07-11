import { createConnectorStatus } from "./service.js";
import type { ConnectorAdapter, ConnectorStatusDto } from "./types.js";
import { LarkCliRunner, type LarkCliRunResult } from "./larkCliRunner.js";
import { parseLarkAuthStatusOutput, parseLarkConfigOutput } from "./larkStatusParser.js";

function unavailable(result: Extract<LarkCliRunResult, { ok: false }>): ConnectorStatusDto {
  return createConnectorStatus("unavailable", {
    reasonCode: result.reasonCode,
    statusFreshness: "fresh",
    canProbe: false,
    cliVersion: result.cliVersion,
  });
}

export class FeishuConnector implements ConnectorAdapter {
  constructor(private readonly runner: Pick<LarkCliRunner, "run"> = new LarkCliRunner()) {}

  async status(): Promise<ConnectorStatusDto> {
    const checkedAt = new Date().toISOString();
    const configResult = await this.runner.run(["config", "show"]);
    if (!configResult.ok) return unavailable(configResult);
    const config = parseLarkConfigOutput(configResult.stdout);
    if (!config.ok) {
      return createConnectorStatus("unavailable", {
        reasonCode: config.reasonCode,
        lastCheckedAt: checkedAt,
        statusFreshness: "fresh",
        cliVersion: configResult.cliVersion,
      });
    }
    if (!config.value.configured) {
      return createConnectorStatus("unconfigured", {
        reasonCode: "LARK_APP_UNCONFIGURED",
        lastCheckedAt: checkedAt,
        statusFreshness: "fresh",
        cliVersion: configResult.cliVersion,
      });
    }

    // 两条命令严格顺序执行：配置核心字段确认后才查用户授权。
    const authResult = await this.runner.run(["auth", "status", "--json"]);
    if (!authResult.ok) return unavailable(authResult);
    const auth = parseLarkAuthStatusOutput(authResult.stdout);
    if (!auth.ok) {
      return createConnectorStatus("unavailable", {
        reasonCode: auth.reasonCode,
        lastCheckedAt: checkedAt,
        statusFreshness: "fresh",
        cliVersion: authResult.cliVersion,
      });
    }
    if (auth.value.connected) {
      return createConnectorStatus("connected", {
        reasonCode: auth.value.scopes === null ? "LARK_SCOPES_UNKNOWN" : null,
        account: auth.value.account,
        scopes: auth.value.scopes ?? [],
        lastCheckedAt: checkedAt,
        statusFreshness: "fresh",
        canProbe: true,
        cliVersion: authResult.cliVersion,
      });
    }
    return createConnectorStatus(auth.value.needsReauth ? "needs_reauth" : "disconnected", {
      reasonCode: auth.value.needsReauth ? "LARK_AUTH_EXPIRED" : "LARK_AUTH_MISSING",
      lastCheckedAt: checkedAt,
      statusFreshness: "fresh",
      canProbe: true,
      cliVersion: authResult.cliVersion,
    });
  }

  async probe(): Promise<ConnectorStatusDto> {
    return this.status();
  }

  async disconnect(): Promise<ConnectorStatusDto> {
    const result = await this.runner.run(["auth", "logout"]);
    if (!result.ok) return unavailable(result);
    return createConnectorStatus("disconnected", {
      reasonCode: "USER_DISCONNECTED",
      lastCheckedAt: new Date().toISOString(),
      statusFreshness: "fresh",
      canProbe: true,
      cliVersion: result.cliVersion,
    });
  }
}
