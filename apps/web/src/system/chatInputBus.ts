type Listener = (text: string) => void;

const listeners = new Set<Listener>();
const sendListeners = new Set<Listener>();

/**
 * Tiny pub/sub used by the export drawer's 在对话里说 to push a seed
 * prompt into the workspace ChatInput. We only need one consumer
 * (the workspace page); a window-scoped EventTarget would also work
 * but this avoids adding new global event names and keeps the API
 * typed.
 *
 * push 只把文案预填进输入框;send 则预填后立即发送(供二维码过期刷新等"一点即发"场景)。
 */
export const chatInputBus = {
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  push(text: string): void {
    for (const fn of listeners) fn(text);
  },
  subscribeSend(fn: Listener): () => void {
    sendListeners.add(fn);
    return () => {
      sendListeners.delete(fn);
    };
  },
  send(text: string): void {
    for (const fn of sendListeners) fn(text);
  },
};
