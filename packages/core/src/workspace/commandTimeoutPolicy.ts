import { SANDBOX_BACKGROUND_TTL_MS, formatCommandDuration } from "./backgroundCommandLimits.js";
import { SANDBOX_TIMEOUT_MS } from "./sessionWorkspace.js";

/**
 * 命令超时协议的唯一口径。
 *
 * 真机取证(0729 语雀 OAuth):模型按毫秒风格传 `timeout: 15000` / `30000`,而协议里
 * `timeout` 的单位是秒,于是被解释成 15000 秒 / 30000 秒;前台默认 120s 上限被显式入参
 * 直接绕过,三次命令各跑满约 130 秒直到语雀 CLI 自己 OAuth 超时退出,`timedOut` 始终为
 * false——我们的超时从未触发。这里把"字段单位""硬上限钳制""钳制事实回传"三件事收成一处,
 * 让入参永远无法越过硬上限,并且钳制后的生效值必须回传给模型。
 */

/** 前台命令硬上限。可由 QINGAGENT_SANDBOX_TIMEOUT_MS 调整，但入参不能越过它。 */
export const FOREGROUND_TIMEOUT_LIMIT_MS = SANDBOX_TIMEOUT_MS;
/** 后台命令硬上限，与既有 TTL 同一个值，前后台钳制口径一致。 */
export const BACKGROUND_TIMEOUT_LIMIT_MS = SANDBOX_BACKGROUND_TTL_MS;

/**
 * "秒"字段里出现 >= 该值时，几乎只可能是把毫秒当秒填。提示语按"若你本意是……"措辞，
 * 只给纠正写法、不做武断判定，因此偶发误判也不会给出错误结论。
 */
export const MILLISECOND_STYLE_SECONDS_THRESHOLD = 1_000;

export const FOREGROUND_TIMEOUT_LIMIT_SECONDS = Math.round(FOREGROUND_TIMEOUT_LIMIT_MS / 1_000);
export const BACKGROUND_TIMEOUT_LIMIT_SECONDS = Math.round(BACKGROUND_TIMEOUT_LIMIT_MS / 1_000);

export interface CommandTimeoutRequest {
  /** 旧字段：单位=秒。仅为兼容保留，语义不变。 */
  timeout?: number | null;
  /** 新字段：单位=秒，优先级最高。 */
  timeoutSeconds?: number | null;
  /** 新字段：单位=毫秒，与 timeoutSeconds 互斥。 */
  timeoutMs?: number | null;
}

export type CommandTimeoutSource = "timeoutSeconds" | "timeoutMs" | "timeout";

export interface ResolvedCommandTimeout {
  /** 实际交给沙箱的毫秒值，已按硬上限钳制。 */
  effectiveMs: number;
  /** 模型请求的毫秒值；没有显式请求时为 undefined。 */
  requestedMs?: number;
  /** 最终采纳的入参字段。 */
  source?: CommandTimeoutSource;
  /** 请求值超过硬上限、已被钳制。 */
  clamped: boolean;
  /** 本次执行方式(前台/后台)的硬上限。 */
  limitMs: number;
  /** 秒字段里填了毫秒风格的巨值。 */
  millisecondStyle: boolean;
}

function positiveFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * 新旧字段归一：timeoutSeconds > timeoutMs > 旧 timeout(按秒解释)。
 * timeoutSeconds 与 timeoutMs 互斥由 schema 拦下，这里再兜一层取更明确的秒字段。
 */
export function resolveCommandTimeout(
  request: CommandTimeoutRequest,
  options: { background?: boolean } = {},
): ResolvedCommandTimeout {
  const limitMs = options.background === true
    ? BACKGROUND_TIMEOUT_LIMIT_MS
    : FOREGROUND_TIMEOUT_LIMIT_MS;
  const seconds = positiveFinite(request.timeoutSeconds);
  const milliseconds = positiveFinite(request.timeoutMs);
  const legacySeconds = positiveFinite(request.timeout);
  const picked = seconds !== undefined
    ? { source: "timeoutSeconds" as const, requestedMs: seconds * 1_000, secondsValue: seconds }
    : milliseconds !== undefined
      ? { source: "timeoutMs" as const, requestedMs: milliseconds, secondsValue: undefined }
      : legacySeconds !== undefined
        ? { source: "timeout" as const, requestedMs: legacySeconds * 1_000, secondsValue: legacySeconds }
        : undefined;
  if (!picked) {
    return { effectiveMs: limitMs, clamped: false, limitMs, millisecondStyle: false };
  }
  // 钳制在此处一次性完成：入参无论多大都不可能越过硬上限。
  const effectiveMs = Math.min(Math.max(1, Math.round(picked.requestedMs)), limitMs);
  return {
    effectiveMs,
    requestedMs: picked.requestedMs,
    source: picked.source,
    clamped: picked.requestedMs > limitMs,
    limitMs,
    millisecondStyle:
      picked.secondsValue !== undefined &&
      picked.secondsValue >= MILLISECOND_STYLE_SECONDS_THRESHOLD,
  };
}

/** 面向模型的耗时描述：十分钟内保留一位小数的秒，更长取整分钟。 */
export function formatElapsedDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "未知";
  if (ms >= 600_000) return `${Math.round(ms / 60_000)} 分钟`;
  return `${(ms / 1_000).toFixed(1)} 秒`;
}

/**
 * 入参超上限被钳制时的如实说明。
 * 选"钳制并说明"而不是"拒绝"：命令本身合法，拒绝只会白白多一轮往返；但生效值必须回传，
 * 避免模型以为自己设的超时真的生效了(这正是语雀那次三轮空等的根)。
 */
export function commandTimeoutClampNotice(resolved: ResolvedCommandTimeout, background = false): string {
  if (!resolved.clamped || resolved.requestedMs === undefined) return "";
  const parts = [
    `超时参数单位是秒。你请求的 ${formatCommandDuration(resolved.requestedMs)} 超过${
      background ? "后台" : "前台"
    }上限 ${formatCommandDuration(resolved.limitMs)}，本次实际按 ${
      formatCommandDuration(resolved.effectiveMs)
    } 执行。`,
  ];
  if (resolved.millisecondStyle) {
    parts.push(
      `若你本意是 ${Math.round(resolved.requestedMs / 1_000)} 毫秒，请改用 timeoutMs；按秒设置请用 timeoutSeconds（例：timeoutSeconds: 60）。`,
    );
  }
  return parts.join("");
}
