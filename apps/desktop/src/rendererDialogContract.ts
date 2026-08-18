export const DESKTOP_DIALOG_REQUEST_CHANNEL = "qingagent:desktop-dialog-request";
export const DESKTOP_DIALOG_READY_CHANNEL = "qingagent:desktop-dialog-ready";
export const DESKTOP_DIALOG_RESPONSE_CHANNEL = "qingagent:desktop-dialog-response";

export type DesktopDialogKind =
  | "quit-during-generation"
  | "content-load-failed"
  | "renderer-recovery-stopped"
  | "backend-startup-failed"
  | "database-migration-failed";

export type DesktopDialogResult = "confirm" | "cancel";

export interface DesktopDialogRequest {
  id: number;
  kind: DesktopDialogKind;
}

export interface DesktopDialogResponse {
  id: number;
  result: DesktopDialogResult;
}

export function isDesktopDialogKind(value: unknown): value is DesktopDialogKind {
  return value === "quit-during-generation"
    || value === "content-load-failed"
    || value === "renderer-recovery-stopped"
    || value === "backend-startup-failed"
    || value === "database-migration-failed";
}
