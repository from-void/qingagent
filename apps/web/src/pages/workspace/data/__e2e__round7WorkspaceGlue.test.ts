/**
 * Round 7 评测探针 — WorkspacePage 胶水层与切会话
 * 文件位置：e2e-folder/round7/workspaceGlue.test.ts
 * 跑法：cd apps/web && npx vitest run ../../e2e-folder/round7/workspaceGlue.test.ts
 *
 * 覆盖范围（纯 reducer + 静态逻辑，不依赖 jsdom/DOM）：
 *   A. folderSourcesChanged → folderSources 不串：sessionId 守卫
 *   B. 快速切会话 A→B→A：folderSources 无残留
 *   C. pending folderSources 守卫：detachFolder 在 sessionId=null 时不发命令
 *   D. folderSourceOperationResult 失败帧文案完整覆盖 attach+detach × 各 reason
 *   E. deriveFolderCapability 三态（desktop/web/unsupported）返回值
 *   F. folderSourcesChanged 在会话切换前后不泄漏
 *   G. resetSessionScopedStateMut 重置含 folderSources（已修 R2-B1）回归测试
 *   H. workspaceState stream pending 不跨会话：streamActive 在切会话时被清零
 */
import { describe, expect, it } from "vitest";
import type { FolderSource } from "@qingagent/contract-ts";
import type { FolderSourceOperationResult } from "@qingagent/contract-ts";
import { folderSourceOperationFailureToast } from "./folderAttach";
import {
  deriveFolderCapabilityForTest,
} from "./r7helpers";
import * as round7Helpers from "./r7helpers";
import {
  workspaceReducer,
  initialWorkspaceState,
} from "./workspaceState";

// ───── fixtures ─────

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

function withFolderSource(sessionId: string, source: FolderSource) {
  return workspaceReducer(withSession(sessionId), {
    kind: "folderSourcesChanged",
    data: { sessionId, sources: [source] },
  });
}

// ───── A. folderSourcesChanged sessionId 守卫 ─────

describe("A. folderSourcesChanged → sessionId 守卫不串", () => {
  it("同 sessionId 帧正常更新", () => {
    const state = withSession("session-A");
    const next = workspaceReducer(state, {
      kind: "folderSourcesChanged",
      data: { sessionId: "session-A", sources: [sourceA] },
    });
    expect(next.folderSources).toEqual([sourceA]);
  });

  it("跨会话帧被忽略，当前 session folderSources 不变", () => {
    const state = withSession("session-A");
    // 当前 session-A 没有 folder，收到 session-B 的帧
    const next = workspaceReducer(state, {
      kind: "folderSourcesChanged",
      data: { sessionId: "session-B", sources: [sourceB] },
    });
    expect(next.folderSources).toEqual([]);
  });

  it("收到当前 session 帧后，再收到旧 session 帧不污染", () => {
    const state = withFolderSource("session-A", sourceA);
    expect(state.folderSources).toHaveLength(1);

    // 收到陌生 session 帧
    const next = workspaceReducer(state, {
      kind: "folderSourcesChanged",
      data: { sessionId: "session-X", sources: [] },
    });
    expect(next.folderSources).toEqual([sourceA]);
  });
});

// ───── B. 快速切会话 A→B→A folderSources 不残留 ─────

