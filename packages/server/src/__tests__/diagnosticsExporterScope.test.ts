import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagSpan } from "@qingagent/contract-ts";

const mocks = vi.hoisted(() => ({
  collectLogs: vi.fn(async () => []),
  collectSpans: vi.fn(async () => [] as DiagSpan[]),
  collectFrameLogs: vi.fn(async () => []),
}));

vi.mock("../diagnostics/collect.js", () => mocks);
vi.mock("../diagnostics/snapshot.js", () => ({
  collectEnvSnapshot: vi.fn(() => ({})),
  collectSettingsSnapshot: vi.fn(async () => ({})),
}));

import { buildDiagnosticsZip } from "../diagnostics/exporter";

describe("diagnostics exporter span scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("把用户勾选的会话同时传给 spans 与 framelog 采集", async () => {
    await buildDiagnosticsZip({ privacyLevel: "L2", sessionIds: ["s-picked"] });

    expect(mocks.collectSpans).toHaveBeenCalledWith(expect.objectContaining({
      privacyLevel: "L2",
      sessionIds: ["s-picked"],
    }));
    expect(mocks.collectFrameLogs).toHaveBeenCalledWith("L2", {
      maxSessions: 20,
      sessionIds: ["s-picked"],
    });
  });

  it("L2 没有有效勾选范围时不回退导出最近会话 framelog", async () => {
    await buildDiagnosticsZip({ privacyLevel: "L2", sessionIds: [""] });

    expect(mocks.collectFrameLogs).toHaveBeenCalledWith("L2", {
      maxSessions: 0,
      sessionIds: [""],
    });
  });
});
