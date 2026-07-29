/**
 * 「已转入交互式授权」的流式识别。
 *
 * 病根(0729 语雀真机实证):`yuque whoami --json` 并不是在慢慢查登录态——它约 1 秒就已经
 * 确定本机 token 解不开(隔离形态下读不到系统钥匙串),随后**自动转入交互式 OAuth 扫码等待**,
 * 剩下的 119 秒纯粹在等一个永远不会发生的扫码,最后被我们的 120 秒执行墙掐掉,还被归因成
 * "系统超时"。真正的钥匙串拒绝写在 CLI 自己的日志文件里,不在 stdout,所以退出后再做诊断
 * 既晚又没证据。
 *
 * 本模块只做一件事:**在 stdout/stderr 流式到达的过程中,按行增量判断"它已经进入交互式授权
 * 等待"**。命中后由调用方立刻收口前台命令,把两分钟干等压到秒级。
 *
 * 设计约束:
 * - **信号表可扩展**:新增第三方 CLI 只需往 INTERACTIVE_AUTH_FAST_FAIL_SIGNALS 加一条;
 * - **大小写与空白宽容**:先剥 ANSI 颜色码、统一小写、把连续空白(含全角空格)压成单空格;
 * - **按行增量**:输出可能分块到达(一行被劈成两半、多行挤在一块),缓冲区跨块拼接;
 *   也要匹配"还没换行的半行"——`Waiting for authentication...` 这种提示常常不带换行就阻塞;
 * - **只触发一次**:命中后进入终态,后续 push 一律返回 null,不会重复收口。
 *
 * 边界:这套识别只用于**前台**执行。用户真心要走扫码授权时走的是 background:true + 轮询,
 * 那条路必须完整跑完,绝不能被这里掐断——所以本模块只在前台分支被接线。
 */

/** 触发快速收口的信号表。新增条目只需保证:小写、单空格、无 ANSI。 */
export const INTERACTIVE_AUTH_FAST_FAIL_SIGNALS: readonly RegExp[] = [
  /open this url to authenticate/,
  /waiting for authentication/,
  /authorization url obtained/,
];

/** 半行缓冲上限:信号本身只有几十字符,留 4 KiB 足够跨块拼接,又不会被超长单行撑爆内存。 */
const PENDING_BUFFER_LIMIT = 4_096;

/** CSI/OSC 等 ANSI 转义序列:彩色输出的 CLI 会把它们夹在文字里,匹配前先剥干净。 */
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** 归一化:剥 ANSI → 小写 → 连续空白(含全角空格/制表)压成单空格 → 去首尾。 */
export function normalizeAuthSignalLine(line: string): string {
  return line
    .replace(ANSI_ESCAPE, "")
    .toLowerCase()
    .replace(/[\s　 ]+/g, " ")
    .trim();
}

export interface InteractiveAuthDetector {
  /**
   * 喂入一段新到达的输出。命中返回**归一化后的那一行**(只进诊断日志,不进用户文案);
   * 未命中或已经命中过返回 null。
   */
  push(chunk: string): string | null;
  /** 已命中的信号行;从未命中为 null。 */
  matchedLine(): string | null;
}

export function createInteractiveAuthDetector(
  patterns: readonly RegExp[] = INTERACTIVE_AUTH_FAST_FAIL_SIGNALS,
): InteractiveAuthDetector {
  let pending = "";
  let matched: string | null = null;

  const testLine = (line: string): string | null => {
    const normalized = normalizeAuthSignalLine(line);
    if (!normalized) return null;
    return patterns.some((pattern) => pattern.test(normalized)) ? normalized : null;
  };

  return {
    push(chunk: string): string | null {
      // 终态只进一次:命中后不再累积、不再重复触发。
      if (matched !== null) return null;
      if (!chunk) return null;
      pending += chunk;
      // \r 单独出现是进度条回车,同样当作行边界切开。
      const segments = pending.split(/\r\n|\n|\r/);
      pending = segments.pop() ?? "";
      for (const segment of segments) {
        const hit = testLine(segment);
        if (hit) {
          matched = hit;
          pending = "";
          return hit;
        }
      }
      // 尚未换行的半行也要判:交互式提示常常打完就阻塞,永远等不到换行符。
      const pendingHit = testLine(pending);
      if (pendingHit) {
        matched = pendingHit;
        pending = "";
        return pendingHit;
      }
      if (pending.length > PENDING_BUFFER_LIMIT) {
        pending = pending.slice(-PENDING_BUFFER_LIMIT);
      }
      return null;
    },
    matchedLine(): string | null {
      return matched;
    },
  };
}
