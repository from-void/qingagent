export const WORKSPACE_HYDRATION_TIMEOUT_MS = 4_000;
export const WORKSPACE_DOCUMENT_LEAD_MS = 180;

export type WorkspaceHydrationPhase = "waiting" | "document-only" | "ready";
export type WorkspaceHydrationRevealMode =
  | "none"
  | "together"
  | "document-then-chat";

export interface WorkspaceHydrationState {
  sessionId: string | null;
  phase: WorkspaceHydrationPhase;
  revealMode: WorkspaceHydrationRevealMode;
  documentSeen: boolean;
  timedOut: boolean;
}

export type WorkspaceHydrationAction =
  | { kind: "begin"; sessionId: string | null }
  | { kind: "documentObserved"; sessionId: string }
  | { kind: "documentLeadElapsed"; sessionId: string }
  | { kind: "restoreCompleted"; sessionId: string }
  | { kind: "timeout"; sessionId: string };

export function initialWorkspaceHydration(
  sessionId: string | null,
): WorkspaceHydrationState {
  return {
    sessionId,
    phase: sessionId ? "waiting" : "ready",
    revealMode: "none",
    documentSeen: false,
    timedOut: false,
  };
}

export function workspaceHydrationReducer(
  state: WorkspaceHydrationState,
  action: WorkspaceHydrationAction,
): WorkspaceHydrationState {
  if (action.kind === "begin") {
    return initialWorkspaceHydration(action.sessionId);
  }
  if (state.sessionId !== action.sessionId || state.phase === "ready") {
    return state;
  }

  switch (action.kind) {
    case "documentObserved":
      return state.documentSeen ? state : { ...state, documentSeen: true };
    case "documentLeadElapsed":
      if (!state.documentSeen || state.phase !== "waiting") return state;
      return {
        ...state,
        phase: "document-only",
        revealMode: "document-then-chat",
      };
    case "restoreCompleted":
      return {
        ...state,
        phase: "ready",
        revealMode:
          state.revealMode === "document-then-chat"
            ? "document-then-chat"
            : "together",
      };
    case "timeout":
      return {
        ...state,
        phase: "ready",
        revealMode:
          state.revealMode === "document-then-chat"
            ? "document-then-chat"
            : "together",
        timedOut: true,
      };
  }
}
