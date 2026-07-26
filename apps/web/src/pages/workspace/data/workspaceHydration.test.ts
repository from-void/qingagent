import { describe, expect, it } from "vitest";
import {
  initialWorkspaceHydration,
  workspaceHydrationReducer,
} from "./workspaceHydration";

describe("workspace hydration presentation gate", () => {
  it("新建会话立即呈现，不等待恢复帧", () => {
    expect(initialWorkspaceHydration(null)).toMatchObject({
      phase: "ready",
      revealMode: "none",
    });
  });

  it("既有会话在恢复完成前不呈现空文档或空对话", () => {
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
      phase: "ready",
      revealMode: "together",
    });
  });

  it("文档明显领先时先呈现主体，恢复完成后再补对话", () => {
    const waiting = workspaceHydrationReducer(
      initialWorkspaceHydration("session-existing"),
      { kind: "documentObserved", sessionId: "session-existing" },
    );
    const documentOnly = workspaceHydrationReducer(waiting, {
      kind: "documentLeadElapsed",
      sessionId: "session-existing",
    });
    expect(documentOnly).toMatchObject({
      phase: "document-only",
      revealMode: "document-then-chat",
    });

    expect(
      workspaceHydrationReducer(documentOnly, {
        kind: "restoreCompleted",
        sessionId: "session-existing",
      }),
    ).toMatchObject({
      phase: "ready",
      revealMode: "document-then-chat",
    });
  });

  it("弱网超时后呈现当前已有部分，不无限等待", () => {
    const timedOut = workspaceHydrationReducer(
      initialWorkspaceHydration("session-slow"),
      { kind: "timeout", sessionId: "session-slow" },
    );
    expect(timedOut).toMatchObject({
      phase: "ready",
      revealMode: "together",
      timedOut: true,
    });
  });

  it("工作区内切换既有会话时重新关门，旧会话晚帧不能开门", () => {
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
