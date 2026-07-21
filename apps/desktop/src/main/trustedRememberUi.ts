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
