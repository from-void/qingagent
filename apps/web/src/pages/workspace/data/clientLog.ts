/**
 * Layer ① 前端点击流采集（阶段5c）。
 *
 * 极低侵入：只导出 `genClientTraceId()` + `logClientEvent()` + `setClientLogSession()`
 * 三个工具，不改任何组件结构 / reducer / contract。调用方在数据层（serverStream.send、
 * 少数纯前端动作）点几行即可。
 *
 * 行为：
 * - 事件攒批，到量（BATCH_MAX）或定时（FLUSH_INTERVAL_MS）flush 到
 *   `POST /api/v1/clientlog`，单请求 ≤ 50 条（与后端上限一致）。
 * - 失败静默（observability 是旁路，绝不影响产品 UX）。
 * - 浏览器关闭/隐藏时尽力 flush（pagehide / visibilitychange）。
 *
 * clientTraceId 关联：单次用户动作生成一个 32hex clientTraceId（serverStream.send
 * 在发命令前调 genClientTraceId 并经 `x-client-trace-id` 透传给后端，见设计文档 §十）。
 * 同一条 client_event 带上该 clientTraceId，后端就能把"点击 → 命令 → 模型 → DB"串起来。
 */

/** 单次 flush 最多上报的事件数（与后端 /clientlog 上限对齐，防滥用）。 */
const BATCH_MAX = 50;
/** 定时 flush 间隔（毫秒）。 */
const FLUSH_INTERVAL_MS = 3000;
/** 端点最多缓冲多少条，超出丢最旧（防止后端长时间不可用时内存涨爆）。 */
const BUFFER_CAP = 200;

/** 单条客户端事件（与后端 /clientlog 入参形状一致）。 */
export interface ClientEvent {
  /** 32hex，单次用户动作的关联 id（与后端 span traceId 同源）。 */
  clientTraceId?: string;
  /** 所属会话（可缺省，如发消息前 startSession 尚未拿到 sessionId）。 */
  sessionId?: string;
  /** 动作名，如 sendMessage / switchSession / selectionEdit / export。 */
  action: string;
  /** 动作目标（可选，如 patchId / fileId）。 */
  target?: string;
  /** 客户端时间戳（ms）。 */
  ts: number;
  /** 轻量附加信息（不放敏感正文，只放摘要/计数/枚举）。 */
  meta?: Record<string, unknown>;
}

/** 待上报缓冲。 */
let buffer: ClientEvent[] = [];
/** 当前会话 id（由 setClientLogSession 维护，便于自动埋点带上）。 */
let currentSessionId: string | undefined;
/** 定时器句柄。 */
let flushTimer: ReturnType<typeof setTimeout> | undefined;

/** 生成一个 32hex 的 clientTraceId（单次用户动作的关联 id）。 */
export function genClientTraceId(): string {
  // crypto.randomUUID 在所有目标浏览器可用；去掉 dash 即 32hex。
  return crypto.randomUUID().replace(/-/g, "");
}

/** 设置/更新当前会话 id，后续自动埋点会带上它。 */
export function setClientLogSession(sessionId: string | undefined): void {
  currentSessionId = sessionId;
}

/**
 * 记录一条客户端事件（攒批，不立即网络请求）。
 *
 * sessionId 缺省时回退到 setClientLogSession 设置的当前会话。
 */
export function logClientEvent(
  action: string,
  opts?: {
    clientTraceId?: string;
    sessionId?: string;
    target?: string;
    meta?: Record<string, unknown>;
  },
): void {
  try {
    buffer.push({
      action,
      clientTraceId: opts?.clientTraceId,
      sessionId: opts?.sessionId ?? currentSessionId,
      target: opts?.target,
      ts: Date.now(),
      meta: opts?.meta,
    });
    // 缓冲上限保护：丢最旧。
    if (buffer.length > BUFFER_CAP) {
      buffer = buffer.slice(buffer.length - BUFFER_CAP);
    }
    if (buffer.length >= BATCH_MAX) {
      void flushClientEvents();
    } else {
      scheduleFlush();
    }
  } catch {
    // 静默：埋点绝不影响产品逻辑。
  }
}

/** 安排一次延迟 flush（若已安排则不重复）。 */
function scheduleFlush(): void {
  if (flushTimer !== undefined) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    void flushClientEvents();
  }, FLUSH_INTERVAL_MS);
}

/**
 * 立即 flush 当前缓冲到 /clientlog（分批，每批 ≤ BATCH_MAX）。
 * 失败静默；卸载场景用 keepalive 尽力送达。
 */
export async function flushClientEvents(useKeepalive = false): Promise<void> {
  if (flushTimer !== undefined) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  if (buffer.length === 0) return;

  // 取出全部待发，按 BATCH_MAX 切片，避免超后端上限。
  const pending = buffer;
  buffer = [];

  for (let i = 0; i < pending.length; i += BATCH_MAX) {
    const events = pending.slice(i, i + BATCH_MAX);
    try {
      await fetch("/api/v1/clientlog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events }),
        // 页面卸载时让请求脱离文档生命周期继续送达。
        keepalive: useKeepalive,
      });
    } catch {
      // 静默丢弃（开发期日志，不重试以免拖累 UX）。
    }
  }
}

// 浏览器关闭/切后台时尽力 flush（仅在浏览器环境注册）。
if (typeof window !== "undefined" && typeof document !== "undefined") {
  const flushOnExit = (): void => {
    void flushClientEvents(true);
  };
  window.addEventListener("pagehide", flushOnExit);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushOnExit();
  });
}