describe("B. 快速切会话 A→B→A folderSources 无残留", () => {
  it("A 切 B 时 folderSources 被清空（resetSessionScopedState）", () => {
    const stateA = withFolderSource("session-A", sourceA);
    expect(stateA.folderSources).toHaveLength(1);

    const stateB = workspaceReducer(stateA, {
      kind: "sessionMeta",
      data: { sessionId: "session-B", title: "B" },
    });
    expect(stateB.folderSources).toEqual([]);
    expect(stateB.sessionId).toBe("session-B");
  });

  it("B 再切 A，之前 A 的旧 folderSourcesChanged 帧不能渗透（sessionId 守卫）", () => {
    // 模拟：session-A 有 folder，切 B，再切回 A，再来一帧 session-A 的 folderSourcesChanged
    const stateA = withFolderSource("session-A", sourceA);
    const stateB = workspaceReducer(stateA, {
      kind: "sessionMeta",
      data: { sessionId: "session-B", title: "B" },
    });
    const stateA2 = workspaceReducer(stateB, {
      kind: "sessionMeta",
      data: { sessionId: "session-A", title: "A" },
    });
    // 回到 session-A 后，状态被再次 reset（因为 session-B → session-A 是切换）
    expect(stateA2.folderSources).toEqual([]);

    // 现在来一帧 session-A 的真实 folderSourcesChanged（模拟后端补帧）
    const afterFrame = workspaceReducer(stateA2, {
      kind: "folderSourcesChanged",
      data: { sessionId: "session-A", sources: [sourceA] },
    });
    expect(afterFrame.folderSources).toEqual([sourceA]);

    // session-B 的帧不影响
    const withBFrame = workspaceReducer(afterFrame, {
      kind: "folderSourcesChanged",
      data: { sessionId: "session-B", sources: [sourceB] },
    });
    expect(withBFrame.folderSources).toEqual([sourceA]);
  });

  it("连续切换三次（A→B→A→B）每次 folderSources 都被正确清空", () => {
    let state = withFolderSource("session-A", sourceA);
    expect(state.folderSources).toHaveLength(1);

    state = workspaceReducer(state, {
      kind: "sessionMeta",
      data: { sessionId: "session-B", title: "B" },
    });
    expect(state.folderSources).toEqual([]);

    // 在 B 里加 folder
    state = workspaceReducer(state, {
      kind: "folderSourcesChanged",
      data: { sessionId: "session-B", sources: [sourceB] },
    });
    expect(state.folderSources).toHaveLength(1);

    state = workspaceReducer(state, {
      kind: "sessionMeta",
      data: { sessionId: "session-A", title: "A" },
    });
    expect(state.folderSources).toEqual([]);

    state = workspaceReducer(state, {
      kind: "sessionMeta",
      data: { sessionId: "session-B", title: "B" },
    });
    expect(state.folderSources).toEqual([]);
  });
});

// ───── C. pending 不跨会话 —— streamActive 在 sessionMeta 切换时被清零 ─────

describe("C. streamActive/pending 不跨会话", () => {
  it("切会话后 streamActive=false（resetSessionScopedState）", () => {
    // 模拟 stream 激活
    const stateWithStream = workspaceReducer(withSession("session-A"), {
      kind: "stream",
      data: { kind: "start", data: { streamId: "str-1" } },
    });
    expect(stateWithStream.streamActive).toBe(true);
    expect(stateWithStream.activeStreamIds).toContain("str-1");

    // 切换会话
    const switched = workspaceReducer(stateWithStream, {
      kind: "sessionMeta",
      data: { sessionId: "session-B", title: "B" },
    });
    expect(switched.streamActive).toBe(false);
    expect(switched.activeStreamIds).toEqual([]);
  });

  it("切回同 session：不 reset（optimistic 消息不丢失）", () => {
    const stateA = workspaceReducer(initialWorkspaceState, {
      kind: "sessionMeta",
      data: { sessionId: "session-A", title: "A" },
    });
    const withMsg = workspaceReducer(stateA, {
      kind: "chatMessageAdded",
      data: {
        message: {
          id: "m-opt-1",
          role: { kind: "user" },
          ts: "2026-06-18T00:00:00.000Z",
          parts: [{ kind: "text", data: { body: "test" } }],
          chips: null,
        },
      },
    });
    expect(withMsg.messages).toHaveLength(1);

    // 再次收到同 sessionId 的 sessionMeta（不算切换）
    const sameSession = workspaceReducer(withMsg, {
      kind: "sessionMeta",
      data: { sessionId: "session-A", title: "A updated" },
    });
    // 消息不丢失（非 session switch，不 reset）
    expect(sameSession.messages).toHaveLength(1);
  });
});

// ───── D. folderSourceOperationResult 失败帧文案完整覆盖 ─────

