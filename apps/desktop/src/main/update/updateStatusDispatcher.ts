import type { UpdateStatusPayload } from "./updateTypes.js";
import { getLiveWebContents } from "../windowLifecycle.js";

export interface UpdateStatusWindow {
  isDestroyed(): boolean;
  webContents: {
    isDestroyed(): boolean;
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
    const contents = getLiveWebContents(window);
    if (!contents) return;
    try {
      contents.send("qingagent:update-status", payload);
    } catch {
      // 更新提示是旁路通知；renderer 正在销毁时 send 失败不能升级成主进程崩溃。
    }
  }
}

function isReplayableStatus(payload: UpdateStatusPayload): boolean {
  return payload.kind !== "none" && payload.kind !== "error";
}
