/**
 * 工具心跳:耗时工具 execute() 期间周期性往 agent 主流注入瞬时 chunk,让
 * processAgentStream 的 withIdleTimeout 看门狗不断清零,避免"工具正在干活却被
 * 空闲超时(idle timeout)误杀"。
 *
 * 典型病灶:generateSvg 生成 SVG 内部硬超时 30s,从"发起
 * 工具调用"到"返回结果"这段对 agent 主流是静默;旧默认 45s 看门狗一到整轮被 abort,图也没
 * 插进去(参见 streamErrors.ts withIdleTimeout)。
 *
 * 用法:
 *   const stop = startToolHeartbeat(context, { tool: "generateSvg" });
 *   try {
 *     ...耗时操作...
 *   } finally {
 *     stop();
 *   }
 *
 * 设计要点:
 * - 时钟驱动(setInterval),不依赖工具内部有无进度点,对所有工具一致;即便内部
 *   某个 await 完全卡死,心跳照常维持——真卡死由工具自身硬超时(如
 *   SVG_GEN_TIMEOUT_MS)兜底 abort,心跳只负责"别误杀正在干活的"。
 * - 失败静默:writer 不存在 / 写失败一律吞掉。心跳是装饰,绝不影响生成主链。
 * - chunk 走 writer.write({ type: "tool-heartbeat" }) → 主流 tool-output chunk
 *   (与 writeDraft 进度同款通道);主循环不识别该 type → 安全忽略,只重置看门狗,
 *   不产生可见帧。
 */

type HeartbeatWriter = {
  write: (chunk: Record<string, unknown>) => Promise<unknown> | unknown;
};

export interface ToolHeartbeatOptions {
  /** 工具名,仅用于调试/可观测,不影响行为 */
  tool: string;
  /** 心跳间隔(ms),默认 10s。会被夹到 [1000, 30000];必须远小于 idle timeout */
  intervalMs?: number;
}

const DEFAULT_HEARTBEAT_MS = 10_000;
const MIN_HEARTBEAT_MS = 1_000;
const MAX_HEARTBEAT_MS = 30_000;

/**
 * 启动工具心跳。返回 stop():务必在 finally 里调用以清理定时器。
 * writer 缺失时返回 no-op stop(),调用方无需判空。
 */
export function startToolHeartbeat(
  context: unknown,
  opts: ToolHeartbeatOptions,
): () => void {
  const writer = (context as { writer?: HeartbeatWriter } | undefined)?.writer;
  if (!writer || typeof writer.write !== "function") return () => {};

  const intervalMs = Math.min(
    MAX_HEARTBEAT_MS,
    Math.max(MIN_HEARTBEAT_MS, opts.intervalMs ?? DEFAULT_HEARTBEAT_MS),
  );
  let seq = 0;
  let stopped = false;

  const emit = () => {
    if (stopped) return;
    try {
      const r = writer.write({ type: "tool-heartbeat", tool: opts.tool, seq: (seq += 1) });
      // 吞掉异步写失败,不让 unhandled rejection 冒出来影响主链
      if (r && typeof (r as Promise<unknown>).then === "function") {
        void (r as Promise<unknown>).catch(() => {});
      }
    } catch {
      // 同步写失败也静默:心跳是装饰
    }
  };

  const timer = setInterval(emit, intervalMs);
  // 别让心跳定时器拖住 Node 进程退出
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}