describe("D. folderSourceOperationResult 失败帧文案（folderAttach.folderSourceOperationFailureToast）", () => {
  const ATTACH_REASONS: Array<Extract<FolderSourceOperationResult, { ok: false }>["reason"]> = [
    "agent_busy",
    "unsupported_environment",
    "not_found",
    "too_many_sources",
    "permission_denied",
    "invalid_path",
    "bridge_offline",
    "unknown",
  ];

  it("失败文案测试不通过 r7helpers 镜像生产逻辑", () => {
    expect(round7Helpers).not.toHaveProperty("folderSourceOperationFailureToastForTest");
  });

  for (const reason of ATTACH_REASONS) {
    it(`attach 失败 reason="${reason}" 文案包含"连接文件夹失败"`, () => {
      const toast = folderSourceOperationFailureToast({
        ok: false,
        op: "attach",
        requestId: "attach-test",
        clientSourceId: null,
        reason,
      });
      expect(toast).toContain("连接文件夹失败");
      expect(toast.length).toBeGreaterThan(0);
    });
  }

  for (const reason of ATTACH_REASONS) {
    it(`detach 失败 reason="${reason}" 文案包含"断开文件夹失败"`, () => {
      const toast = folderSourceOperationFailureToast({
        ok: false,
        op: "detach",
        reason,
      });
      expect(toast).toContain("断开文件夹失败");
    });
  }

  it("reason=agent_busy 文案含 '青简正在处理'", () => {
    const toast = folderSourceOperationFailureToast({
      ok: false,
      op: "attach",
      requestId: "attach-test",
      clientSourceId: null,
      reason: "agent_busy",
    });
    expect(toast).toContain("青简正在处理");
  });

  it("reason=too_many_sources 文案含 '暂只支持连接一个'", () => {
    const toast = folderSourceOperationFailureToast({
      ok: false,
      op: "attach",
      requestId: "attach-test",
      clientSourceId: null,
      reason: "too_many_sources",
    });
    expect(toast).toContain("暂只支持连接一个");
  });

  it("reason=bridge_offline 文案含 '文件夹桥接未就绪'", () => {
    const toast = folderSourceOperationFailureToast({
      ok: false,
      op: "attach",
      requestId: "attach-test",
      clientSourceId: null,
      reason: "bridge_offline",
    });
    expect(toast).toContain("文件夹桥接未就绪");
  });
});

// ───── E. deriveFolderCapability 三态 ─────

describe("E. deriveFolderCapability 三态返回值", () => {
  it("桌面端 server 能力开启时 enabled=true", () => {
    const cap = deriveFolderCapabilityForTest({
      isDesktop: true,
    });
    expect(cap.enabled).toBe(true);
    expect(cap.reason).toBeNull();
  });

  it("桌面端 = false + showDirectoryPicker 存在(PC 浏览器) → enabled=true", () => {
    const cap = deriveFolderCapabilityForTest({
      isDesktop: false,
      hasShowDirectoryPicker: true,
      isSecureContext: true,
      isMobile: false,
    });
    expect(cap.enabled).toBe(true);
    expect(cap.reason).toBeNull();
  });

  it("server 未通告浏览器 folder 能力时，即使浏览器 API 可用也 disabled", () => {
    const cap = deriveFolderCapabilityForTest({
      isDesktop: false,
      hasShowDirectoryPicker: true,
      isSecureContext: true,
      isMobile: false,
      serverBrowserFolderSourcesEnabled: false,
    });
    expect(cap.enabled).toBe(false);
    expect(cap.reason).toContain("服务端未启用");
  });

  it("桌面端 = false + 无 showDirectoryPicker → enabled=false 含 '当前浏览器不支持'", () => {
    const cap = deriveFolderCapabilityForTest({
      isDesktop: false,
      hasShowDirectoryPicker: false,
      isSecureContext: true,
      isMobile: false,
    });
    expect(cap.enabled).toBe(false);
    expect(cap.reason).toContain("当前浏览器不支持");
  });

  it("桌面端 = false + showDirectoryPicker 存在 + 移动端 → enabled=false 含 '当前浏览器不支持'", () => {
    // 移动端即便有 showDirectoryPicker 也不被视为 webCapable
    const cap = deriveFolderCapabilityForTest({
      isDesktop: false,
      hasShowDirectoryPicker: true,
      isSecureContext: true,
      isMobile: true, // 移动端
    });
    expect(cap.enabled).toBe(false);
    // 移动端没有 webCapable，所以落到最后的 "当前浏览器不支持"
    expect(cap.reason).toContain("当前浏览器不支持");
  });

  it("桌面端 = false + showDirectoryPicker 存在 + isSecureContext=false → 不是 webCapable", () => {
    const cap = deriveFolderCapabilityForTest({
      isDesktop: false,
      hasShowDirectoryPicker: true,
      isSecureContext: false, // 非 HTTPS
      isMobile: false,
    });
    expect(cap.enabled).toBe(false);
    expect(cap.reason).toContain("当前浏览器不支持");
  });
});

