/**
 * 命令行工具「扫码登录」类失败的归因分档。
 *
 * 病根(0729 真机实证):第三方 CLI 走 OAuth 扫码登录时,**扫码其实已经成功、token 也已经拿到**,
 * 失败发生在后一步——把登录信息保存下来的时候。但链路上层把这一律当成"授权没完成",
 * 于是继续重发二维码、白等一轮又一轮,最后只甩一句英文 `Authorization timeout.`。
 * 用户看到的是"你没扫码",与事实正好相反。
 *
 * 本模块只做一件事:**从命令输出把真实失败态判出来**,并给出
 * ① 面向用户的中文短句(无红色语气、不含英文原文、不含内部路径与实现名词);
 * ② 面向模型的下一步指引(明确禁止"再出一张码""说用户没扫码")。
 *
 * 判定只读文本,不联网、不猜:命中不了就返回 null,由调用方按原样处理——
 * **宁可不判,也不能瞎归因**,把普通失败误判成"没扫码"正是这次要治的病。
 *
 * 分工:命令被我们自己超时/信号终止的**归因细节**由超时那条线负责,
 * 这里只在"确实是登录类命令"时补一句"不是你的授权出了问题",避免两侧口径打架。
 */

/** 失败分档。顺序即优先级(越靠前越"确定"),同时命中时取靠前者。 */
export type CredentialFailureKind =
  /** 授权已完成、凭据已拿到,但没能保存下来(写盘被拒 / 系统凭据存取失败)。 */
  | "credential-save-failed"
  /** 命令被 qingagent 自己的超时或信号终止,不是对端的授权超时。 */
  | "sandbox-timeout"
  /** CLI 自己判定授权超时(它等不到扫码结果)。 */
  | "cli-auth-timeout"
  /** 二维码/授权链接已过期,需要重新出码。 */
  | "qr-expired"
  /** 还在等用户扫码——这是唯一可以对用户说"请扫码"的分档。 */
  | "qr-pending";

export interface CredentialFailureDiagnosis {
  kind: CredentialFailureKind;
  /**
   * 授权环节是否已经完成(已经拿到凭据 / 已确认扫码成功)。
   * 为 true 时**严禁**再提示用户扫码,也**严禁**重新生成二维码。
   */
  authCompleted: boolean;
  /** 原样重试还有没有意义。false = 不解决保存问题,重试只会原地打转。 */
  retryable: boolean;
  /** 面向用户的中文短句:不出现英文原文、堆栈、绝对路径与内部实现名词。 */
  userMessage: string;
  /** 面向用户的下一步(一句话,可操作)。 */
  userNextStep: string;
}

/** 归因用到的原始信号,只进诊断日志,不进用户可见文案。 */
export interface CredentialFailureSignals {
  /** 命令的合并输出(stdout+stderr),或后台进程轮询到的输出。 */
  output: string;
  /** qingagent 侧判定的超时(执行墙,不是对端授权超时)。 */
  timedOut?: boolean;
  /** 进程被信号终止。 */
  killed?: boolean;
}

/** 扫码已完成、凭据已到手的正向信号。命中即禁止再把失败说成"用户没扫码"。 */
const AUTH_COMPLETED_PATTERNS = [
  /polling success/i,
  /token obtained/i,
  /(access|refresh)[_\s-]?token\b.{0,24}(obtained|received|acquired)/i,
  /authorization (successful|succeeded|complete)/i,
  /login (successful|succeeded)/i,
  /扫码(成功|已完成)/,
  /授权(成功|已完成)/,
];

/** 拿到凭据之后的保存失败(写盘、缓存、会话、系统凭据存取)。 */
const PERSIST_FAILURE_PATTERNS = [
  /failed to save/i,
  /failed to (write|persist|store)/i,
  /save .{0,24}(cache|session|token|credential).{0,24}fail/i,
  /schema detect failed/i,
  /failed to add auth headers/i,
  /session resume failed/i,
  /key access denied/i,
  /keychain access denied/i,
  /keychain.{0,40}(denied|not permitted|unavailable)/i,
  /errSecInteractionNotAllowed/i,
  /errSecAuthFailed/i,
];

/** 文件系统权限被拒。只在"凭据已到手"之后才据此判保存失败。 */
const PERMISSION_PATTERNS = [
  /\bEPERM\b/,
  /\bEACCES\b/,
  /operation not permitted/i,
  /permission denied/i,
];

const CLI_AUTH_TIMEOUT_PATTERNS = [
  /authorization timeout/i,
  /authorization timed out/i,
  /login timed out/i,
  /授权超时/,
];

const QR_EXPIRED_PATTERNS = [
  /(qr|qrcode|code|device_code|二维码).{0,24}expired/i,
  /expired.{0,24}(qr|qrcode|code|二维码)/i,
  /\bexpired_token\b/i,
  /二维码.{0,6}(已)?过期/,
];

const QR_PENDING_PATTERNS = [
  /\bauthorization_pending\b/i,
  /waiting for (the )?(user|authorization|scan)/i,
  /(please )?scan the (qr|code)/i,
  /等待(用户)?(扫码|授权)/,
  /请(使用.{0,12})?扫码/,
];

