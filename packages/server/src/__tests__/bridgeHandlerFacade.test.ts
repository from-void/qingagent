import { describe, expect, it } from "vitest";
import * as bridge from "../gateway/bridgeHandler";

describe("bridgeHandler facade", () => {
  it("保留拆分前的运行时导出", () => {
    const expectedExports = [
      "DEFAULT_USER_VERSION_WINDOW_MS",
      "USER_VERSION_WINDOW_MS",
      "collectRestoreFrames",
      "disposeAllSessionsForShutdown",
      "drainActiveTurnsForShutdown",
      "emitRestoreFrames",
      "findMaterial",
      "findSessionByPatch",
      "findSessionByReviewBatchId",
      "forgetSession",
      "getOrRestoreSession",
      "getSession",
      "handleCommand",
      "normalizeClientTraceId",
      "parseOrigin",
      "readUserVersionWindowMs",
      "recordCommandSpan",
      "refreshBrowserFolderSourceFileCountsForBridgeConnection",
      "resolveCommandSessionId",
      "sessionExists",
      "sessionManager",
    ] as const;

    for (const name of expectedExports) {
      expect(bridge[name], `${name} 应继续从 bridgeHandler facade 导出`).toBeDefined();
    }
    expect(Object.keys(bridge).sort()).toEqual([...expectedExports].sort());
  });

  it("规划期 cancelStream 可在 streamId 出现前按 sessionId 路由", () => {
    expect(
      bridge.resolveCommandSessionId({
        kind: "cancelStream",
        data: { sessionId: "session-planning" },
      }),
    ).toBe("session-planning");
  });
});
