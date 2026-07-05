/**
 * Round 3 评测探针 — reducer 多帧时序 + sessionId 守卫后切会话/重连
 * 文件位置：apps/web/src/pages/workspace/data/__e2e__round3Reducer.test.ts
 * 跑法：cd apps/web && npx vitest run src/pages/workspace/data/__e2e__round3Reducer.test.ts
 */
import { describe, expect, it } from "vitest";
import type { FolderSource } from "@qingagent/contract-ts";
import { workspaceReducer, initialWorkspaceState } from "./workspaceState";

const sourceA: FolderSource = {
  id: "fld_A",
  sessionId: "session-A",
  provider: "desktop-local",
  name: "文件夹 A",
  pathLabel: "~/A",
  mountName: "source_A",
  mountPath: "/sources/source_A",
  readOnly: true,
  fileCount: 10,
  fileCountCapped: false,
  status: "connected",
  error: null,
  createdAt: "2026-06-18T00:00:00.000Z",
  updatedAt: "2026-06-18T00:00:00.000Z",
};

const sourceAOffline: FolderSource = {
  ...sourceA,
  status: "offline",
};

const sourceAError: FolderSource = {
  ...sourceA,
  status: "error",
  error: "EACCES: permission denied",
};

const sourceB: FolderSource = {
  ...sourceA,
  id: "fld_B",
  sessionId: "session-B",
  name: "文件夹 B",
};

function withSession(sessionId: string) {
  return workspaceReducer(initialWorkspaceState, {
    kind: "sessionMeta",
    data: { sessionId, title: "test" },
  });
}

function withFolderSource(sessionId: string, sources: FolderSource[]) {
  const s = withSession(sessionId);
  return workspaceReducer(s, {
    kind: "folderSourcesChanged",
    data: { sessionId, sources },
  });
}

// ────────────────────────────────────────────────────────────
// T1: restore 多帧时序 — folderSourcesChanged 在 sessionMeta 之前/之后到达
// ────────────────────────────────────────────────────────────
describe("T1: restore 时序 — folderSourcesChanged 相对 sessionMeta 的顺序", () => {
  it("T1-A: 先来 folderSourcesChanged (未知 sessionId) 再来 sessionMeta → 不污染新会话 folderSources", () => {
    // 场景：折叠/崩溃恢复时，帧乱序到达
    // 先到 folderSourcesChanged for session-A，但 state.sessionId 仍为 null（初始）
    const afterBadFrame = workspaceReducer(initialWorkspaceState, {
      kind: "folderSourcesChanged",
      data: { sessionId: "session-A", sources: [sourceA] },
    });

    // initialWorkspaceState.sessionId = null，与 session-A 不匹配，应被忽略
    expect(afterBadFrame.folderSources).toEqual([]);

    // 然后收到 sessionMeta
    const afterMeta = workspaceReducer(afterBadFrame, {
      kind: "sessionMeta",
      data: { sessionId: "session-A", title: "A" },
    });

    // sessionMeta 到来后，state.sessionId = "session-A"，folderSources 仍为空
    expect(afterMeta.sessionId).toBe("session-A");
    expect(afterMeta.folderSources).toEqual([]);
  });

  it("T1-B: sessionMeta 到达后再来 folderSourcesChanged → 正常替换", () => {
    const s = withSession("session-A");
    const next = workspaceReducer(s, {
      kind: "folderSourcesChanged",
      data: { sessionId: "session-A", sources: [sourceA] },
    });
    expect(next.folderSources).toEqual([sourceA]);
  });

  it("T1-C: 连续多帧 folderSourcesChanged（同 session）→ 最后一帧胜出", () => {
    let s = withSession("session-A");
    // 帧1：connected
    s = workspaceReducer(s, {
      kind: "folderSourcesChanged",
      data: { sessionId: "session-A", sources: [sourceA] },
    });
    expect(s.folderSources[0]?.status).toBe("connected");

    // 帧2：offline（覆盖）
    s = workspaceReducer(s, {
      kind: "folderSourcesChanged",
      data: { sessionId: "session-A", sources: [sourceAOffline] },
    });
    expect(s.folderSources[0]?.status).toBe("offline");

    // 帧3：error（再次覆盖）
    s = workspaceReducer(s, {
      kind: "folderSourcesChanged",
      data: { sessionId: "session-A", sources: [sourceAError] },
    });
    expect(s.folderSources[0]?.status).toBe("error");
    expect(s.folderSources[0]?.error).toBe("EACCES: permission denied");
  });

  it("T1-D: 空列表帧 → 清空 folderSources", () => {
    let s = withSession("session-A");
    s = workspaceReducer(s, {
      kind: "folderSourcesChanged",
      data: { sessionId: "session-A", sources: [sourceA] },
    });
    expect(s.folderSources).toHaveLength(1);

    // 空列表帧（detach 后的 notify）
    s = workspaceReducer(s, {
      kind: "folderSourcesChanged",
      data: { sessionId: "session-A", sources: [] },
    });
    expect(s.folderSources).toEqual([]);
  });

  it("T1-E: 空列表帧来自其他 session → 被忽略，当前 session 数据不变", () => {
    let s = withSession("session-A");
    s = workspaceReducer(s, {
      kind: "folderSourcesChanged",
      data: { sessionId: "session-A", sources: [sourceA] },
    });

    // 来自 session-B 的空列表帧
    const next = workspaceReducer(s, {
      kind: "folderSourcesChanged",
      data: { sessionId: "session-B", sources: [] },
    });
    expect(next.folderSources).toHaveLength(1);
    expect(next.folderSources[0]?.id).toBe("fld_A");
  });
});

