// 对话流式文字"逐段进场"动画的可调配置 + 轻量发布订阅 store(借鉴 FlowToken / Streamdown / shadcn
// Text Generate:按词/字拆 span、各自挂载即播动画;blur-in 能把快模型"整批 token"糊成柔和揭示)。
// 真实聊天读取它(当前为固定默认柔焦档);store/localStorage 保留以便后续接调参 UI。

export type StreamFxEffect = "blur" | "rise" | "soft" | "none";
export type StreamFxSegMode = "auto" | "char" | "word";

export interface StreamFxConfig {
  /** 进场效果。blur=模糊→清晰(快模型最稳);rise=淡入+上浮;soft=纯 opacity 慢淡;none=无动画。 */
  effect: StreamFxEffect;
  /** 每段动画时长(ms)。 */
  durationMs: number;
  /** blur 效果的初始模糊量(px)。 */
  blurPx: number;
  /** rise 效果的初始下移量(px)。 */
  slideY: number;
  /** 分段粒度。auto=中日韩按字、拉丁按词;char=全按字;word=全按空白分词(CJK 会整段一坨)。 */
  segMode: StreamFxSegMode;
}

export const STREAM_FX_PRESETS: Record<string, { name: string; config: StreamFxConfig }> = {
  blurSoft: {
    name: "柔焦渐显(blur)",
    config: { effect: "blur", durationMs: 180, blurPx: 4, slideY: 0, segMode: "auto" },
  },
  rise: {
    name: "上浮淡入(rise)",
    config: { effect: "rise", durationMs: 520, blurPx: 0, slideY: 7, segMode: "auto" },
  },
  soft: {
    name: "纯淡入(soft)",
    config: { effect: "soft", durationMs: 900, blurPx: 0, slideY: 0, segMode: "char" },
  },
};

export const DEFAULT_STREAM_FX_CONFIG: StreamFxConfig = { ...STREAM_FX_PRESETS.blurSoft!.config };

export const STREAM_FX_STORAGE_KEY = "qingagent:stream-fx-config";

type Listener = (cfg: StreamFxConfig) => void;
const listeners = new Set<Listener>();
let current: StreamFxConfig = loadStreamFxConfig();

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

export function normalizeStreamFxConfig(raw: unknown): StreamFxConfig {
  const base = DEFAULT_STREAM_FX_CONFIG;
  if (!raw || typeof raw !== "object") return { ...base };
  const r = raw as Partial<StreamFxConfig>;
  const effect: StreamFxEffect =
    r.effect === "rise" || r.effect === "soft" || r.effect === "none" || r.effect === "blur"
      ? r.effect
      : base.effect;
  const segMode: StreamFxSegMode =
    r.segMode === "char" || r.segMode === "word" || r.segMode === "auto" ? r.segMode : base.segMode;
  return {
    effect,
    segMode,
    durationMs: clampNum(r.durationMs, 80, 3000, base.durationMs),
    blurPx: clampNum(r.blurPx, 0, 20, base.blurPx),
    slideY: clampNum(r.slideY, 0, 30, base.slideY),
  };
}

export function loadStreamFxConfig(): StreamFxConfig {
  if (typeof window === "undefined") return { ...DEFAULT_STREAM_FX_CONFIG };
  try {
    const raw = window.localStorage.getItem(STREAM_FX_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STREAM_FX_CONFIG };
    return normalizeStreamFxConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_STREAM_FX_CONFIG };
  }
}

export function getStreamFxConfig(): StreamFxConfig {
  return current;
}

export function setStreamFxConfig(next: StreamFxConfig): void {
  current = normalizeStreamFxConfig(next);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STREAM_FX_STORAGE_KEY, JSON.stringify(current));
    } catch {
      /* ignore */
    }
  }
  for (const l of listeners) l(current);
}

export function subscribeStreamFxConfig(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
