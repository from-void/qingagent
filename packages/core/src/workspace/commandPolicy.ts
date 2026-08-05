import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, resolve, sep } from "node:path";
import {
  BUILTIN_SKILLS_DIR,
  USER_SKILLS_DIR,
  USER_SKILL_SOURCE_DIRS,
} from "../skills/paths.js";
import {
  analyzeCommand,
  assessCommandAnalysis,
  type AnalyzedSimpleCommand,
} from "./commandRisk.js";
import { parseLarkCliCommandPath } from "./larkCliCommand.js";
import { QINGAGENT_DATA_DIR, SANDBOX_SESSIONS_BASE } from "./sessionWorkspace.js";
import { evaluateWindowsCommandBoundary } from "./windowsCommandBoundary.js";

export type PolicyDecision =
  | { action: "allow"; credentialConsumer?: "trusted-node-skill" }
  | { action: "deny"; reason: string }
  | {
      action: "confirm";
      reason: string;
      credentialConsumer?: "trusted-node-skill";
      /** 安全边界例外必须逐次确认，不接受全局免询问或类别授权。 */
      requiresExplicitApproval?: true;
    };

export function commandPolicyRequiresApproval(
  decision: PolicyDecision,
  bypassEnabled: boolean,
): boolean {
  return decision.action === "confirm" &&
    (decision.requiresExplicitApproval === true || !bypassEnabled);
}

export interface CommandPolicyOptions {
  /** 相对 node 脚本路径的解析基准。生产环境传会话沙箱目录;测试可传临时目录。 */
  workspaceCwd?: string;
  /** 受信脚本根。默认只允许内置 skills 与用户 skills。 */
  trustedScriptRoots?: string[];
  /** 兼容既有调用；翻转后产品 bin 是否存在不再构成策略授权条件。 */
  sandboxBinDir?: string;
  /** 是否以后台进程方式执行(execute_command background:true)；硬 deny 不因后台模式放宽。 */
  background?: boolean;
  /** 生产取 process.platform；测试可注入 win32 验证 Windows 执行墙。 */
  platform?: NodeJS.Platform;
  /** Windows 路径变量的宿主真值；不进入子进程，仅供执行前路径判定。 */
  env?: NodeJS.ProcessEnv;
  /** Windows 桌面 userData/data 根；用于保护 .env/*.db/Local Storage 等配置。 */
  dataDir?: string;
}

