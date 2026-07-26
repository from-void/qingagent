export const WORKSPACE_HYDRATION_TIMEOUT_MS = 4_000;

export type WorkspaceHydrationPhase = "waiting" | "ready";

export interface WorkspaceHydrationState {
  sessionId: string | null;
  phase: WorkspaceHydrationPhase;
  documentSeen: boolean;
  documentSurfaceReady: boolean;
  restoreCompleted: boolean;
  timedOut: boolean;
}

export type WorkspaceHydrationAction =
  | { kind: "begin"; sessionId: string | null }
  | { kind: "restoreReset"; sessionId: string }
  | { kind: "documentObserved"; sessionId: string }
  | { kind: "documentSurfaceReady"; sessionId: string }
  | { kind: "restoreCompleted"; sessionId: string }
  | { kind: "timeout"; sessionId: string };

export function initialWorkspaceHydration(
  sessionId: string | null,
): WorkspaceHydrationState {
  return {
    sessionId,
    phase: sessionId ? "waiting" : "ready",
    documentSeen: false,
    documentSurfaceReady: false,
    restoreCompleted: false,
    timedOut: false,
  };
}

function settleWorkspaceHydration(
  state: WorkspaceHydrationState,
): WorkspaceHydrationState {
  if (
    state.phase === "ready" ||
    !state.restoreCompleted ||
    (state.documentSeen && !state.documentSurfaceReady)
  ) {
    return state;
  }
  return { ...state, phase: "ready" };
}

export function workspaceHydrationReducer(
  state: WorkspaceHydrationState,
  action: WorkspaceHydrationAction,
): WorkspaceHydrationState {
  if (action.kind === "begin") {
    // 同一会话只允许 waiting → ready。重连、重复 startSession 或 effect
    // 重跑都不能把已经成画的工作区重新关门。
    if (state.sessionId === action.sessionId) return state;
    return initialWorkspaceHydration(action.sessionId);
  }
  if (state.sessionId !== action.sessionId || state.phase === "ready") {
    return state;
  }

  switch (action.kind) {
    case "restoreReset":
      if (
        !state.documentSeen &&
        !state.documentSurfaceReady &&
        !state.restoreCompleted
      ) {
        return state;
      }
      // waiting 相位不变、绝对超时不重启，只丢弃上一恢复批次的半成品信号。
      return {
        ...state,
        documentSeen: false,
        documentSurfaceReady: false,
        restoreCompleted: false,
      };
    case "documentObserved":
      return state.documentSeen ? state : { ...state, documentSeen: true };
    case "documentSurfaceReady":
      if (!state.documentSeen || state.documentSurfaceReady) return state;
      return settleWorkspaceHydration({
        ...state,
        documentSurfaceReady: true,
      });
    case "restoreCompleted":
      return settleWorkspaceHydration({
        ...state,
        restoreCompleted: true,
      });
    case "timeout":
      return {
        ...state,
        phase: "ready",
        timedOut: true,
      };
  }
}
