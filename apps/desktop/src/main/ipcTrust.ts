export interface TrustedRendererLike {
  readonly mainFrame?: unknown;
  isDestroyed?: () => boolean;
}

export interface TrustedIpcEventLike {
  readonly sender: TrustedRendererLike;
  readonly senderFrame?: unknown;
}

export class UntrustedRendererIpcError extends Error {
  readonly code = "UNTRUSTED_RENDERER_IPC";

  constructor() {
    super("拒绝来自非主窗口 mainFrame 的 IPC 请求");
    this.name = "UntrustedRendererIpcError";
  }
}

/** 同时校验 webContents 身份与 mainFrame，拒绝其他窗口、DevTools/子 frame 伪造 IPC。 */
export function assertTrustedRenderer(
  event: TrustedIpcEventLike,
  trustedRenderer: TrustedRendererLike | null,
): void {
  if (
    !trustedRenderer ||
    trustedRenderer.isDestroyed?.() ||
    event.sender !== trustedRenderer ||
    event.senderFrame !== trustedRenderer.mainFrame
  ) {
    throw new UntrustedRendererIpcError();
  }
}
