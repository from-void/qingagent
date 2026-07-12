/**
 * Round 4 E1 — 集成探针：真实 bridgeHandler 命令流
 *
 * 跑法：cd packages/server && npx vitest run r4e1
 *
 * 覆盖：
 *  T01  env flag 未开 → unsupported_environment，token 不被消耗
 *  T02  正常 attach — 帧顺序(operationResult 先)/内容/session.folderSources 落地
 *  T03  detach 全流程 — 帧顺序/内容/session 清空/cache 清/盘文件留
 *  T04  detach 不存在 folderId → not_found
 *  T05  token 一次性：消耗后重发 attach → invalid_path
 *  T06  并发 attach → 1 ok + 1 too_many_sources，session 只有 1 connected
 *  T07  restore 路径 — 重连已有 session 补发含 source 的 folderSourcesChanged
 *  T08  restore 后 detach → folderSourcesChanged sources 为空
 *  T09  agent busy 时 attach → agent_busy
 *  T10  不存在 sessionId → attach/detach 返回 not_found
 *  T11  pathLabel 脱敏 — wire 帧中 pathLabel 不含原始绝对路径
 *  T12  wire 帧 mountPath 格式 /sources/<source_xxx>
 *
 * 保留原文件：e2e-folder/round4/r4e1-bridge-integration.test.ts
 * 本文件是为 vitest 扫描路径放置的运行副本。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame, Command } from "@qingagent/contract-ts";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

async function collectFrames(gen: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

async function loadBridge() {
  vi.resetModules();

  const schedulePersist = vi.fn(async () => undefined);
  const clearFolderSourceCacheMock = vi.fn(async () => undefined);

  vi.doMock("@qingagent/core", async () => {
    const actual = await vi.importActual<typeof import("@qingagent/core")>("@qingagent/core");
    return {
      ...actual,
      schedulePersist,
      clearFolderSourceCache: clearFolderSourceCacheMock,
      createSessionThread: vi.fn(async () => undefined),
    };
  });

  vi.doMock("../lib/uploadStorage", () => ({
    UPLOAD_DIR: "/tmp/qingagent-test-uploads",
    isValidUploadId: vi.fn(() => true),
    isWithinUploadDir: vi.fn(() => true),
    deleteUploadedFile: vi.fn(async () => true),
  }));

  const bridge = await import("../gateway/bridgeHandler");
  return { bridge, schedulePersist, clearFolderSourceCacheMock };
}

async function createSession(bridge: typeof import("../gateway/bridgeHandler")) {
  const frames = await collectFrames(
    bridge.handleCommand({
      kind: "startSession",
      data: { mode: { kind: "new", data: { template: null } } },
    }),
  );
  const meta = frames.find((f) => f.kind === "sessionMeta");
  if (meta?.kind !== "sessionMeta") throw new Error("missing sessionMeta");
  const session = bridge.getSession(meta.data.sessionId);
  if (!session) throw new Error("missing session");
  return session;
}

function attachCmd(sessionId: string, token: string): Command {
  return {
    kind: "attachFolder",
    data: { sessionId, source: { provider: "desktop-local", selectionToken: token } },
  };
}

function detachCmd(sessionId: string, folderId: string): Command {
  return { kind: "detachFolder", data: { sessionId, folderId } };
}

/** 在 tmpdir 建一个含数个文件的临时目录并注册 selection */
async function mintTokenAndDir(
  registry: typeof import("../lib/desktopFolderSelection"),
  opts?: { name?: string; fileCount?: number },
): Promise<{ root: string; selectionToken: string }> {
  const root = mkdtempSync(join(tmpdir(), "r4e1-folder-"));
  writeFileSync(join(root, "readme.md"), "# 测试资料库\n内容 A");
  writeFileSync(join(root, "data.txt"), "数据行 1\n数据行 2");
  const sub = join(root, "subdir");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, "nested.md"), "嵌套文件");

  const selection = registry.registerDesktopFolderSelection({
    webContentsId: 1,
    rootPath: root,
    name: opts?.name ?? "测试文件夹",
    pathLabel: root,
    fileCount: opts?.fileCount ?? 3,
  });
  return { root, selectionToken: selection.selectionToken };
}

// ---------------------------------------------------------------------------
// 测试套件
// ---------------------------------------------------------------------------

