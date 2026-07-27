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

export type RememberGrantKind = "install" | "command" | "send" | "connect";
export type RememberGrantPurpose = "confirm" | "settings";
export type RememberPromptDecision = "remember" | "cancel";

export const REMEMBER_PROMPT_DECISION_CHANNEL = "qingagent:remember-prompt-decision";

export interface RememberPromptCopy {
  title: string;
  message: string;
  detail: string;
  rememberLabel: string;
  cancelLabel: string;
}

function rememberCategoryCopy(kind: RememberGrantKind): Pick<
  RememberPromptCopy,
  "message" | "detail"
> {
  return kind === "install"
    ? {
        message: "以后安装时不再询问",
        detail: "开启后，之后的安装会直接进行。安装内容可能会改变这台电脑上的软件或设置。可在 设置 → 安全 中恢复每次询问。",
      }
    : {
        message: "以后遇到同类操作不再询问",
        detail: "开启后，之后的同类操作会直接进行。可在 设置 → 安全 中恢复每次询问。",
      };
}

export function buildRememberPromptCopy(input: {
  kind: RememberGrantKind;
}): RememberPromptCopy {
  const copy = rememberCategoryCopy(input.kind);
  return {
    title: "要记住这次选择吗？",
    ...copy,
    rememberLabel: "记住",
    cancelLabel: "暂不",
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]!);
}

/** 内置静态页面不加载网络资源；所有正文先转义再进入 data URL。 */
export function buildRememberPromptHtml(copy: RememberPromptCopy): string {
  const title = escapeHtml(copy.title);
  const message = escapeHtml(copy.message);
  const detail = escapeHtml(copy.detail);
  const rememberLabel = escapeHtml(copy.rememberLabel);
  const cancelLabel = escapeHtml(copy.cancelLabel);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <style>
    :root{color-scheme:dark;--night:#10191d;--night-2:#18262b;--paper:#faf6ec;--paper-deep:#efe7d6;--ink:#2f2a22;--ink-2:#5c5346;--cream:#ece3d0;--cream-soft:rgba(236,227,208,.62);--gold:#b59a63;--line:rgba(184,169,140,.32)}
    *{box-sizing:border-box}
    html,body{width:100%;height:100%;margin:0;overflow:hidden}
    body{display:flex;flex-direction:column;border:1px solid var(--line);background:linear-gradient(145deg,var(--night-2),var(--night));color:var(--cream);font-family:"Noto Serif SC","Songti SC","STSong",serif;-webkit-user-select:none}
    header{display:flex;align-items:center;gap:10px;min-height:56px;padding:0 18px;-webkit-app-region:drag}
    .dot{width:7px;height:7px;flex:0 0 auto;border-radius:50%;background:var(--gold);box-shadow:0 0 0 3px rgba(181,154,99,.18)}
    h1{margin:0;font-size:15px;font-weight:600;letter-spacing:.02em}
    .close{width:28px;height:28px;margin-left:auto;padding:0;border:0;background:transparent;color:rgba(236,227,208,.48);font:20px/1 "Noto Serif SC","Songti SC","STSong",serif;cursor:pointer;-webkit-app-region:no-drag}
    .close:hover,.close:focus-visible{background:rgba(255,255,255,.06);color:var(--cream);outline:1px solid var(--gold);outline-offset:-1px}
    main{margin:0 18px;padding:20px 20px 18px;border:1px solid rgba(168,130,63,.32);background:linear-gradient(135deg,var(--paper),var(--paper-deep));color:var(--ink)}
    .message{margin:0 0 10px;font-size:17px;font-weight:700;line-height:1.5}
    .detail{margin:0;color:var(--ink-2);font-size:12px;line-height:1.75}
    footer{display:flex;justify-content:flex-end;gap:9px;padding:16px 18px 18px}
    button{min-width:78px;height:32px;padding:0 16px;border-radius:0;font:600 12px/1 "Noto Serif SC","Songti SC","STSong",serif;cursor:pointer}
    button:focus-visible{outline:1px solid #d8c18c;outline-offset:2px}
    .cancel{border:1px solid var(--line);background:transparent;color:#cdbf9f}
    .cancel:hover{border-color:rgba(184,169,140,.5);background:rgba(184,169,140,.1);color:#f3ecdb}
    .remember{border:1px solid var(--gold);background:var(--gold);color:#17130f}
    .remember:hover{border-color:#c7af78;background:#c7af78}
  </style>
</head>
<body role="dialog" aria-modal="true" aria-labelledby="prompt-title" aria-describedby="prompt-message prompt-detail">
  <header>
    <span class="dot" aria-hidden="true"></span>
    <h1 id="prompt-title">${title}</h1>
    <button id="prompt-close" class="close" type="button" aria-label="关闭">×</button>
  </header>
  <main>
    <p id="prompt-message" class="message">${message}</p>
    <p id="prompt-detail" class="detail">${detail}</p>
  </main>
  <footer>
    <button id="prompt-cancel" class="cancel" type="button">${cancelLabel}</button>
    <button id="prompt-remember" class="remember" type="button">${rememberLabel}</button>
  </footer>
</body>
</html>`;
}

/**
 * 原生确认与 nonce 登记的串行闸门。renderer 即使搭车调用 IPC，也只能唤起一个
 * 明示类别与后果的主进程 modal；只有用户点「记住」后才会登记 nonce。
 */
export class NativeRememberGrantGate {
  #pendingToken: symbol | null = null;
  #generation = 0;

  reset(): number {
    this.#generation += 1;
    this.#pendingToken = null;
    return this.#generation;
  }

  cancel(generation = this.#generation): void {
    if (generation !== this.#generation) return;
    this.#generation += 1;
    this.#pendingToken = null;
  }

  async request(input: {
    purpose: RememberGrantPurpose;
    kind: RememberGrantKind;
    showPrompt: (copy: RememberPromptCopy) => Promise<RememberPromptDecision>;
    register: () => Promise<string> | string;
    revoke?: (nonce: string) => Promise<unknown> | unknown;
    generation?: number;
  }): Promise<string | null> {
    const generation = input.generation ?? this.#generation;
    if (generation !== this.#generation || this.#pendingToken) return null;
    const token = Symbol("native-remember-request");
    this.#pendingToken = token;
    try {
      const result = await input.showPrompt(buildRememberPromptCopy(input));
      if (result !== "remember" || generation !== this.#generation) return null;
      const nonce = await input.register();
      if (generation !== this.#generation) {
        await input.revoke?.(nonce);
        return null;
      }
      return nonce;
    } finally {
      if (this.#pendingToken === token) this.#pendingToken = null;
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
