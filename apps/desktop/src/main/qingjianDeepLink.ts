import type { QingjianOpenSessionIntent } from "../qingjianDeepLinkContract.js";

export const QINGJIAN_PROTOCOL = "qingjian";
const QINGJIAN_DEEP_LINK_MAX_LENGTH = 2_048;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type QingjianDeepLinkHandler = (intent: QingjianOpenSessionIntent) => void;

/** 只接受 qingjian://open?engineSessionId=<uuid>，拒绝额外动作、字段与非 UUID 标识。 */
export function parseQingjianDeepLink(rawUrl: string): QingjianOpenSessionIntent | null {
  if (rawUrl.length === 0 || rawUrl.length > QINGJIAN_DEEP_LINK_MAX_LENGTH) return null;
  try {
    const url = new URL(rawUrl);
    const engineSessionId = url.searchParams.get("engineSessionId");
    if (
      url.protocol !== `${QINGJIAN_PROTOCOL}:`
      || url.host.toLowerCase() !== "open"
      || url.username !== ""
      || url.password !== ""
      || (url.pathname !== "" && url.pathname !== "/")
      || url.hash !== ""
      || url.searchParams.size !== 1
      || !engineSessionId
      || !UUID_PATTERN.test(engineSessionId)
    ) return null;
    return { engineSessionId };
  } catch {
    return null;
  }
}

/** 首启 argv、second-instance argv 与 macOS open-url 共用的 latest-wins 暂存器。 */
export class QingjianDeepLinkDispatcher {
  #pendingIntent: QingjianOpenSessionIntent | null = null;
  #handler: QingjianDeepLinkHandler | null = null;

  constructor(commandLine: readonly string[] = []) {
    this.offerCommandLine(commandLine);
  }

  offerUrl(rawUrl: string): boolean {
    const intent = parseQingjianDeepLink(rawUrl);
    if (!intent) return false;
    this.#pendingIntent = intent;
    this.#flush();
    return true;
  }

  offerCommandLine(commandLine: readonly string[]): boolean {
    let accepted: QingjianOpenSessionIntent | null = null;
    for (const argument of commandLine) {
      const candidate = parseQingjianDeepLink(argument);
      if (candidate) accepted = candidate;
    }
    if (!accepted) return false;
    this.#pendingIntent = accepted;
    this.#flush();
    return true;
  }

  setHandler(handler: QingjianDeepLinkHandler): boolean {
    this.#handler = handler;
    return this.#flush();
  }

  clearHandler(handler: QingjianDeepLinkHandler): void {
    if (this.#handler === handler) this.#handler = null;
  }

  #flush(): boolean {
    if (!this.#handler || !this.#pendingIntent) return false;
    const intent = this.#pendingIntent;
    this.#pendingIntent = null;
    this.#handler(intent);
    return true;
  }
}

export interface ProtocolClientApp {
  setAsDefaultProtocolClient(protocol: string, path?: string, args?: string[]): boolean;
}

/** 开发态把 scheme 注册回当前 Electron + 入口脚本；安装包直接注册应用本身。 */
export function registerQingjianProtocolClient(
  protocolApp: ProtocolClientApp,
  options: { defaultApp: boolean; execPath: string; entryScript?: string },
): boolean {
  if (options.defaultApp && options.entryScript) {
    return protocolApp.setAsDefaultProtocolClient(
      QINGJIAN_PROTOCOL,
      options.execPath,
      [options.entryScript],
    );
  }
  return protocolApp.setAsDefaultProtocolClient(QINGJIAN_PROTOCOL);
}
