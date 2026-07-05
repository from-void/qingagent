/**
 * Round 2 评测探针 — reducer 层 folderSources 边界测试
 * 文件位置：apps/web/src/pages/workspace/data/__e2e__folderReducer.test.ts
 * 跑法：cd apps/web && npx vitest run src/pages/workspace/data/__e2e__folderReducer.test.ts
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

describe("folderSourcesChanged reducer", () => {
  it("正常：同 sessionId 全量替换", () => {
    const state = withSession("session-A");
    const next = workspaceReducer(state, {
      kind: "folderSourcesChanged",
      data: { sessionId: "session-A", sources: [sourceA] },
    });
    expect(next.folderSources).toEqual([sourceA]);
  });

  it("全量清空：sources=[] 替换为空数组", () => {
    const state = workspaceReducer(withSession("session-A"), {
      kind: "folderSourcesChanged",
      data: { sessionId: "session-A", sources: [sourceA] },
    });
    const cleared = workspaceReducer(state, {
      kind: "folderSourcesChanged",
      data: { sessionId: "session-A", sources: [] },
    });
    expect(cleared.folderSources).toEqual([]);
  });

  it("跨会话事件：folderSourcesChanged 会被忽略，不污染当前 session", () => {
    const state = withSession("session-A");
    const next = workspaceReducer(state, {
      kind: "folderSourcesChanged",
      data: { sessionId: "session-B", sources: [sourceB] },
    });
    expect(next.folderSources).toEqual([]);
  });

  it("会话切换后 folderSources 被重置", () => {
    const state = workspaceReducer(withSession("session-A"), {
      kind: "folderSourcesChanged",
      data: { sessionId: "session-A", sources: [sourceA] },
    });
    expect(state.folderSources).toHaveLength(1);

    // 切换会话
    const switched = workspaceReducer(state, {
      kind: "sessionMeta",
      data: { sessionId: "session-B", title: "B" },
    });
    expect(switched.folderSources).toEqual([]);
  });

  it("folderSourceOperationResult 是 no-op（不改变 folderSources）", () => {
    const state = workspaceReducer(withSession("session-A"), {
      kind: "folderSourcesChanged",
      data: { sessionId: "session-A", sources: [sourceA] },
    });
    const next = workspaceReducer(state, {
      kind: "folderSourceOperationResult",
      data: { ok: true, op: "attach", folderId: "fld_A" },
    });
    expect(next.folderSources).toEqual(state.folderSources);
  });

  it("【边界】多个 source：state.folderSources[0] 取第一个（P0 设计），第二个被丢弃", () => {
    // 验证 WorkspacePage 的 folderSource = state.folderSources[0] ?? null 行为
    // reducer 层支持多个，但页面只用第一个
    const state = withSession("session-A");
    const next = workspaceReducer(state, {
      kind: "folderSourcesChanged",
      data: { sessionId: "session-A", sources: [sourceA, sourceB] },
    });
    // reducer 层持有多个
    expect(next.folderSources).toHaveLength(2);
    // 但页面层 folderSource = folderSources[0] 只取第一个
    const pageLayerFolderSource = next.folderSources[0] ?? null;
    expect(pageLayerFolderSource).toEqual(sourceA);
    // 第二个被静默丢弃（P0 only-one policy）
    expect(next.folderSources[1]).toEqual(sourceB);
  });
});
