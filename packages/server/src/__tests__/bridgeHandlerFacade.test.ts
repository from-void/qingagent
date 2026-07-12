import { describe, expect, it } from "vitest";
import * as bridge from "../bridge/bridgeHandler";

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
});
