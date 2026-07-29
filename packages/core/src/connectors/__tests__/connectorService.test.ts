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

  it("cancel 仅调用目标 adapter 的 pending 取消契约", async () => {
    const cancel = async (pendingId: string) => {
      expect(pendingId).toBe("pending-safe-id");
      return createConnectorStatus("disconnected", {
        reasonCode: "USER_CANCELLED",
        statusFreshness: "fresh",
      });
    };
    const adapters: Record<ConnectorId, ConnectorAdapter> = {
      github: { ...adapter(async () => createConnectorStatus("pending")), cancel },
      feishu: adapter(async () => createConnectorStatus("connected")),
      "wechat-mp": adapter(async () => createConnectorStatus("connected")),
    };

    const result = await new ConnectorService(adapters).cancel(
      "github",
      "pending-safe-id",
    );

    expect(result).toMatchObject({
      id: "github",
      status: { state: "disconnected", reasonCode: "USER_CANCELLED" },
    });
  });
});
