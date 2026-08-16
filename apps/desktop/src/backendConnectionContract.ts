import type { AttachCapabilities } from "@qingagent/contract-ts";

export const BACKEND_CONNECTION_GET_CHANNEL = "qingagent:backend-connection-get";
export const BACKEND_CONNECTION_CHANGED_CHANNEL = "qingagent:backend-connection-changed";
export const BACKEND_STARTUP_PROMPT_CHANNEL = "qingagent:backend-startup-prompt";
export const BACKEND_STARTUP_ACTION_CHANNEL = "qingagent:backend-startup-action";
export const BACKEND_CONNECTION_RETRY_CHANNEL = "qingagent:backend-connection-retry";

export type BackendMode = "embedded" | "attach";
export type AttachConnectionStatus =
  | "connecting"
  | "authenticating"
  | "attached"
  | "revalidating"
  | "reauthenticating"
  | "dead"
  | "incompatible"
  | "conflict";

export interface BackendConnectionSnapshot {
  mode: BackendMode;
  status: AttachConnectionStatus;
  generation: number;
  libraryId: string | null;
  instanceId: string | null;
  effectiveCapabilities: AttachCapabilities;
  errorCode: string | null;
  conflictKind: "pending-conflict" | "conflict" | null;
}

export interface BackendStartupCandidateView {
  id: string;
  port: number;
  startedAt: string;
  version: string;
}

export type BackendStartupPrompt =
  | {
      id: number;
      kind: "blocked";
      title: string;
      message: string;
      errorCodes: string[];
      allowUnbind: boolean;
    }
  | {
      id: number;
      kind: "select";
      title: string;
      message: string;
      candidates: BackendStartupCandidateView[];
    };

export type BackendStartupAction =
  | { promptId: number; kind: "retry" }
  | { promptId: number; kind: "unbind" }
  | { promptId: number; kind: "select"; candidateId: string };

export function isBackendStartupAction(value: unknown): value is BackendStartupAction {
  if (!value || typeof value !== "object") return false;
  const action = value as Record<string, unknown>;
  if (!Number.isSafeInteger(action.promptId)) return false;
  if (action.kind === "retry" || action.kind === "unbind") return true;
  return action.kind === "select" && typeof action.candidateId === "string";
}
