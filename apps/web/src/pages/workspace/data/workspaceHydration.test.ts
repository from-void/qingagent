import { describe, expect, it } from "vitest";
import {
  initialWorkspaceHydration,
  workspaceHydrationReducer,
} from "./workspaceHydration";

describe("workspace hydration presentation gate", () => {
  it("新建会话立即呈现，不等待恢复帧", () => {
    expect(initialWorkspaceHydration(null)).toMatchObject({
      phase: "ready",
    });
  });

  it("既有正文必须同时等恢复完成与编辑器首帧可画", () => {
    const waiting = initialWorkspaceHydration("session-existing");
    expect(waiting.phase).toBe("waiting");

    const withDocument = workspaceHydrationReducer(waiting, {
      kind: "documentObserved",
      sessionId: "session-existing",
    });
    expect(withDocument.phase).toBe("waiting");

    const ready = workspaceHydrationReducer(withDocument, {
      kind: "restoreCompleted",
      sessionId: "session-existing",
    });
    expect(ready).toMatchObject({
      phase: "waiting",
      restoreCompleted: true,
      documentSurfaceReady: false,
    });

    expect(
      workspaceHydrationReducer(ready, {
        kind: "documentSurfaceReady",
        sessionId: "session-existing",
      }),
    ).toMatchObject({
      phase: "ready",
      restoreCompleted: true,
      documentSurfaceReady: true,
    });
  });

  it("编辑器先就绪时仍等待对话历史完成，再一次放行", () => {
    const observed = workspaceHydrationReducer(
      initialWorkspaceHydration("session-existing"),
      {
        kind: "documentObserved",
        sessionId: "session-existing",
      },
    );
    const surfaceReady = workspaceHydrationReducer(observed, {
      kind: "documentSurfaceReady",
      sessionId: "session-existing",
    });
    expect(surfaceReady.phase).toBe("waiting");

    expect(
      workspaceHydrationReducer(surfaceReady, {
        kind: "restoreCompleted",
        sessionId: "session-existing",
      }),
    ).toMatchObject({
      phase: "ready",
    });
  });

  it("无正文的既有会话在首批历史完成后即可呈现", () => {
    expect(
      workspaceHydrationReducer(
        initialWorkspaceHydration("session-empty"),
        {
          kind: "restoreCompleted",
          sessionId: "session-empty",
        },
      ),
    ).toMatchObject({
      phase: "ready",
      restoreCompleted: true,
      documentSeen: false,
    });
  });

  it("弱网超时后呈现当前已有部分，不无限等待", () => {
    const timedOut = workspaceHydrationReducer(
      initialWorkspaceHydration("session-slow"),
      { kind: "timeout", sessionId: "session-slow" },
    );
    expect(timedOut).toMatchObject({
      phase: "ready",
      timedOut: true,
    });
  });

  it("同一会话 ready 后重复 begin 永不回跳 waiting", () => {
    const ready = workspaceHydrationReducer(
      initialWorkspaceHydration("session-existing"),
      {
        kind: "restoreCompleted",
        sessionId: "session-existing",
      },
    );
    expect(ready.phase).toBe("ready");
    expect(
      workspaceHydrationReducer(ready, {
        kind: "begin",
        sessionId: "session-existing",
      }),
    ).toBe(ready);
  });

  it("waiting 内新 restore 批次清掉旧完成信号，但不重开 ready 门", () => {
    const firstBatchCompleted = workspaceHydrationReducer(
      workspaceHydrationReducer(
        initialWorkspaceHydration("session-existing"),
        {
          kind: "documentObserved",
          sessionId: "session-existing",
        },
      ),
      {
        kind: "restoreCompleted",
        sessionId: "session-existing",
      },
    );
    const resetWaiting = workspaceHydrationReducer(firstBatchCompleted, {
      kind: "restoreReset",
      sessionId: "session-existing",
    });
    expect(resetWaiting).toMatchObject({
      phase: "waiting",
      documentSeen: false,
      documentSurfaceReady: false,
      restoreCompleted: false,
    });

    const ready = workspaceHydrationReducer(
      initialWorkspaceHydration("session-existing"),
      {
        kind: "restoreCompleted",
        sessionId: "session-existing",
      },
    );
    expect(
      workspaceHydrationReducer(ready, {
        kind: "restoreReset",
        sessionId: "session-existing",
      }),
    ).toBe(ready);
  });

  it("工作区内切换会话才重新关门，旧会话晚帧不能开门", () => {
    const switched = workspaceHydrationReducer(
      initialWorkspaceHydration(null),
      { kind: "begin", sessionId: "session-next" },
    );
    expect(switched.phase).toBe("waiting");
    expect(
      workspaceHydrationReducer(switched, {
        kind: "restoreCompleted",
        sessionId: "session-old",
      }),
    ).toBe(switched);
  });
});