const NODE_COMMANDS = new Set(["node", "nodejs"]);
const SHELL_EXPANSION_META_RE = /[`$\[\]{}*?~]/;
const NODE_INLINE_FLAGS = new Set(["-e", "--eval", "-p", "--print", "--input-type"]);

function commandName(command: string): string {
  return basename(command).toLowerCase();
}

function normalizeForCompare(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isInsideRoot(path: string, root: string): boolean {
  const p = normalizeForCompare(path);
  const r = normalizeForCompare(root);
  return p === r || p.startsWith(r.endsWith(sep) ? r : `${r}${sep}`);
}

function resolveThroughExistingAncestors(path: string): string {
  const abs = resolve(path);
  const missingSegments: string[] = [];
  let cursor = abs;
  while (true) {
    try {
      const realExisting = realpathSync(cursor);
      return resolve(realExisting, ...missingSegments.reverse());
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) {
        return abs;
      }
      missingSegments.push(basename(cursor));
      cursor = parent;
    }
  }
}

function hasShellExpansionMetacharacter(value: string): boolean {
  return SHELL_EXPANSION_META_RE.test(value);
}

function unsafeTrustedScriptFileArgReason(value: string): string | null {
  const trimmed = value.trim();
  if (value.includes("\0")) return "--file 路径不能包含 null 字节";
  if (hasShellExpansionMetacharacter(value)) return "--file 路径含 shell 展开元字符,不允许";
  if (trimmed.includes("://") || /^file:/i.test(trimmed) || trimmed.startsWith("//")) {
    return "--file 只能使用当前会话工作目录内的普通文件路径,不能使用 URL";
  }
  return null;
}

function hasNodeInlineFlag(arg: string): boolean {
  if (NODE_INLINE_FLAGS.has(arg)) return true;
  return arg.startsWith("--eval=") ||
    arg.startsWith("--print=") ||
    arg.startsWith("--input-type=") ||
    arg.startsWith("-e") ||
    arg.startsWith("-p");
}

function findNodeScriptArg(args: string[]): { script?: string; scriptIndex?: number; reason?: string } {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (hasNodeInlineFlag(arg)) {
      return { reason: "不允许 node 内联执行(-e/--eval/-p/--print/--input-type)" };
    }
    if (arg === "--") {
      return args[i + 1]
        ? { script: args[i + 1], scriptIndex: i + 1 }
        : { reason: "node 必须指定脚本" };
    }
    if (arg.startsWith("-")) {
      return { reason: "不允许使用 node 运行时选项" };
    }
    return { script: arg, scriptIndex: i };
  }
  return { reason: "node 必须指定脚本" };
}

export function isTrustedScriptPath(
  scriptPath: string,
  roots = [BUILTIN_SKILLS_DIR, ...USER_SKILL_SOURCE_DIRS],
): boolean {
  if (hasShellExpansionMetacharacter(scriptPath)) return false;
  const literalPath = resolve(scriptPath);
  let realPath: string;
  try {
    const stat = lstatSync(literalPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    realPath = realpathSync(literalPath);
  } catch {
    return false;
  }
  const literalExt = extname(literalPath).toLowerCase();
  const realExt = extname(realPath).toLowerCase();
  if ((literalExt !== ".mjs" && literalExt !== ".js") || (realExt !== ".mjs" && realExt !== ".js")) return false;
  return roots.some((root) => {
    const literalRoot = resolve(root);
    try {
      const realRoot = realpathSync(literalRoot);
      return isInsideRoot(literalPath, literalRoot) && isInsideRoot(realPath, realRoot);
    } catch {
      return false;
    }
  });
}

function validateTrustedScriptFileArgs(args: string[], workspaceCwd: string): PolicyDecision | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    let value: string | undefined;
    if (arg === "--file") {
      value = args[i + 1];
      i += 1;
    } else if (arg.startsWith("--file=")) {
      value = arg.slice("--file=".length);
    } else {
      continue;
    }

    if (value === undefined || value.trim().length === 0) {
      return { action: "deny", reason: "--file 必须指定工作目录内的文件路径" };
    }
    const fileDecision = validateWorkspaceLocalPathArg(value, workspaceCwd, "--file", "读取");
    if (fileDecision) return fileDecision;
  }
  return null;
}

const LARK_LOCAL_PATH_FLAGS = new Set([
  "--file",
  "--path",
  "--local-dir",
  "--image",
  "--audio",
  "--video",
  "--video-cover",
  "--body-file",
  "--patch-file",
  "--template-content-file",
  "--set-template-content-file",
  "--project-path",
  "--dir",
  "--output",
  "--output-dir",
  "--output-path",
]);
const LARK_COMMA_SEPARATED_LOCAL_PATH_FLAGS = new Set(["--attach"]);
const LARK_AT_FILE_PAYLOAD_FLAGS = new Set([
  "--content",
  "--pattern",
  "--parts",
  "--source",
  "--data",
  "--params",
  "--csv",
  "--operations",
  "--headers",
  "--values",
  "--properties",
  "--ranges",
  "--border-styles",
  "--colors",
  "--options",
  "--sort-keys",
  "--todos",
  "--todo",
  "--summary",
  "--replace-words",
  "--filter-json",
  "--sort-json",
]);
const LARK_JSON_LOCAL_PATH_FLAGS = new Set(["--inline", "--json"]);
const LARK_HTML_LOCAL_REFERENCE_FLAGS = new Set(["--template-content", "--set-template-content"]);

function isHttpRemoteReference(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function normalizeLarkLocalPathValue(flag: string, value: string): string {
  const atStripped = value.startsWith("@") && value !== "@-" ? value.slice(1) : value;
  // lark-cli api --file 支持 [field=]path。必须校验等号右侧真实路径,否则 field=/etc/passwd 会绕过。
  if (flag === "--file") {
    const eq = atStripped.indexOf("=");
    if (eq > 0) {
      const field = atStripped.slice(0, eq);
      const filePath = atStripped.slice(eq + 1);
      if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(field) && filePath.length > 0) {
        return filePath;
      }
    }
  }
  return atStripped;
}

function validateWorkspaceLocalPathArg(
  value: string,
  workspaceCwd: string,
  flag: string,
  actionLabel: "读取" | "访问" = "访问",
  options: { allowHttpRemoteReference?: boolean } = {},
): PolicyDecision | null {
  const pathValue = normalizeLarkLocalPathValue(flag, value);
  if (pathValue === "-" || pathValue === "@-") return null;
  if (options.allowHttpRemoteReference && isHttpRemoteReference(pathValue)) return null;
  if (pathValue.trim().length === 0) {
    return { action: "deny", reason: `${flag} 必须指定当前会话工作目录内的路径` };
  }
  const unsafeReason = unsafeTrustedScriptFileArgReason(pathValue);
  if (unsafeReason) {
    return { action: "deny", reason: unsafeReason.replaceAll("--file", flag) };
  }
  const fileAbs = resolveThroughExistingAncestors(resolve(workspaceCwd, pathValue));
  if (!isInsideRoot(fileAbs, workspaceCwd)) {
    return {
      action: "deny",
      reason: `lark-cli ${flag} 只能${actionLabel}当前会话工作目录内的文件`,
    };
  }
  return null;
}

function validateLarkWorkspaceLocalPathArg(
  value: string,
  workspaceCwd: string,
  flag: string,
  actionLabel: "读取" | "访问" = "访问",
): PolicyDecision | null {
  return validateWorkspaceLocalPathArg(value, workspaceCwd, flag, actionLabel, {
    allowHttpRemoteReference: true,
  });
}

function validateCommaSeparatedLocalPathArg(value: string, workspaceCwd: string, flag: string): PolicyDecision | null {
  for (const part of value.split(",")) {
    const item = part.trim();
    if (item.length === 0) continue;
    const decision = validateLarkWorkspaceLocalPathArg(item, workspaceCwd, flag, "读取");
    if (decision) return decision;
  }
  return null;
}

function validateAtFilePayloadArg(value: string, workspaceCwd: string, flag: string): PolicyDecision | null {
  if (!value.startsWith("@") || value === "@-") return null;
  return validateLarkWorkspaceLocalPathArg(value, workspaceCwd, flag, "读取");
}

function validateJsonLocalPathReferences(
  value: unknown,
  workspaceCwd: string,
  flag: string,
  insideAttachments = false,
  depth = 0,
): PolicyDecision | null {
  if (depth > 64) return { action: "deny", reason: `lark-cli ${flag} 的 JSON 嵌套超过校验预算` };
  if (Array.isArray(value)) {
    for (const item of value) {
      const decision = validateJsonLocalPathReferences(item, workspaceCwd, flag, insideAttachments, depth + 1);
      if (decision) return decision;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const lowerKey = key.toLowerCase();
      const childIsPath =
        lowerKey === "file_path" ||
        lowerKey === "filepath" ||
        lowerKey === "local_path" ||
        lowerKey === "localpath";
      if (typeof child === "string" && (insideAttachments || childIsPath)) {
        const decision = validateLarkWorkspaceLocalPathArg(child, workspaceCwd, flag, "读取");
        if (decision) return decision;
        continue;
      }
      const decision = validateJsonLocalPathReferences(
        child,
        workspaceCwd,
        flag,
        insideAttachments || lowerKey === "attachments",
        depth + 1,
      );
      if (decision) return decision;
    }
  }
  return null;
}

function validateJsonLocalPathArg(value: string, workspaceCwd: string, flag: string): PolicyDecision | null {
  const atFileDecision = validateAtFilePayloadArg(value, workspaceCwd, flag);
  if (atFileDecision) return atFileDecision;
  try {
    return validateJsonLocalPathReferences(JSON.parse(value), workspaceCwd, flag);
  } catch {
    return null;
  }
}

function validateSlidesLocalReferences(value: string, workspaceCwd: string): PolicyDecision | null {
  const atFileDecision = validateAtFilePayloadArg(value, workspaceCwd, "--slides");
  if (atFileDecision) return atFileDecision;
  const srcRe = /\bsrc\s*=\s*["']@([^"']+)["']/gi;
  for (const match of value.matchAll(srcRe)) {
    const pathValue = match[1];
    if (!pathValue) continue;
    const decision = validateLarkWorkspaceLocalPathArg(pathValue, workspaceCwd, "--slides", "读取");
    if (decision) return decision;
  }
  return null;
}

function validateHtmlLocalReferences(value: string, workspaceCwd: string, flag: string): PolicyDecision | null {
  const srcRe = /\bsrc\s*=\s*["']([^"']+)["']/gi;
  for (const match of value.matchAll(srcRe)) {
    const pathValue = match[1]?.trim();
    if (!pathValue || isHttpRemoteReference(pathValue) || /^cid:/i.test(pathValue) || /^data:/i.test(pathValue)) {
      continue;
    }
    const decision = validateLarkWorkspaceLocalPathArg(pathValue, workspaceCwd, flag, "读取");
    if (decision) return decision;
  }
  return null;
}

const LARK_SHORT_LOCAL_PATH_FLAG_ALIASES = new Map([
  ["-o", "--output"],
]);

function getFlagValue(args: string[], index: number): { flag: string; value?: string; nextIndex: number } | null {
  const arg = args[index]!;
  for (const [shortFlag, longFlag] of LARK_SHORT_LOCAL_PATH_FLAG_ALIASES) {
    if (arg === shortFlag) {
      const next = args[index + 1];
      if (typeof next === "string" && !next.startsWith("--")) {
        return { flag: longFlag, value: next, nextIndex: index + 1 };
      }
      return { flag: longFlag, nextIndex: index };
    }
    if (arg.startsWith(`${shortFlag}=`)) {
      return { flag: longFlag, value: arg.slice(shortFlag.length + 1), nextIndex: index };
    }
    if (arg.startsWith(shortFlag) && arg.length > shortFlag.length) {
      return { flag: longFlag, value: arg.slice(shortFlag.length), nextIndex: index };
    }
  }
  if (!arg.startsWith("--")) return null;
  const eq = arg.indexOf("=");
  if (eq > 0) {
    return { flag: arg.slice(0, eq), value: arg.slice(eq + 1), nextIndex: index };
  }
  const next = args[index + 1];
  if (typeof next === "string" && !next.startsWith("--")) {
    return { flag: arg, value: next, nextIndex: index + 1 };
  }
  return { flag: arg, nextIndex: index };
}

function validateLarkCliLocalPathArgs(args: string[], workspaceCwd: string): PolicyDecision | null {
  for (let i = 0; i < args.length; i += 1) {
    const parsed = getFlagValue(args, i);
    if (!parsed) continue;
    const flag = parsed.flag.toLowerCase();
    const value = parsed.value;
    const knownLocalPathFlag =
      LARK_LOCAL_PATH_FLAGS.has(flag) ||
      LARK_COMMA_SEPARATED_LOCAL_PATH_FLAGS.has(flag) ||
      LARK_AT_FILE_PAYLOAD_FLAGS.has(flag) ||
      LARK_JSON_LOCAL_PATH_FLAGS.has(flag) ||
      flag === "--slides" ||
      LARK_HTML_LOCAL_REFERENCE_FLAGS.has(flag);

    if (value === undefined) {
      if (LARK_LOCAL_PATH_FLAGS.has(flag) || LARK_COMMA_SEPARATED_LOCAL_PATH_FLAGS.has(flag)) {
        return { action: "deny", reason: `${parsed.flag} 必须指定当前会话工作目录内的路径` };
      }
      continue;
    }
    if (knownLocalPathFlag && hasShellExpansionMetacharacter(value)) {
      return { action: "deny", reason: `lark-cli ${flag} 的本地路径不能使用变量、glob 或命令替换` };
    }

    let decision: PolicyDecision | null = null;
    if (LARK_LOCAL_PATH_FLAGS.has(flag)) {
      decision = validateLarkWorkspaceLocalPathArg(value, workspaceCwd, flag, flag.startsWith("--output") ? "访问" : "读取");
    } else if (LARK_COMMA_SEPARATED_LOCAL_PATH_FLAGS.has(flag)) {
      decision = validateCommaSeparatedLocalPathArg(value, workspaceCwd, flag);
    } else if (LARK_AT_FILE_PAYLOAD_FLAGS.has(flag)) {
      decision = validateAtFilePayloadArg(value, workspaceCwd, flag);
    } else if (LARK_JSON_LOCAL_PATH_FLAGS.has(flag)) {
      decision = validateJsonLocalPathArg(value, workspaceCwd, flag);
    } else if (flag === "--slides") {
      decision = validateSlidesLocalReferences(value, workspaceCwd);
    } else if (LARK_HTML_LOCAL_REFERENCE_FLAGS.has(flag)) {
      decision = validateHtmlLocalReferences(value, workspaceCwd, flag);
    } else if (value.startsWith("@/") || value.startsWith("@./") || value.startsWith("@../")) {
      decision = validateAtFilePayloadArg(value, workspaceCwd, flag);
    }
    if (decision) return decision;
    if (knownLocalPathFlag || value.startsWith("@/") || value.startsWith("@./") || value.startsWith("@../")) {
      i = parsed.nextIndex;
    }
  }
  return null;
}

function trustedNodeCredentialConsumer(
  command: AnalyzedSimpleCommand,
  options: CommandPolicyOptions,
): "trusted-node-skill" | undefined {
  if (command.derived || !command.topLevel || command.wrapperUsed || command.envAssignments.length > 0) return undefined;
  if (command.hasRedirection || command.originalWords.some((word) => word.dynamic)) return undefined;
  const rawCommand = command.originalArgv[0];
  if (!rawCommand || /[/\\]/.test(rawCommand) || !NODE_COMMANDS.has(rawCommand)) return undefined;
  const script = findNodeScriptArg(command.argv.slice(1));
  if (!script.script) return undefined;
  const cwd = options.workspaceCwd ?? SANDBOX_SESSIONS_BASE;
  const scriptAbs = isAbsolute(script.script) ? script.script : resolve(cwd, script.script);
  if (!isTrustedScriptPath(scriptAbs, options.trustedScriptRoots)) return undefined;
  const scriptArgs = command.argv.slice((script.scriptIndex ?? 0) + 2);
  const fileArgDecision = validateTrustedScriptFileArgs(scriptArgs, cwd);
  return fileArgDecision ? undefined : "trusted-node-skill";
}

/**
 * 只读登录态查询的子命令名。这些命令的语义就是"看看我是谁/登没登录",
 * 它们**只查不改**,永远没有理由附带强制重新认证。
 */
const IDENTITY_PROBE_SUBCOMMANDS = new Set([
  "whoami",
  "who-am-i",
  "userinfo",
  "user-info",
]);

/** 会强制重新认证 / 重建客户端的参数。命中即意味着"推倒重来",不是查询。
 *  只收长参数:`-f` 在别的命令里太常见(tail -f 之类),放进来会误伤。 */
const FORCE_REAUTH_FLAGS = new Set([
  "--force",
  "--relogin",
  "--re-login",
  "--reauth",
  "--re-auth",
  "--force-login",
  "--force-auth",
  "--force-reauth",
  "--renew",
]);

function isForceReauthFlag(arg: string): boolean {
  const lower = arg.toLowerCase();
  const flag = lower.startsWith("--") && lower.includes("=") ? lower.slice(0, lower.indexOf("=")) : lower;
  return FORCE_REAUTH_FLAGS.has(flag);
}

/**
 * 只读登录态查询不得附带强制重新认证参数。
 *
 * 病根(0729 真机):`yuque whoami --json` 在本机读不到登录后被我们超时掐掉,链路却自作主张
 * 改跑 `yuque --force whoami --json`——那是**重新走一遍 OAuth**,把用户原有登录态推倒重来,
 * 用户既没被问过,也不知道自己刚刚被重新授权了。
 *
 * 这条规则是**无状态**的:查询就是查询,加了强制重认证参数它就不再是查询,一律拒。
 * 用户确实要重新授权时走正常的 login/auth 子命令(仍受既有风险策略与确认卡管辖),不受影响。
 */
function evaluateIdentityProbeReauth(command: AnalyzedSimpleCommand): PolicyDecision | null {
  const args = command.argv;
  const hasProbe = args.some((arg) => IDENTITY_PROBE_SUBCOMMANDS.has(arg.toLowerCase()));
  if (!hasProbe) return null;
  const forced = args.find((arg) => isForceReauthFlag(arg));
  if (!forced) return null;
  return {
    action: "deny",
    reason:
      "只读的登录态查询不允许附带强制重新认证参数——那会把用户已有的登录推倒重来。" +
      "请去掉该参数;确实需要重新授权时,先征求用户同意,再用工具自己的登录命令走后台执行",
  };
}

// lark-cli 写操作现在进入 send confirm；授权/自更新与本地路径仍是硬 deny。
// 授权编排只允许 connector service 的固定 argv runner 执行，模型命令 gate 封死全部授权入口。
//  - update/upgrade:触发 npm 自更新,网络阻塞/版本漂移,版本由产品锁定,不许 agent 跑。
//  - auth login/logout/qrcode 与 config init:一律 deny(不分前后台)。授权与应用配置的
//    唯一入口是 feishu_auth_start → connector service 的固定 argv runner;模型侧封死,
//    防止绕过连接器拼接授权命令(device_code 只在 service 内部,不得进入对话链路)。
function evaluateLarkCli(args: string[], options: CommandPolicyOptions): PolicyDecision {
  const parsed = parseLarkCliCommandPath(args);
  if (!parsed.ok) {
    return {
      action: "deny",
      reason: `${parsed.reason}，为避免绕过授权与外部写入保护，已拒绝执行`,
    };
  }
  const sub = parsed.commandPath[0] ?? "";
  if (sub === "update" || sub === "upgrade") {
    return { action: "deny", reason: "不允许 agent 触发 lark-cli 自更新(版本由产品锁定)" };
  }
  const action = parsed.commandPath[1] ?? "";
  if ((sub === "auth" && (action === "login" || action === "logout" || action === "qrcode")) ||
      (sub === "config" && action === "init")) {
    return {
      action: "deny",
      reason: "授权请走 feishu_auth_start；飞书应用配置、登录、登出和二维码授权由连接器安全处理",
    };
  }
  const fileArgDecision = validateLarkCliLocalPathArgs(args, options.workspaceCwd ?? SANDBOX_SESSIONS_BASE);
  if (fileArgDecision) return fileArgDecision;
  return { action: "allow" };
}

function evaluateCommandPolicyInner(command: string, options: CommandPolicyOptions): PolicyDecision {
  const analysis = analyzeCommand(command);
  if (analysis.error) return { action: "deny", reason: analysis.error };

  if ((options.platform ?? process.platform) === "win32") {
    const boundaryDecision = evaluateWindowsCommandBoundary(command, analysis, {
      workspaceCwd: options.workspaceCwd ?? SANDBOX_SESSIONS_BASE,
      env: options.env ?? process.env,
      dataDir: options.dataDir ?? QINGAGENT_DATA_DIR,
    });
    if (boundaryDecision) return boundaryDecision;
  }

  // 所有静态可识别命令段都先过 lark 特批；首段 allow 不能遮住 compound/shell -c 内的硬禁令。
  for (const simpleCommand of analysis.commands) {
    if (commandName(simpleCommand.argv[0] ?? "") !== "lark-cli") continue;
    const larkDecision = evaluateLarkCli(simpleCommand.argv.slice(1), options);
    if (larkDecision.action === "deny") return larkDecision;
  }

  // 只读登录态查询 + 强制重新认证参数:任何 CLI 都不放行,compound / shell -c 内同样兜住。
  for (const simpleCommand of analysis.commands) {
    const probeDecision = evaluateIdentityProbeReauth(simpleCommand);
    if (probeDecision) return probeDecision;
  }

  // 凭据只是能力标记，不是 allow 资格。必须是整条命令唯一的直接 simple-command。
  const soleCommand = analysis.commands.length === 1 && analysis.topLevelCommands.length === 1 &&
      !analysis.hasNestedCommands && !analysis.hasShellSyntax
    ? analysis.topLevelCommands[0]
    : undefined;
  const credentialConsumer = soleCommand
    ? trustedNodeCredentialConsumer(soleCommand, options)
    : undefined;

  const verdict = assessCommandAnalysis(analysis);
  if (verdict.risk === "confirm") {
    return {
      action: "confirm",
      reason: verdict.detail ?? "该命令包含需要用户确认的副作用",
      ...(credentialConsumer ? { credentialConsumer } : {}),
    };
  }
  if (verdict.risk === "deny") {
    return { action: "deny", reason: verdict.denyReason ?? "命令被风险策略拒绝" };
  }
  return credentialConsumer
    ? { action: "allow", credentialConsumer }
    : { action: "allow" };
}

/** 执行前硬 gate：最小硬拒绝 → 危险意图确认 → 默认放行。任何内部异常都确定性 deny。 */
export function evaluateCommandPolicy(command: string, options: CommandPolicyOptions = {}): PolicyDecision {
  try {
    return evaluateCommandPolicyInner(command, options);
  } catch {
    return { action: "deny", reason: "命令策略内部异常，已安全拒绝" };
  }
}

export function commandPolicyDenyMessage(decision: Exclude<PolicyDecision, { action: "allow" }>): string {
  const prefix = decision.action === "confirm" ? "命令需要审批" : "命令已被拒绝";
  return `${prefix}: ${decision.reason}`;
}

export async function runWithCommandPolicy<T>(
  command: string,
  run: () => Promise<T>,
  options: CommandPolicyOptions = {},
): Promise<T | string> {
  const decision = evaluateCommandPolicy(command, options);
  if (decision.action !== "allow") {
    return commandPolicyDenyMessage(decision);
  }
  return await run();
}
