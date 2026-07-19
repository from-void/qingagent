import type { UpdateStatusPayload } from "./updateTypes.js";

export interface UpdateStatusWindow {
  isDestroyed(): boolean;
  webContents: {
    send(channel: string, payload: UpdateStatusPayload): void;
  };
}

export class UpdateStatusDispatcher {
  private window: UpdateStatusWindow | null = null;
  private cachedStatus: UpdateStatusPayload | null = null;

  setWindow(window: UpdateStatusWindow): void {
    if (this.window === window) return;
    this.window = window;
    if (this.cachedStatus) this.sendToCurrentWindow(this.cachedStatus);
  }

  dispatch(payload: UpdateStatusPayload): void {
    this.cachedStatus = isReplayableStatus(payload) ? payload : null;
    this.sendToCurrentWindow(payload);
  }

  getStatus(): UpdateStatusPayload {
    return this.cachedStatus ?? { kind: "none" };
  }

  private sendToCurrentWindow(payload: UpdateStatusPayload): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    window.webContents.send("qingagent:update-status", payload);
  }
}

function isReplayableStatus(payload: UpdateStatusPayload): boolean {
  return payload.kind !== "none" && payload.kind !== "error";
}