// ───── F. folderSources 在 sessionMeta null→id 时不 reset（初始化路径）─────

describe("F. sessionMeta null→id 不触发 reset（optimistic 消息保留）", () => {
  it("初始 sessionId=null 收 sessionMeta 不 reset", () => {
    // initialWorkspaceState.sessionId = null
    const stateWithMsg = workspaceReducer(initialWorkspaceState, {
      kind: "chatMessageAdded",
      data: {
        message: {
          id: "m-opt-init",
          role: { kind: "user" },
          ts: "2026-06-18T00:00:00.000Z",
          parts: [{ kind: "text", data: { body: "初始消息" } }],
          chips: null,
        },
      },
    });
    expect(stateWithMsg.messages).toHaveLength(1);

    // 首次 sessionMeta（null→session-1）
    const afterSession = workspaceReducer(stateWithMsg, {
      kind: "sessionMeta",
      data: { sessionId: "session-1", title: "新会话" },
    });
    // 消息必须保留（isSessionSwitch = false，因为 draft.sessionId === null）
    expect(afterSession.messages).toHaveLength(1);
    expect(afterSession.sessionId).toBe("session-1");
  });

  it("初始 sessionId=null 收 folderSourcesChanged 守卫（draft.sessionId=null 不等于任何 sessionId）", () => {
    // initialWorkspaceState.sessionId = null，此时 folderSourcesChanged 的守卫
    // action.data.sessionId !== draft.sessionId → null !== "session-X" → 被忽略
    const state = workspaceReducer(initialWorkspaceState, {
      kind: "folderSourcesChanged",
      data: { sessionId: "session-X", sources: [sourceA] },
    });
    expect(state.folderSources).toEqual([]);
  });
});

// ───── G. R2-B1 回归：resetSessionScopedStateMut 包含 folderSources ─────

describe("G. R2-B1 回归：resetSessionScopedStateMut 含 folderSources", () => {
  it("切会话后 folderSources 被完全清空", () => {
    const stateA = withFolderSource("session-A", sourceA);
    expect(stateA.folderSources).toHaveLength(1);

    const stateB = workspaceReducer(stateA, {
      kind: "sessionMeta",
      data: { sessionId: "session-B", title: "B" },
    });
    // R2-B1 修后：folderSources 必须为空
    expect(stateB.folderSources).toEqual([]);
  });

  it("切回同 sessionId（非切换）folderSources 不被误清空", () => {
    const stateA = withFolderSource("session-A", sourceA);
    expect(stateA.folderSources).toHaveLength(1);

    // 同 sessionId 的 sessionMeta：isSessionSwitch=false，不 reset
    const sameA = workspaceReducer(stateA, {
      kind: "sessionMeta",
      data: { sessionId: "session-A", title: "A updated" },
    });
    expect(sameA.folderSources).toHaveLength(1);
    expect(sameA.folderSources[0]?.id).toBe("fld_A");
  });
});

// ───── H. folderSourceOperationResult reducer no-op（成功帧不改 folderSources）─────

describe("H. folderSourceOperationResult reducer 行为", () => {
  it("成功帧：reducer 不改变 folderSources（等 folderSourcesChanged 帧更新）", () => {
    const state = withFolderSource("session-A", sourceA);
    const next = workspaceReducer(state, {
      kind: "folderSourceOperationResult",
      data: {
        ok: true,
        op: "attach",
        requestId: "attach-a",
        clientSourceId: null,
        folderId: "fld_A",
      },
    });
    // folderSources 不变（由 folderSourcesChanged 更新）
    expect(next.folderSources).toEqual(state.folderSources);
  });

  it("失败帧：reducer 不改变 folderSources（toast 由 WorkspacePage stream 订阅发出）", () => {
    const state = withFolderSource("session-A", sourceA);
    const next = workspaceReducer(state, {
      kind: "folderSourceOperationResult",
      data: { ok: false, op: "detach", reason: "not_found" },
    });
    // folderSources 不变
    expect(next.folderSources).toEqual(state.folderSources);
  });
});
