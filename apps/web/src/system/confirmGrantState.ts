// 四类确认都可记住"始终允许",跨设置页与确认卡同步状态
export type RememberGrantKind = "install" | "command" | "send" | "connect";

export interface RememberGrantCanonical {
  kind: RememberGrantKind;
  present: boolean;
  grantId: string | null;
  version: number;
}

const EVENT_NAME = "qa-confirm-grant-state";
const STORAGE_KEY = "qa-confirm-grant-state:v1";

function parseCanonical(value: unknown): RememberGrantCanonical | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (
    input.kind !== "install" &&
    input.kind !== "command" &&
    input.kind !== "send" &&
    input.kind !== "connect"
  ) return null;
  if (typeof input.present !== "boolean") return null;
  if (input.grantId !== null && typeof input.grantId !== "string") return null;
  if (!Number.isSafeInteger(input.version) || Number(input.version) < 0) return null;
  return {
    kind: input.kind,
    present: input.present,
    grantId: input.grantId as string | null,
    version: Number(input.version),
  };
}

export function publishRememberGrantState(state: RememberGrantCanonical): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: state }));
  try {
    const payload = JSON.stringify({ ...state, eventId: crypto.randomUUID() });
    window.localStorage.setItem(STORAGE_KEY, payload);
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 自定义事件仍覆盖当前窗口；隐私模式禁用 storage 时由 focus 重读兜底。
  }
}

export function subscribeRememberGrantState(
  listener: (state: RememberGrantCanonical) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onLocal = (event: Event) => {
    const state = parseCanonical((event as CustomEvent<unknown>).detail);
    if (state) listener(state);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try {
      const state = parseCanonical(JSON.parse(event.newValue));
      if (state) listener(state);
    } catch {
      // 非本模块写入的畸形 storage 值不影响设置状态。
    }
  };
  window.addEventListener(EVENT_NAME, onLocal);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT_NAME, onLocal);
    window.removeEventListener("storage", onStorage);
  };
}
