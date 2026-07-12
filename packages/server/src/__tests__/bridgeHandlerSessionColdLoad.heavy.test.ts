import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame } from "@qingagent/contract-ts";

// 回归:session-coldload-missing-in-command-branches(e2e R26 阻断)。
// 后端重启/热重载/部署后内存 session 被逐出,文档已从持久层恢复,但
// 命令分支(sendMessage/updateDoc/材料/文件夹)此前直接 sessions.get→抛 Session not found。
// 修复:命令分支统一走 getOrRestoreSession,内存 miss 时 loadSessionFromThread 冷加载回内存。
// 本测试用 updateMaterialSummary 这条"只需拿到 session"的轻量命令验证冷加载兜底。

async function collectFrames(gen: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

// 由各用例注入:loadSessionFromThread(id) 的返回(模拟持久层里是否有该 thread)。
let restoreImpl: ((id: string) => unknown) | null = null;
const loadSpy = vi.fn(async (id: string) => restoreImpl?.(id) ?? null);

async function loadBridge() {
  vi.resetModules();
  loadSpy.mockClear();
  vi.doMock("@qingagent/core", async () => {
    const actual = await vi.importActual<typeof import("@qingagent/core")>("@qingagent/core");
    return {
      ...actual,
      createSessionThread: vi.fn(async () => undefined),
      persistSessionMetadata: vi.fn(async () => undefined),
      schedulePersist: vi.fn(async () => undefined),
      loadSessionFromThread: loadSpy,
    };
  });
  return await import("../bridge/bridgeHandler");
}

async function createSession(
  bridge: typeof import("../bridge/bridgeHandler"),
): Promise<NonNullable<ReturnType<typeof bridge.getSession>>> {
  const frames = await collectFrames(
    bridge.handleCommand({
      kind: "startSession",
      data: { mode: { kind: "new", data: { template: null } } },
    }),
  );
  const meta = frames.find((frame) => frame.kind === "sessionMeta");
  if (meta?.kind !== "sessionMeta") throw new Error("missing sessionMeta");
  const session = bridge.getSession(meta.data.sessionId);
  if (!session) throw new Error("missing session");
  return session;
}

describe("handleCommand 命令分支 session 冷加载兜底", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    restoreImpl = null;
  });

  it("内存被逐出后,命令分支从 thread 冷加载恢复 session,不再 Session not found", async () => {
    const bridge = await loadBridge();
    const session = await createSession(bridge);
    const id = session.sessionId;

    // 模拟后端重启/热重载:内存态被逐出,但持久层仍能恢复出该 session。
    bridge.forgetSession(id);
    expect(bridge.getSession(id)).toBeUndefined();
    restoreImpl = (wanted) => (wanted === id ? session : null);

    // 修复前:这里会抛 "Session not found";修复后:冷加载成功、优雅返回。
    const frames = await collectFrames(
      bridge.handleCommand({
        kind: "updateMaterialSummary",
        data: { sessionId: id, materialId: "missing-material", summary: "x" },
      }),
    );

    // 冷加载被触发一次,session 重新入内存,命令未抛错。
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(loadSpy).toHaveBeenCalledWith(id);
    expect(bridge.getSession(id)).toBeDefined();
    expect(frames).toEqual([]); // 目标素材不存在 → 优雅 return,无帧、无异常
  });

  it("内存命中时不触发冷加载(快路径不回 thread)", async () => {
    const bridge = await loadBridge();
    const session = await createSession(bridge);

    await collectFrames(
      bridge.handleCommand({
        kind: "updateMaterialSummary",
        data: { sessionId: session.sessionId, materialId: "missing-material", summary: "x" },
      }),
    );

    expect(loadSpy).not.toHaveBeenCalled();
  });

  it("并发冷命令对同一 session 只冷加载一次(去重),不恢复出两个 state 互相覆盖", async () => {
    const bridge = await loadBridge();
    const session = await createSession(bridge);
    const id = session.sessionId;
    bridge.forgetSession(id);

    // 冷加载带一点延迟,模拟两条命令在 loadSessionFromThread 未返回前都进入恢复路径。
    restoreImpl = (wanted) => (wanted === id ? session : null);
    loadSpy.mockImplementationOnce(async (wanted: string) => {
      await new Promise((r) => setTimeout(r, 30));
      return wanted === id ? session : null;
    });

    const [a, b] = await Promise.all([
      collectFrames(
        bridge.handleCommand({
          kind: "updateMaterialSummary",
          data: { sessionId: id, materialId: "m", summary: "x" },
        }),
      ),
      collectFrames(
        bridge.handleCommand({
          kind: "updateMaterialSummary",
          data: { sessionId: id, materialId: "m", summary: "y" },
        }),
      ),
    ]);

    // 两条并发命令共用一次冷加载,内存里只有一个、且就是原对象。
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(bridge.getSession(id)).toBe(session);
    expect(a).toEqual([]);
    expect(b).toEqual([]);
  });

  it("持久层也没有该 session 时,仍 fail-closed 抛 Session not found", async () => {
    const bridge = await loadBridge();
    const session = await createSession(bridge);
    const id = session.sessionId;
    bridge.forgetSession(id);
    restoreImpl = () => null; // thread 里也没有

    await expect(
      collectFrames(
        bridge.handleCommand({
          kind: "updateMaterialSummary",
          data: { sessionId: id, materialId: "m", summary: "x" },
        }),
      ),
    ).rejects.toThrow(/Session not found/);
    expect(loadSpy).toHaveBeenCalledWith(id);
  });
});
