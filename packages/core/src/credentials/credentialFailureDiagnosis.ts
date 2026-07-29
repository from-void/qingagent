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
  /**
   * 命令没读到可复用的登录态,已自行转入交互式 OAuth 等待,被我们主动收口。
   * 这一档**不靠猜输出**:由前台流式识别给出确定信号(见 interactiveAuthSignal.ts)。
   */
  | "interactive-auth-required"
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
  /**
   * 前台流式识别已确认"命令转入交互式授权等待",并由我们主动收口。
   * 这是**确定信号**而非文本猜测,优先级仅次于"凭据已到手却存不下"。
   */
  interactiveAuthDetected?: boolean;
  /**
   * 本次执行确实处于文件隔离形态(seatbelt/bwrap)。
   * 只用于把"读不到本机登录态"的说法从猜测升级为有依据的说明;
   * 拿不到这个事实时文案退回纯陈述,绝不臆断成因。
   */
  isolated?: boolean;
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
  // 措辞只讲我们确知的事实。历史上这里写过"不是你的授权出了问题"——我们根本没有
  // 任何证据支持这个断言(0729 语雀真机里恰恰就是登录态读不到),必须删掉。
  "sandbox-timeout": {
    message: "这条命令等待太久，已经被我这边结束了。",
    nextStep: "需要长时间等待的登录命令我会放到后台跑，稍后再看结果。",
    authCompleted: false,
    retryable: true,
  },
  "interactive-auth-required": {
    message: "当前命令没有读到可复用的登录状态，已经进入重新授权流程。",
    nextStep: "我不会在这里干等，需要的话我把授权放到后台跑，再把授权入口给你。",
    authCompleted: false,
    retryable: false,
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

/**
 * 隔离形态下的用户可见说法。
 *
 * 定稿取舍(UI 铁律:不得向用户暴露内部机制词):「隔离模式」「系统 Keychain」都是实现名词,
 * 用户看不懂也帮不上忙,一律不出现在用户文案里;换成用户能懂的「当前的安全设置」「你在终端里的
 * 登录状态」。给模型的事实说明则保留技术措辞(见 credentialFailureNotice),模型需要准确信息。
 */
const ISOLATED_INTERACTIVE_AUTH_MESSAGE =
  "当前的安全设置下读不到你在终端里的登录状态，所以这个工具要重新授权一次。";

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
    // 流式识别给的是确定信号,不是从文本里猜,所以排在所有文本模式之前。
    if (signals.interactiveAuthDetected === true) return "interactive-auth-required";
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
  // 只有"确实处于隔离形态 + 确实命中授权等待"两个事实同时成立,才敢把成因说到"读不到
  // 本机登录态"这一层;缺任何一个就退回纯陈述句,不猜。
  const userMessage =
    kind === "interactive-auth-required" && signals.isolated === true
      ? ISOLATED_INTERACTIVE_AUTH_MESSAGE
      : copy.message;
  return {
    kind,
    // 只要输出里出现过"已拿到凭据"的正向信号,就永远不允许再退回"用户没扫码"。
    authCompleted: copy.authCompleted || authCompleted,
    retryable: copy.retryable && !authCompleted,
    userMessage,
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
  if (diagnosis.kind === "interactive-auth-required") {
    // 给模型的事实说明可以技术化——它需要准确信息才能应对;用户可见的那句仍是 userMessage。
    lines.push(
      "事实核对:该命令没有拿到可复用的本机登录态(隔离执行时读不到宿主的系统钥匙串/凭据文件)," +
        "于是自行转入交互式 OAuth 等待;我们已在识别到这一点后主动结束了它,不是它自己失败,也不是我们的超时墙。",
      "行为约束:不要反复重试 whoami 之类的登录态查询;不要改用 --force 或任何会重建客户端、" +
        "强制重新认证的参数;不要重复生成二维码或反复重发授权链接——重复只会让用户白等,状态不会因此改变。",
      "正确出路:如果用户确实要重新授权,把授权命令改成 background:true 后台执行," +
        "再用 mastra_workspace_get_process_output 轮询拿到授权链接/二维码并交给用户;" +
        "如果用户只是想复用终端里已有的登录态,如实说明当前设置下读不到,再问他要不要调整,不要自作主张。",
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
