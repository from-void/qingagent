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

/**
 * 「本机保存的登录信息读不出来」的信号表。
 *
 * 与上面那张表**必须分开**:两者都要快速收口,但归因完全不同——
 * - 上表 = 工具**已经**转入交互式授权、正在等人扫码/网页确认;
 * - 本表 = 工具在**读取本机凭据存储**时被系统拒绝(macOS 钥匙串 / Linux keyring /
 *   Windows 凭据管理器),它接下来才会退化成"重新授权"。
 *
 * 混为一谈会让用户拿到错误结论(0729 真机:被说成"登录态过期",实际登录好好的,
 * 只是拉起它的程序身份变了)。判据只取**命令自己输出的文本**——绝不去翻第三方 CLI
 * 的日志文件,那既越界又不可靠。
 *
 * 注意排除"没有这条凭据"(item not found)之类的正常未登录信号:那不是被拒绝。
 */
export const CREDENTIAL_STORE_DENIED_SIGNALS: readonly RegExp[] = [
  /key access denied/,
  /(keychain|keyring|credential store|credential manager)[^\n]{0,40}(denied|not permitted|unavailable|locked)/,
  /(denied|not permitted|unable|failed)[^\n]{0,40}(keychain|keyring|credential store|credential manager)/,
  /errsecinteractionnotallowed/,
  /errsecauthfailed/,
  /user interaction is not allowed/,
  /access denied[^\n]{0,40}(token|credential|secret)/,
];

/** 信号分档:两类都要收口,但归因与文案完全不同。 */
export type AuthSignalKind = "interactive-auth" | "credential-store-denied";

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
   * 未命中或已经命中过返回 null。命中的**分档**用 matchedKind() 取。
   */
  push(chunk: string): string | null;
  /** 已命中的信号行;从未命中为 null。 */
  matchedLine(): string | null;
  /** 已命中信号的分档;从未命中为 null。 */
  matchedKind(): AuthSignalKind | null;
}

export interface InteractiveAuthDetectorOptions {
  /** 「已转入交互式授权」信号表。 */
  interactiveAuthPatterns?: readonly RegExp[];
  /** 「本机凭据存储读不出来」信号表。 */
  credentialStoreDeniedPatterns?: readonly RegExp[];
}

export function createInteractiveAuthDetector(
  options: readonly RegExp[] | InteractiveAuthDetectorOptions = {},
): InteractiveAuthDetector {
  // 兼容旧签名(直接传交互式授权信号表)。
  const resolved: InteractiveAuthDetectorOptions = Array.isArray(options)
    ? { interactiveAuthPatterns: options as readonly RegExp[] }
    : options as InteractiveAuthDetectorOptions;
  const interactivePatterns = resolved.interactiveAuthPatterns ?? INTERACTIVE_AUTH_FAST_FAIL_SIGNALS;
  const deniedPatterns = resolved.credentialStoreDeniedPatterns ?? CREDENTIAL_STORE_DENIED_SIGNALS;
  let pending = "";
  let matched: string | null = null;
  let matchedKind: AuthSignalKind | null = null;

  const testLine = (line: string): { line: string; kind: AuthSignalKind } | null => {
    const normalized = normalizeAuthSignalLine(line);
    if (!normalized) return null;
    // 凭据存储被拒更具体、且总是先于交互式提示出现,优先判定。
    if (deniedPatterns.some((pattern) => pattern.test(normalized))) {
      return { line: normalized, kind: "credential-store-denied" };
    }
    if (interactivePatterns.some((pattern) => pattern.test(normalized))) {
      return { line: normalized, kind: "interactive-auth" };
    }
    return null;
  };

  const accept = (hit: { line: string; kind: AuthSignalKind }): string => {
    matched = hit.line;
    matchedKind = hit.kind;
    pending = "";
    return hit.line;
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
        if (hit) return accept(hit);
      }
      // 尚未换行的半行也要判:交互式提示常常打完就阻塞,永远等不到换行符。
      const pendingHit = testLine(pending);
      if (pendingHit) return accept(pendingHit);
      if (pending.length > PENDING_BUFFER_LIMIT) {
        pending = pending.slice(-PENDING_BUFFER_LIMIT);
      }
      return null;
    },
    matchedLine(): string | null {
      return matched;
    },
    matchedKind(): AuthSignalKind | null {
      return matchedKind;
    },
  };
}
