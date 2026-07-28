import { describe, expect, it } from "vitest";
import { ConnectorService } from "../connectorService.js";
import { createConnectorStatus } from "../service.js";
import type { ConnectorAdapter, ConnectorId } from "../types.js";

function adapter(
  status: ConnectorAdapter["status"],
): ConnectorAdapter {
  return {
    status,
    disconnect: async () => createConnectorStatus("disconnected"),
  };
}

describe("ConnectorService.list", () => {
  it("单个连接器状态异常时仍返回其他健康连接器", async () => {
    const adapters: Record<ConnectorId, ConnectorAdapter> = {
      github: adapter(async () => {
        throw new Error("credential storage damaged");
      }),
      feishu: adapter(async () =>
        createConnectorStatus("connected", {
          account: { displayName: "飞书账号" },
          statusFreshness: "fresh",
        })
      ),
      "wechat-mp": adapter(async () =>
        createConnectorStatus("disconnected", { statusFreshness: "fresh" })
      ),
    };

    const result = await new ConnectorService(adapters).list();

    expect(result).toHaveLength(3);
    expect(result.find((item) => item.id === "github")?.status).toEqual(
      createConnectorStatus("unavailable", {
        reasonCode: "CONNECTOR_STATUS_UNAVAILABLE",
        statusFreshness: "unknown",
      }),
    );
    expect(result.find((item) => item.id === "feishu")?.status).toMatchObject({
      state: "connected",
      account: { displayName: "飞书账号" },
    });
    expect(result.find((item) => item.id === "wechat-mp")?.status.state).toBe("disconnected");
  });
});
