import {
  DESKTOP_DIALOG_REQUEST_CHANNEL,
  type DesktopDialogKind,
  type DesktopDialogRequest,
  type DesktopDialogResponse,
  type DesktopDialogResult,
} from "../rendererDialogContract.js";

export interface RendererDialogTarget {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: DesktopDialogRequest): void;
}

interface PendingDialog {
  target: RendererDialogTarget;
  resolve: (result: DesktopDialogResult | null) => void;
}

/**
 * 主进程只编排请求与回执，不生成产品 UI。null 表示 renderer 当前不可用，调用方才可走
 * 集中的原生兜底。导航/崩溃会立即释放等待，用户在正常自绘卡上思考时则不设武断超时。
 */
export class RendererDialogBroker {
  private nextRequestId = 1;
  private readonly readyKinds = new Map<number, Set<DesktopDialogKind>>();
  private readonly pending = new Map<number, PendingDialog>();

  markReady(target: RendererDialogTarget, kinds: readonly DesktopDialogKind[]): void {
    if (target.isDestroyed()) return;
    this.readyKinds.set(target.id, new Set(kinds));
  }

  markUnavailable(target: RendererDialogTarget): void {
    this.readyKinds.delete(target.id);
    for (const [id, pending] of this.pending) {
      if (pending.target.id !== target.id) continue;
      this.pending.delete(id);
      pending.resolve(null);
    }
  }

  request(
    target: RendererDialogTarget,
    kind: DesktopDialogKind,
  ): Promise<DesktopDialogResult | null> {
    if (target.isDestroyed() || !this.readyKinds.get(target.id)?.has(kind)) {
      return Promise.resolve(null);
    }

    const request: DesktopDialogRequest = {
      id: this.nextRequestId++,
      kind,
    };
    return new Promise((resolve) => {
      this.pending.set(request.id, { target, resolve });
      try {
        target.send(DESKTOP_DIALOG_REQUEST_CHANNEL, request);
      } catch {
        this.pending.delete(request.id);
        this.readyKinds.delete(target.id);
        resolve(null);
      }
    });
  }

  respond(target: RendererDialogTarget, response: DesktopDialogResponse): boolean {
    const pending = this.pending.get(response.id);
    if (!pending || pending.target.id !== target.id) return false;
    this.pending.delete(response.id);
    pending.resolve(response.result);
    return true;
  }
}
