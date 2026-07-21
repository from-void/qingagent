export const TRUSTED_REMEMBER_INPUT_TTL_MS = 2_000;

const trustedInputTypes = new Set([
  "keyDown",
  "mouseDown",
  "pointerDown",
  "touchStart",
]);

interface TrustedInput {
  senderId: number;
  at: number;
}

export type RememberGrantKind = "install" | "command";
export type RememberGrantPurpose = "confirm" | "settings";

export interface RememberMessageBoxOptions {
  type: "question";
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  noLink: boolean;
}

function rememberCategoryCopy(kind: RememberGrantKind): {
  label: string;
  futureSubject: string;
  settingsSubject: string;
} {
  return kind === "install"
    ? {
        label: "安装指令",
        futureSubject: "以后的安装指令",
        settingsSubject: "安装指令",
      }
    : {
        label: "此类命令",
        futureSubject: "以后的同类命令",
        settingsSubject: "同类命令",
      };
}

export function buildRememberMessageBoxOptions(input: {
  purpose: RememberGrantPurpose;
  kind: RememberGrantKind;
}): RememberMessageBoxOptions {
  const copy = rememberCategoryCopy(input.kind);
  return {
    type: "question",
    title: "记住这类操作？",
    message: input.purpose === "confirm"
      ? `记住${copy.label}？`
      : `为${copy.label}开启默认同意？`,
    detail: input.purpose === "confirm"
      ? `${copy.futureSubject}将不再逐次询问，直接执行。可在 设置 → 安全 里随时改回。`
      : `开启后，${copy.settingsSubject}将不再逐次询问，直接执行。可在 设置 → 安全 里随时改回。`,
    buttons: ["记住", "暂不"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
}

/**
 * 原生确认与 nonce 登记的串行闸门。renderer 即使搭车调用 IPC，也只能唤起一个
 * 明示类别与后果的主进程 modal；只有用户点「记住」后才会登记 nonce。
 */
export class NativeRememberGrantGate {
  #pending = false;

  async request(input: {
    purpose: RememberGrantPurpose;
    kind: RememberGrantKind;
    showMessageBox: (
      options: RememberMessageBoxOptions,
    ) => Promise<{ response: number }>;
    register: () => Promise<string> | string;
  }): Promise<string | null> {
    if (this.#pending) return null;
    this.#pending = true;
    try {
      const result = await input.showMessageBox(buildRememberMessageBoxOptions(input));
      if (result.response !== 0) return null;
      return await input.register();
    } finally {
      this.#pending = false;
    }
  }
}

/**
 * 主进程持有的真实输入闸门。renderer 只能请求消费，不能自行登记输入。
 * 每次物理输入至多签发一个 remember nonce，失焦、devtools 或过期均拒绝。
 */
export class TrustedRememberUiGate {
  readonly #now: () => number;
  #lastInput: TrustedInput | null = null;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  record(senderId: number, inputType: string): void {
    if (!trustedInputTypes.has(inputType)) return;
    this.#lastInput = { senderId, at: this.#now() };
  }

  consume(input: {
    senderId: number;
    mainWindowSenderId: number | null;
    windowFocused: boolean;
    senderIsDevtools: boolean;
  }): boolean {
    const trusted = this.#lastInput;
    this.#lastInput = null;
    if (
      !trusted ||
      input.mainWindowSenderId === null ||
      input.senderId !== input.mainWindowSenderId ||
      trusted.senderId !== input.senderId ||
      !input.windowFocused ||
      input.senderIsDevtools
    ) {
      return false;
    }
    const age = this.#now() - trusted.at;
    return age >= 0 && age <= TRUSTED_REMEMBER_INPUT_TTL_MS;
  }

  clear(): void {
    this.#lastInput = null;
  }
}
