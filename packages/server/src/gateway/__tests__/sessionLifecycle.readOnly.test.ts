import { beforeEach, describe, expect, it, vi } from "vitest";

const loadSessionFromThread = vi.fn(async (sessionId: string) => ({
  sessionId,
  docId: sessionId,
}));

async function loadLifecycle() {
  vi.resetModules();
  loadSessionFromThread.mockClear();
  vi.doMock("@qingagent/core", async () => {
    const actual = await vi.importActual<typeof import("@qingagent/core")>("@qingagent/core");
    return { ...actual, loadSessionFromThread };
  });
  return import("../sessionLifecycle.js");
}

describe("只读会话恢复", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("getOrRestoreSessionReadOnly 与 sessionExists 都使用纯 snapshot 模式且不注册 sessions", async () => {
    const lifecycle = await loadLifecycle();

    const restored = await lifecycle.getOrRestoreSessionReadOnly("snapshot-session");
    await expect(lifecycle.sessionExists("exists-session")).resolves.toBe(true);

    expect(restored?.sessionId).toBe("snapshot-session");
    expect(loadSessionFromThread).toHaveBeenNthCalledWith(1, "snapshot-session", {
      mode: "snapshot",
    });
    expect(loadSessionFromThread).toHaveBeenNthCalledWith(2, "exists-session", {
      mode: "snapshot",
    });
    expect(lifecycle.getSession("snapshot-session")).toBeUndefined();
    expect(lifecycle.getSession("exists-session")).toBeUndefined();
  });
});