// ────────────────────────────────────────────────────────────
// T2: sessionId 守卫后切会话/重连的状态正确
// ────────────────────────────────────────────────────────────
describe("T2: 切会话/重连后的状态正确性", () => {
  it("T2-A: 切换会话后 folderSources 清空，旧会话的后续帧被丢弃", () => {
    let s = withFolderSource("session-A", [sourceA]);
    expect(s.folderSources).toHaveLength(1);

    // 切换到 session-B
    s = workspaceReducer(s, {
      kind: "sessionMeta",
      data: { sessionId: "session-B", title: "B" },
    });
    expect(s.folderSources).toEqual([]);

    // 旧 session-A 的 folderSourcesChanged 帧（网络延迟到达）→ 被丢弃
    s = workspaceReducer(s, {
      kind: "folderSourcesChanged",
      data: { sessionId: "session-A", sources: [sourceA] },
    });
    expect(s.folderSources).toEqual([]);
    expect(s.sessionId).toBe("session-B");
  });

  it("T2-B: 切换会话后新会话的 folderSourcesChanged 正常生效", () => {
    let s = withFolderSource("session-A", [sourceA]);

    // 切换到 session-B
    s = workspaceReducer(s, {
      kind: "sessionMeta",
      data: { sessionId: "session-B", title: "B" },
    });

    // session-B 的 folderSourcesChanged
    s = workspaceReducer(s, {
      kind: "folderSourcesChanged",
      data: { sessionId: "session-B", sources: [sourceB] },
    });
    expect(s.folderSources).toHaveLength(1);
    expect(s.folderSources[0]?.id).toBe("fld_B");
    expect(s.folderSources[0]?.name).toBe("文件夹 B");
  });

  it("T2-C: 重连同一会话（sessionMeta with same sessionId）不触发状态重置", () => {
    // 重连场景：sessionMeta 到来但 sessionId 相同 → isSessionSwitch = false → 不 reset
    let s = withFolderSource("session-A", [sourceA]);
    expect(s.folderSources).toHaveLength(1);

    // 再次 dispatch 同 sessionId 的 sessionMeta（重连）
    s = workspaceReducer(s, {
      kind: "sessionMeta",
      data: { sessionId: "session-A", title: "A 重连" },
    });

    // 关键断言：同 sessionId 的 sessionMeta 不应清空 folderSources
    expect(s.folderSources).toHaveLength(1);
    expect(s.folderSources[0]?.id).toBe("fld_A");
    expect(s.title).toBe("A 重连");  // 标题应该更新
  });

  it("T2-D: null → new sessionId（首次加载）不触发重置", () => {
    // state.sessionId 为 null（初始） → 收到第一个 sessionMeta
    // isSessionSwitch = null !== null... → 是 false（null 不是切换）
    const s = workspaceReducer(initialWorkspaceState, {
      kind: "sessionMeta",
      data: { sessionId: "session-first", title: "首次" },
    });

    // 不应重置（避免乐观 message 被清掉）
    expect(s.sessionId).toBe("session-first");
    expect(s.messages).toEqual([]);  // 初始就是空的，OK
  });

  it("T2-E: session-A → session-B → session-A（三次切换）状态正确", () => {
    let s = withFolderSource("session-A", [sourceA]);

    // 切到 B
    s = workspaceReducer(s, {
      kind: "sessionMeta",
      data: { sessionId: "session-B", title: "B" },
    });
    expect(s.folderSources).toEqual([]);

    // 切回 A
    s = workspaceReducer(s, {
      kind: "sessionMeta",
      data: { sessionId: "session-A", title: "A再来" },
    });
    // B → A 是切换，所以 folderSources 应仍为空（session-A 的 folderSource 需要新帧来填）
    expect(s.folderSources).toEqual([]);

    // session-A 的 folderSourcesChanged 到来
    s = workspaceReducer(s, {
      kind: "folderSourcesChanged",
      data: { sessionId: "session-A", sources: [sourceA] },
    });
    expect(s.folderSources).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────
// T3: folderSource 状态更新后 page-layer folderSource 选取逻辑
// ────────────────────────────────────────────────────────────
describe("T3: page-layer folderSource 选取（folderSources[0]）", () => {
  it("T3-A: 单 source 时 folderSources[0] 即该 source", () => {
    const s = withFolderSource("s", [sourceA]);
    expect(s.folderSources[0] ?? null).toEqual(sourceA);
  });

  it("T3-B: 空 sources 时 folderSources[0] 为 undefined（页面层 ?? null 得 null）", () => {
    const s = withFolderSource("s", []);
    expect(s.folderSources[0] ?? null).toBeNull();
  });

  it("T3-C: status 更新帧（offline）后 page-layer 拿到新状态", () => {
    let s = withFolderSource("s", [sourceA]);
    s = workspaceReducer(s, {
      kind: "folderSourcesChanged",
      data: { sessionId: "s", sources: [sourceAOffline] },
    });
    const pageFolderSource = s.folderSources[0] ?? null;
    expect(pageFolderSource?.status).toBe("offline");
  });

  it("T3-D: 连续 offline → error 更新，page-layer 拿到最终 error 状态", () => {
    let s = withFolderSource("s", [sourceA]);

    s = workspaceReducer(s, {
      kind: "folderSourcesChanged",
      data: { sessionId: "s", sources: [sourceAOffline] },
    });
    expect(s.folderSources[0]?.status).toBe("offline");

    s = workspaceReducer(s, {
      kind: "folderSourcesChanged",
      data: { sessionId: "s", sources: [sourceAError] },
    });
    const pageFolderSource = s.folderSources[0] ?? null;
    expect(pageFolderSource?.status).toBe("error");
    expect(pageFolderSource?.error).toBe("EACCES: permission denied");
  });
});

// ────────────────────────────────────────────────────────────
// T4: 极端边界 — 初始 sessionId=null 的 folderSourcesChanged 守卫
// ────────────────────────────────────────────────────────────
describe("T4: 初始 sessionId=null 时的守卫", () => {
  it("T4-A: initialWorkspaceState.sessionId=null，任意 folderSourcesChanged 都应被忽略", () => {
    // 关键：action.data.sessionId !== draft.sessionId (null)，所以应该被忽略
    const next = workspaceReducer(initialWorkspaceState, {
      kind: "folderSourcesChanged",
      data: { sessionId: "session-X", sources: [sourceA] },
    });
    expect(next.folderSources).toEqual([]);
    expect(next.sessionId).toBeNull();
  });

  it("T4-B: null !== 'session-A'，守卫生效（不是偶然的）", () => {
    // 这个测试验证守卫的类型安全性：null 不等于任何字符串
    const result = workspaceReducer(initialWorkspaceState, {
      kind: "folderSourcesChanged",
      data: { sessionId: "session-A", sources: [sourceA] },
    });
    // 守卫 if (action.data.sessionId !== draft.sessionId) return;
    // null !== "session-A" → true → return → folderSources 不变
    expect(result.folderSources).toHaveLength(0);
  });
});
