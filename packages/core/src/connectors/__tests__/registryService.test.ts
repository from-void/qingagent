import { describe, expect, it } from "vitest";
import { CONNECTOR_REGISTRY } from "../registry.js";
import {
  CONNECTOR_TRANSITION_TABLES,
  ConnectorStateService,
  ConnectorTransitionError,
  createConnectorStatus,
  transitionConnectorStatus,
} from "../service.js";
import type { ConnectorId, ConnectorState } from "../types.js";

const STATES: ConnectorState[] = [
  "unavailable",
  "unconfigured",
  "disconnected",
  "pending",
  "connected",
  "needs_reauth",
];

describe("connector registry", () => {
  it("登记三条连接器与技能依赖/riskNote", () => {
    expect(CONNECTOR_REGISTRY.map((entry) => entry.id)).toEqual([
      "github",
      "feishu",
      "wechat-mp",
    ]);
    expect(CONNECTOR_REGISTRY.map((entry) => entry.usedBySkills)).toEqual([
      ["github-materials"],
      ["feishu"],
      ["wechat-official-account"],
    ]);
    const wechat = CONNECTOR_REGISTRY.find(
      (entry): entry is Extract<(typeof CONNECTOR_REGISTRY)[number], { id: "wechat-mp" }> =>
        entry.id === "wechat-mp",
    );
    expect(wechat?.official).toBe(false);
    expect(wechat?.riskNote).toBeTruthy();
    expect(wechat?.tools).toEqual([
      "wechat_auth_start",
      "wechat_auth_status",
      "wechat_search_mp",
      "wechat_list_articles",
    ]);
  });
});

describe("connector transition tables", () => {
  for (const connectorId of ["github", "feishu", "wechat-mp"] as const) {
    it(`${connectorId} 完整 6×6 迁移矩阵按表执行`, () => {
      for (const from of STATES) {
        for (const to of STATES) {
          const status = createConnectorStatus(from, {
            reasonCode: "BEFORE",
            account: { displayName: "account" },
            scopes: ["scope"],
            canProbe: true,
          });
          const expected = CONNECTOR_TRANSITION_TABLES[connectorId][from][to];
          if (expected === "illegal") {
            expect(() => transitionConnectorStatus(connectorId, status, to)).toThrow(
              ConnectorTransitionError,
            );
            try {
              transitionConnectorStatus(connectorId, status, to);
            } catch (error) {
              expect((error as ConnectorTransitionError).status).toBe(409);
              expect((error as ConnectorTransitionError).code).toBe(
                "ILLEGAL_CONNECTOR_TRANSITION",
              );
            }
          } else {
            const result = transitionConnectorStatus(connectorId, status, to);
            expect(result.idempotent).toBe(expected === "idempotent");
            expect(result.status.state).toBe(to);
            if (expected === "idempotent") expect(result.status).toBe(status);
          }
        }
      }
    });
  }

  it("start/disconnect 重复调用幂等，pending 丢失/过期落 disconnected", () => {
    const service = new ConnectorStateService();
    for (const connectorId of ["github", "feishu", "wechat-mp"] as ConnectorId[]) {
      expect(service.start(connectorId).idempotent).toBe(false);
      expect(service.start(connectorId).idempotent).toBe(true);
      expect(service.disconnect(connectorId).status.state).toBe("disconnected");
      expect(service.disconnect(connectorId).idempotent).toBe(true);

      service.start(connectorId);
      expect(service.pendingExpired(connectorId).status).toMatchObject({
        state: "disconnected",
        reasonCode: "PENDING_EXPIRED",
      });
      service.start(connectorId);
      expect(service.pendingLost(connectorId).status).toMatchObject({
        state: "disconnected",
        reasonCode: "PENDING_LOST",
      });
    }
  });

  it("缺配置/缺运行环境与 401/吊销使用稳定状态", () => {
    const service = new ConnectorStateService({
      github: createConnectorStatus("unconfigured", { reasonCode: "CLIENT_ID_MISSING" }),
      feishu: createConnectorStatus("unavailable", { reasonCode: "CLI_MISSING" }),
      "wechat-mp": createConnectorStatus("connected"),
    });
    expect(service.getStatus("github")).toMatchObject({
      state: "unconfigured",
      reasonCode: "CLIENT_ID_MISSING",
    });
    expect(service.getStatus("feishu")).toMatchObject({
      state: "unavailable",
      reasonCode: "CLI_MISSING",
    });
    expect(
      service.transition("wechat-mp", "needs_reauth", { reasonCode: "TOKEN_REVOKED" }).status,
    ).toMatchObject({ state: "needs_reauth", reasonCode: "TOKEN_REVOKED" });
  });

  it("进程重启后本地已是 disconnected，未知旧卡仍写入 PENDING_LOST 原因", () => {
    const service = new ConnectorStateService();
    const first = service.pendingLost("github");
    expect(first).toMatchObject({
      idempotent: false,
      status: { state: "disconnected", reasonCode: "PENDING_LOST" },
    });
    expect(service.pendingLost("github").idempotent).toBe(true);
  });
});