/**
 * 这条输出到底是不是"登录/凭据"这码事。
 *
 * 给"我们自己超时/掐死"那一档设前置条件:普通命令跑超时和登录八竿子打不着,
 * 硬贴一句凭据诊断只会变噪音,还会踩到超时归因那条线的地盘。
 */
const CREDENTIAL_CONTEXT_PATTERNS = [
  /\b(auth|authoriz|authentic|oauth|token|credential|keychain|login|sign[\s_-]?in)/i,
  /(授权|认证|登录|凭据|凭证|钥匙串|扫码|二维码)/,
];

function matchesAny(output: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(output));
}

function hasCredentialContext(output: string): boolean {
  return matchesAny(output, CREDENTIAL_CONTEXT_PATTERNS);
}

const COPY: Record<
  CredentialFailureKind,
  { message: string; nextStep: string; authCompleted: boolean; retryable: boolean }
> = {
  "credential-save-failed": {
    message: "授权已经完成，但登录信息没能保存下来，所以还是显示未登录。",
    nextStep: "这一步不用你再扫码；我先把保存失败的原因查清楚再继续。",
    authCompleted: true,
    retryable: false,
  },
  "sandbox-timeout": {
    message: "这条命令等待太久，已经被我这边结束了，不是你的授权出了问题。",
    nextStep: "需要长时间等待的登录命令我会放到后台跑，稍后再看结果。",
    authCompleted: false,
    retryable: true,
  },
  "cli-auth-timeout": {
    message: "这个工具没能在有效期内确认到授权结果，已经自行结束等待。",
    nextStep: "我重新发起一次授权，你在有效期内完成确认即可。",
    authCompleted: false,
    retryable: true,
  },
  "qr-expired": {
    message: "二维码已经过期了。",
    nextStep: "我马上换一张新的，你扫新的那张就行。",
    authCompleted: false,
    retryable: true,
  },
  "qr-pending": {
    message: "还在等待你完成扫码确认。",
    nextStep: "请扫描下方的二维码并在手机上确认。",
    authCompleted: false,
    retryable: true,
  },
};

/** 归因主入口。判不出来返回 null。 */
export function diagnoseCredentialFailure(
  signals: CredentialFailureSignals,
): CredentialFailureDiagnosis | null {
  const output = signals.output ?? "";
  const authCompleted = matchesAny(output, AUTH_COMPLETED_PATTERNS);

  const kind = ((): CredentialFailureKind | null => {
    // 已经拿到凭据之后的保存失败,和"没扫码"是两回事,必须单独成档,而且优先级最高。
    if (authCompleted && matchesAny(output, PERSIST_FAILURE_PATTERNS)) return "credential-save-failed";
    if (authCompleted && matchesAny(output, PERMISSION_PATTERNS)) return "credential-save-failed";
    // 我们自己的执行墙掐断,绝不能算成对端授权超时;只在确实是登录类命令时才出声。
    if ((signals.timedOut === true || signals.killed === true) && hasCredentialContext(output)) {
      return "sandbox-timeout";
    }
    if (matchesAny(output, QR_EXPIRED_PATTERNS)) return "qr-expired";
    if (matchesAny(output, CLI_AUTH_TIMEOUT_PATTERNS)) return "cli-auth-timeout";
    if (matchesAny(output, QR_PENDING_PATTERNS)) return "qr-pending";
    return null;
  })();
  if (!kind) return null;

  const copy = COPY[kind];
  return {
    kind,
    // 只要输出里出现过"已拿到凭据"的正向信号,就永远不允许再退回"用户没扫码"。
    authCompleted: copy.authCompleted || authCompleted,
    retryable: copy.retryable && !authCompleted,
    userMessage: copy.message,
    userNextStep: copy.nextStep,
  };
}

/**
 * 追加进工具结果、给模型看的如实说明。
 *
 * 与 killedCommandNotice 同一风格:先讲事实,再堵死错误归因,最后给唯一正确的下一步。
 * 用户可见的那句话由 userMessage 原文给出,要求模型原样转述,不许自行编造原因。
 */
export function credentialFailureNotice(diagnosis: CredentialFailureDiagnosis): string {
  const lines = [`凭据诊断:${diagnosis.userMessage}`];
  if (diagnosis.authCompleted) {
    lines.push(
      "事实核对:授权/扫码环节已经完成,凭据也已取得。" +
        "禁止再说「你没有完成扫码」「请重新扫码」;" +
        "禁止再调用 show_qr、也禁止重新执行任何会重新出码的登录命令——" +
        "重复出码只会让用户白等,失败点根本不在扫码。",
      "立即停止本次登录编排,先如实向用户说明保存失败,再决定下一步;" +
        "不要靠反复重试碰运气。",
    );
  }
  if (!diagnosis.retryable && !diagnosis.authCompleted) {
    lines.push("原样重试无意义:先弄清失败在哪一步,再决定怎么做。");
  }
  lines.push(
    "验证登录状态一律用工具自带的只读查询子命令(如 whoami)," +
      "禁止附加 --force 之类会重建客户端、强制重新认证的参数——" +
      "那会把已完成的登录推倒重来,再次陷入「出码→等待→超时」的死循环。",
  );
  lines.push(`转述给用户时用这句:${diagnosis.userMessage}${diagnosis.userNextStep}`);
  return lines.join("\n");
}