describe("R4E1 handleCommand folder sources — 集成测试", () => {
  const savedRuntime = process.env.QINGAGENT_RUNTIME;
  const savedFlag = process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES;

  afterEach(async () => {
    if (savedRuntime === undefined) delete process.env.QINGAGENT_RUNTIME;
    else process.env.QINGAGENT_RUNTIME = savedRuntime;
    if (savedFlag === undefined) delete process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES;
    else process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = savedFlag;

    const registry = await import("../lib/desktopFolderSelection");
    registry.__resetDesktopFolderSelectionsForTest();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  // -------------------------------------------------------------------------
  // T01: 环境 flag 关闭时 → unsupported_environment，token 不被消耗
  // -------------------------------------------------------------------------
  it("T01: env flag 未开 → unsupported_environment，token 不消耗", async () => {
    delete process.env.QINGAGENT_RUNTIME;
    delete process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES;

    const { bridge } = await loadBridge();
    const session = await createSession(bridge);
    const registry = await import("../lib/desktopFolderSelection");
    const { selectionToken } = await mintTokenAndDir(registry);

    const frames = await collectFrames(bridge.handleCommand(attachCmd(session.sessionId, selectionToken)));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({
      kind: "folderSourceOperationResult",
      data: { ok: false, op: "attach", reason: "unsupported_environment" },
    });
    expect(session.folderSources.size).toBe(0);

    // token 应未被消耗（还能再 consume）
    const consumed = registry.consumeDesktopFolderSelection(selectionToken);
    expect(consumed).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // T02: 正常 attach 帧顺序与内容
  // -------------------------------------------------------------------------
  it("T02: 正常 attach — 帧顺序: operationResult(ok) 先于 folderSourcesChanged", async () => {
    process.env.QINGAGENT_RUNTIME = "desktop";
    process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = "1";

    const { bridge, schedulePersist } = await loadBridge();
    const session = await createSession(bridge);
    const registry = await import("../lib/desktopFolderSelection");
    const { root, selectionToken } = await mintTokenAndDir(registry, { name: "proj-docs" });

    const frames = await collectFrames(bridge.handleCommand(attachCmd(session.sessionId, selectionToken)));

    // 断言帧数量
    expect(frames).toHaveLength(2);

    const okFrame = frames[0];
    const changedFrame = frames[1];

    // T02a: 顺序：operationResult 先
    expect(okFrame?.kind).toBe("folderSourceOperationResult");
    expect(changedFrame?.kind).toBe("folderSourcesChanged");

    // T02b: operationResult 内容
    if (okFrame?.kind !== "folderSourceOperationResult") throw new Error("unexpected");
    expect(okFrame.data.ok).toBe(true);
    expect(okFrame.data.op).toBe("attach");
    if (!okFrame.data.ok) throw new Error("unexpected");
    expect(typeof okFrame.data.folderId).toBe("string");
    expect(okFrame.data.folderId.startsWith("fld_")).toBe(true);

    // T02c: folderSourcesChanged 内容
    if (changedFrame?.kind !== "folderSourcesChanged") throw new Error("unexpected");
    expect(changedFrame.data.sessionId).toBe(session.sessionId);
    expect(changedFrame.data.sources).toHaveLength(1);
    const wireSrc = changedFrame.data.sources[0]!;
    expect(wireSrc.status).toBe("connected");
    expect(wireSrc.name).toBe("proj-docs");
    expect(wireSrc.readOnly).toBe(true);
    expect(wireSrc.mountPath).toMatch(/^\/sources\/source_[a-z0-9]+$/);

    // T02d: wire 帧不泄露真实路径
    const frameJson = JSON.stringify(changedFrame);
    expect(frameJson).not.toContain("desktopRootPath");
    expect(frameJson).not.toContain(root);
    // pathLabel 应是摘要形式（不是原始绝对路径）
    expect(wireSrc.pathLabel).not.toBe(root);

    // T02e: session.folderSources 落地
    expect(session.folderSources.size).toBe(1);
    const folderId = Array.from(session.folderSources.keys())[0]!;
    const record = session.folderSources.get(folderId)!;
    expect(record.desktopRootPath).toBe(root);
    expect(record.status).toBe("connected");
    if (!okFrame.data.ok) throw new Error("unexpected");
    expect(record.id).toBe(okFrame.data.folderId);

    // T02f: schedulePersist 被调用
    expect(schedulePersist).toHaveBeenCalledWith(session, "command:attachFolder");
  });

  // -------------------------------------------------------------------------
  // T03: detach 全流程
  // -------------------------------------------------------------------------
  it("T03: detach — 帧顺序/内容、session 状态清、盘文件留、clearCache 调用", async () => {
    process.env.QINGAGENT_RUNTIME = "desktop";
    process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = "1";

    const { bridge, schedulePersist, clearFolderSourceCacheMock } = await loadBridge();
    const session = await createSession(bridge);
    const registry = await import("../lib/desktopFolderSelection");
    const { root, selectionToken } = await mintTokenAndDir(registry);

    // 先 attach
    await collectFrames(bridge.handleCommand(attachCmd(session.sessionId, selectionToken)));
    const folderId = Array.from(session.folderSources.keys())[0]!;

    // 确认盘文件在 attach 后仍存在
    expect(existsSync(root)).toBe(true);

    // detach
    const detachFrames = await collectFrames(bridge.handleCommand(detachCmd(session.sessionId, folderId)));

    // T03a: 帧顺序：operationResult(ok) 先于 folderSourcesChanged
    expect(detachFrames).toHaveLength(2);
    const okFrame = detachFrames[0];
    const changedFrame = detachFrames[1];
    expect(okFrame?.kind).toBe("folderSourceOperationResult");
    expect(changedFrame?.kind).toBe("folderSourcesChanged");

    // T03b: operationResult 内容
    if (okFrame?.kind !== "folderSourceOperationResult") throw new Error("unexpected");
    expect(okFrame.data.ok).toBe(true);
    expect(okFrame.data.op).toBe("detach");
    if (!okFrame.data.ok) throw new Error("unexpected");
    expect(okFrame.data.folderId).toBe(folderId);

    // T03c: folderSourcesChanged sources 为空
    if (changedFrame?.kind !== "folderSourcesChanged") throw new Error("unexpected");
    expect(changedFrame.data.sources).toHaveLength(0);
    expect(changedFrame.data.sessionId).toBe(session.sessionId);

    // T03d: session.folderSources 清空
    expect(session.folderSources.size).toBe(0);

    // T03e: clearFolderSourceCache 被调用
    expect(clearFolderSourceCacheMock).toHaveBeenCalledWith(session.sessionId, folderId);

    // T03f: 盘文件不删
    expect(existsSync(root)).toBe(true);
    expect(existsSync(join(root, "readme.md"))).toBe(true);

    // T03g: schedulePersist 被调用
    expect(schedulePersist).toHaveBeenCalledWith(session, "command:detachFolder");
  });

  // -------------------------------------------------------------------------
  // T04: detach 不存在的 folderId → not_found
  // -------------------------------------------------------------------------
  it("T04: detach 不存在 folderId → not_found", async () => {
    process.env.QINGAGENT_RUNTIME = "desktop";
    process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = "1";

    const { bridge } = await loadBridge();
    const session = await createSession(bridge);

    const frames = await collectFrames(bridge.handleCommand(detachCmd(session.sessionId, "fld_nonexistent")));
    expect(frames).toEqual([{
      kind: "folderSourceOperationResult",
      data: { ok: false, op: "detach", reason: "not_found" },
    }]);
  });

  // -------------------------------------------------------------------------
  // T05: token 一次性 — 消耗后不可重用
  // -------------------------------------------------------------------------
  it("T05: token 消耗后重发 attach → invalid_path（token 已失效）", async () => {
    process.env.QINGAGENT_RUNTIME = "desktop";
    process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = "1";

    const { bridge } = await loadBridge();
    const session = await createSession(bridge);
    const registry = await import("../lib/desktopFolderSelection");
    const { selectionToken } = await mintTokenAndDir(registry);

    // 第一次 attach 成功
    const first = await collectFrames(bridge.handleCommand(attachCmd(session.sessionId, selectionToken)));
    const firstOk = first.find((f) => f.kind === "folderSourceOperationResult");
    if (firstOk?.kind !== "folderSourceOperationResult") throw new Error("unexpected");
    expect(firstOk.data.ok).toBe(true);

    // detach 一下，释放 slot（回到 0）
    const folderId = Array.from(session.folderSources.keys())[0]!;
    await collectFrames(bridge.handleCommand(detachCmd(session.sessionId, folderId)));
    expect(session.folderSources.size).toBe(0);

    // 再用同一 token attach → 应失败（token 已消耗）
    const second = await collectFrames(bridge.handleCommand(attachCmd(session.sessionId, selectionToken)));
    const secondResult = second.find((f) => f.kind === "folderSourceOperationResult");
    if (secondResult?.kind !== "folderSourceOperationResult") throw new Error("unexpected");
    expect(secondResult.data.ok).toBe(false);
    if (secondResult.data.ok) throw new Error("unexpected");
    expect(secondResult.data.reason).toBe("invalid_path");
  });

  // -------------------------------------------------------------------------
  // T06: 并发 attach — 只有 1 个成功
  // -------------------------------------------------------------------------
  it("T06: 并发 attach 两个 → 1 ok + 1 too_many_sources，session 只有 1 connected", async () => {
    process.env.QINGAGENT_RUNTIME = "desktop";
    process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = "1";

    const { bridge } = await loadBridge();
    const session = await createSession(bridge);
    const registry = await import("../lib/desktopFolderSelection");
    const { selectionToken: tokenA } = await mintTokenAndDir(registry, { name: "A" });
    const { selectionToken: tokenB } = await mintTokenAndDir(registry, { name: "B" });

    const [framesA, framesB] = await Promise.all([
      collectFrames(bridge.handleCommand(attachCmd(session.sessionId, tokenA))),
      collectFrames(bridge.handleCommand(attachCmd(session.sessionId, tokenB))),
    ]);

    const results = [...framesA, ...framesB].filter(
      (f): f is Extract<BridgeFrame, { kind: "folderSourceOperationResult" }> =>
        f.kind === "folderSourceOperationResult",
    );
    const okCount = results.filter((r) => r.data.ok).length;
    const tooManyCount = results.filter((r) => !r.data.ok && r.data.reason === "too_many_sources").length;
    expect(okCount).toBe(1);
    expect(tooManyCount).toBe(1);

    const connectedCount = Array.from(session.folderSources.values()).filter(
      (s) => s.status === "connected",
    ).length;
    expect(connectedCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // T07: restore 路径（emitRestoreFrames）补发 folderSourcesChanged
  // -------------------------------------------------------------------------
  it("T07: restore 路径 — 重连已有 session 补发含 source 的 folderSourcesChanged", async () => {
    process.env.QINGAGENT_RUNTIME = "desktop";
    process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = "1";

    const { bridge } = await loadBridge();
    const session = await createSession(bridge);
    const registry = await import("../lib/desktopFolderSelection");
    const { selectionToken } = await mintTokenAndDir(registry, { name: "restore-test" });

    // attach 一个 folder source
    await collectFrames(bridge.handleCommand(attachCmd(session.sessionId, selectionToken)));
    expect(session.folderSources.size).toBe(1);

    // 模拟重连：发 startSession { kind: "existing" }
    const restoreFrames = await collectFrames(
      bridge.handleCommand({
        kind: "startSession",
        data: { mode: { kind: "existing", data: { id: session.sessionId } } },
      }),
    );

    // 必须有 folderSourcesChanged 帧
    const changedFrames = restoreFrames.filter((f) => f.kind === "folderSourcesChanged");
    expect(changedFrames.length).toBeGreaterThanOrEqual(1);

    const changed = changedFrames[0];
    if (changed?.kind !== "folderSourcesChanged") throw new Error("unexpected");
    expect(changed.data.sessionId).toBe(session.sessionId);
    expect(changed.data.sources).toHaveLength(1);
    expect(changed.data.sources[0]?.status).toBe("connected");
    expect(changed.data.sources[0]?.name).toBe("restore-test");

    // folderSourcesChanged 帧不得泄露真实路径
    const changedJson = JSON.stringify(changed);
    expect(changedJson).not.toContain("desktopRootPath");
  });

  // -------------------------------------------------------------------------
  // T08: restore 后 detach → folderSourcesChanged sources 为空
  // -------------------------------------------------------------------------
  it("T08: restore 后 detach → folderSourcesChanged sources 为空", async () => {
    process.env.QINGAGENT_RUNTIME = "desktop";
    process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = "1";

    const { bridge } = await loadBridge();
    const session = await createSession(bridge);
    const registry = await import("../lib/desktopFolderSelection");
    const { selectionToken } = await mintTokenAndDir(registry);

    await collectFrames(bridge.handleCommand(attachCmd(session.sessionId, selectionToken)));
    const folderId = Array.from(session.folderSources.keys())[0]!;

    // restore（内存命中走缓存路径，验证 folderSourcesChanged 在重连时有 source）
    const restoreFrames = await collectFrames(
      bridge.handleCommand({
        kind: "startSession",
        data: { mode: { kind: "existing", data: { id: session.sessionId } } },
      }),
    );
    const restoredChanged = restoreFrames.find((f) => f.kind === "folderSourcesChanged");
    if (restoredChanged?.kind !== "folderSourcesChanged") throw new Error("no folderSourcesChanged in restore");
    expect(restoredChanged.data.sources).toHaveLength(1);

    // detach
    const detachFrames = await collectFrames(bridge.handleCommand(detachCmd(session.sessionId, folderId)));
    const afterDetachChanged = detachFrames.find((f) => f.kind === "folderSourcesChanged");
    if (afterDetachChanged?.kind !== "folderSourcesChanged") throw new Error("no folderSourcesChanged after detach");
    expect(afterDetachChanged.data.sources).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // T09: agent busy 时 attach → agent_busy
  // -------------------------------------------------------------------------
  it("T09: agent busy 时 attach → agent_busy", async () => {
    process.env.QINGAGENT_RUNTIME = "desktop";
    process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = "1";

    const { bridge } = await loadBridge();
    const session = await createSession(bridge);
    const registry = await import("../lib/desktopFolderSelection");
    const { selectionToken } = await mintTokenAndDir(registry);

    // 模拟 agent busy（直接设 streamId）
    session.streamId = "stream-mock-busy";

    const frames = await collectFrames(bridge.handleCommand(attachCmd(session.sessionId, selectionToken)));
    expect(frames).toHaveLength(1);
    if (frames[0]?.kind !== "folderSourceOperationResult") throw new Error("unexpected");
    expect(frames[0].data.ok).toBe(false);
    if (frames[0].data.ok) throw new Error("unexpected");
    expect(frames[0].data.reason).toBe("agent_busy");
    expect(session.folderSources.size).toBe(0);

    // 清理
    session.streamId = null;
  });

  // -------------------------------------------------------------------------
  // T10: 不存在的 sessionId → not_found
  // -------------------------------------------------------------------------
  it("T10: 不存在 session → attach/detach 都返回 not_found", async () => {
    process.env.QINGAGENT_RUNTIME = "desktop";
    process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = "1";

    const { bridge } = await loadBridge();
    const registry = await import("../lib/desktopFolderSelection");
    const { selectionToken } = await mintTokenAndDir(registry);

    const attachFrames = await collectFrames(
      bridge.handleCommand(attachCmd("nonexistent-session-id", selectionToken)),
    );
    expect(attachFrames).toEqual([{
      kind: "folderSourceOperationResult",
      data: { ok: false, op: "attach", reason: "not_found" },
    }]);

    const detachFrames = await collectFrames(
      bridge.handleCommand(detachCmd("nonexistent-session-id", "fld_xxx")),
    );
    expect(detachFrames).toEqual([{
      kind: "folderSourceOperationResult",
      data: { ok: false, op: "detach", reason: "not_found" },
    }]);
  });

  // -------------------------------------------------------------------------
  // T11: 路径脱敏 — wire 帧 pathLabel 不含绝对路径
  // -------------------------------------------------------------------------
  it("T11: pathLabel 脱敏 — wire 帧中 pathLabel 不含原始绝对路径", async () => {
    process.env.QINGAGENT_RUNTIME = "desktop";
    process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = "1";

    const { bridge } = await loadBridge();
    const session = await createSession(bridge);
    const registry = await import("../lib/desktopFolderSelection");
    const { root, selectionToken } = await mintTokenAndDir(registry, { name: "secret-folder" });

    const frames = await collectFrames(bridge.handleCommand(attachCmd(session.sessionId, selectionToken)));
    const changed = frames.find((f) => f.kind === "folderSourcesChanged");
    if (changed?.kind !== "folderSourcesChanged") throw new Error("unexpected");

    const src = changed.data.sources[0]!;
    // pathLabel 不能是原始绝对路径
    expect(src.pathLabel).not.toBe(root);
    // wire 帧整体 JSON 不含真实路径
    expect(JSON.stringify(changed)).not.toContain(root);
  });

  // -------------------------------------------------------------------------
  // T12: folderSources wire 帧 sources 顺序：mountPath 格式正确
  // -------------------------------------------------------------------------
  it("T12: wire 帧 mountPath 格式 /sources/<source_xxx>", async () => {
    process.env.QINGAGENT_RUNTIME = "desktop";
    process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = "1";

    const { bridge } = await loadBridge();
    const session = await createSession(bridge);
    const registry = await import("../lib/desktopFolderSelection");
    const { selectionToken } = await mintTokenAndDir(registry);

    const frames = await collectFrames(bridge.handleCommand(attachCmd(session.sessionId, selectionToken)));
    const changed = frames.find((f) => f.kind === "folderSourcesChanged");
    if (changed?.kind !== "folderSourcesChanged") throw new Error("unexpected");

    const src = changed.data.sources[0]!;
    expect(src.mountPath).toMatch(/^\/sources\/source_[a-z0-9]+$/);
    expect(src.mountName).toMatch(/^source_[a-z0-9]+$/);
    // mountPath === /sources/<mountName>
    expect(src.mountPath).toBe(`/sources/${src.mountName}`);
  });
});
