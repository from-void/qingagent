import { realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, resolve, sep } from "node:path";
import { BUILTIN_SKILLS_DIR, USER_SKILLS_DIR } from "../skills/paths.js";
import { assessCommand } from "./commandRisk.js";
import { SANDBOX_BIN_DIR } from "./sandboxPaths.js";
import { SANDBOX_SESSIONS_BASE } from "./sessionWorkspace.js";
// shell-quote 无类型声明(CJS 包、无 @types)。必须用静态 import 让打包器(esbuild)把它
// 内联进 bundle——桌面端打包后不随包发布 node_modules,运行时 require 会找不到模块。
// @ts-expect-error shell-quote 无 .d.ts
import shellQuote from "shell-quote";

type ShellQuoteToken = string | { op: string; pattern?: string };

const { parse: parseShell } = shellQuote as {
  parse: (command: string) => ShellQuoteToken[];
};

export type PolicyDecision =
  | { action: "allow"; credentialConsumer?: "trusted-node-skill" }
  | { action: "deny"; reason: string }
  | { action: "confirm"; reason: string };

export interface CommandPolicyOptions {
  /** 相对 node 脚本路径的解析基准。生产环境传会话沙箱目录;测试可传临时目录。 */
  workspaceCwd?: string;
  /** 受信脚本根。默认只允许内置 skills 与用户 skills。 */
  trustedScriptRoots?: string[];
  /** 产品级 CLI 目录。生产环境默认 SANDBOX_BIN_DIR；测试可注入临时目录。 */
  sandboxBinDir?: string;
  /** 是否以后台进程方式执行(execute_command background:true)。gate 据此区分前台/后台:
   *  阻塞式命令(lark-cli config init)前台 deny、后台放行(后台不挂死本轮,由 get_process_output 取早期输出)。 */
  background?: boolean;
}

const NODE_COMMANDS = new Set(["node", "nodejs", "node.cmd", "node.exe"]);
const SHELL_EXPANSION_META_RE = /[\[\]{}*?~]/;
const DENIED_INTERPRETERS = new Set([
  "python",
  "python3",
  "python.exe",
  "perl",
  "ruby",
  "php",
  "osascript",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "deno",
  "bun",
  "sh",
  "bash",
  "zsh",
  "cmd",
  "cmd.exe",
]);
const NODE_INLINE_FLAGS = new Set(["-e", "--eval", "-p", "--print", "--input-type"]);

function isStringToken(token: unknown): token is string {
  return typeof token === "string";
}

// 剥离 agent 调 CLI 时高频但无害的 shell 修饰,剥完按主命令判定;危险操作剥不掉、仍按非字符串 token 拦。
//  ① 2>&1:shell-quote 解析成 "2" {op:">&"} "1",是把 stderr 并入 stdout 的 fd 复制——不碰文件系统、不串第二条命令。
//  ② 末尾"吞结果/无操作"容错尾巴 `<;|&&|||> true|:`:退出码由沙箱单独捕获,这种尾巴对 agent 无意义但极常见。
// 剥不掉的:文件重定向(>/>>)、>&file、管道(|)、把"真命令"接在 &&/||/; 后——仍是非字符串 token → deny。
function isOp(token: ShellQuoteToken, op: string): boolean {
  return typeof token === "object" && token !== null && token.op === op;
}
function stripBenignShellOps(tokens: ShellQuoteToken[]): ShellQuoteToken[] {
  // ① 剥 2>&1
  const out: ShellQuoteToken[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (isOp(tok, ">&") && tokens[i - 1] === "2" && tokens[i + 1] === "1") {
      out.pop(); // 弹出刚入栈的 "2"
      i += 1; // 跳过 "1"
      continue;
    }
    out.push(tok);
  }
  // ② 反复剥末尾的 `<;|&&|||> true|:`(无操作容错尾巴)
  while (out.length >= 2) {
    const last = out[out.length - 1];
    const prev = out[out.length - 2]!;
    const isNoop = last === "true" || last === ":";
    const isJoiner = isOp(prev, "||") || isOp(prev, "&&") || isOp(prev, ";");
    if (!isNoop || !isJoiner) break;
    out.length -= 2;
  }
  return out;
}

// 允许出现在受信命令前的「无害」环境变量前缀白名单。只放 lark-cli 专用禁代理开关,不影响二进制解析、
// 也无法把流量导向攻击者——供 agent 在坏代理下自救(如 LARK_CLI_NO_PROXY=1 绕过 reset 飞书的代理)。
// 产品级 buildSandboxEnv 已自动把飞书域名并入 NO_PROXY;命令级 NO_PROXY/no_proxy 覆盖会破坏飞书直连保护,一律 deny。
// 严禁 HTTP(S)_PROXY/ALL_PROXY(可指向恶意代理外泄凭据)、PATH/LD_*/NODE_OPTIONS(劫持执行/注入代码)。
const ALLOWED_ENV_PREFIX_VARS = new Set(["LARK_CLI_NO_PROXY"]);
// env 赋值的值必须是「老实」标量(命令替换/glob 已被上游 hasUnsafeExpansionSyntax / shell-quote 拦,这里再兜一层)。
const SAFE_ENV_VALUE_RE = /^[A-Za-z0-9_.:,@-]*$/;
// 剥离开头连续的、白名单内的 KEY=val 前缀;命中非白名单赋值(PATH= / HTTPS_PROXY= 等)立即停止,
// 让它留在原位、被后续「未知命令名」兜底 deny。
function stripAllowedEnvPrefix(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    const eq = tok.indexOf("=");
    if (eq <= 0) break; // 不是 KEY=val,到真正的命令名了
    if (!ALLOWED_ENV_PREFIX_VARS.has(tok.slice(0, eq))) break;
    if (!SAFE_ENV_VALUE_RE.test(tok.slice(eq + 1))) break;
    i += 1;
  }
  return tokens.slice(i);
}

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

function realpathIfExists(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isExecutableFile(path: string): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    // Windows 由受支持的可执行扩展名判定；POSIX 至少需要一类主体拥有执行位。
    return process.platform === "win32" || (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function sandboxBinCandidates(command: string, binDir: string): string[] {
  if (process.platform !== "win32") return [resolve(binDir, command)];
  const lower = command.toLowerCase();
  if ([".cmd", ".exe", ".bat"].some((ext) => lower.endsWith(ext))) {
    return [resolve(binDir, command)];
  }
  return [".cmd", ".exe", ".bat"].map((ext) => resolve(binDir, `${command}${ext}`));
}

/** 产品安装目录内的实名 CLI：只认裸命令对应的真实可执行文件，拒绝 symlink 逃逸。 */
function isInstalledSandboxBinCli(command: string, binDir = SANDBOX_BIN_DIR): boolean {
  let realBinDir: string;
  try {
    realBinDir = realpathSync(binDir);
  } catch {
    return false;
  }

  const literalBinDir = resolve(binDir);
  return sandboxBinCandidates(command, literalBinDir).some((candidate) => {
    if (!isInsideRoot(candidate, literalBinDir) || !isExecutableFile(candidate)) return false;
    try {
      return isInsideRoot(realpathSync(candidate), realBinDir);
    } catch {
      return false;
    }
  });
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

function hasUnsafeExpansionSyntax(command: string): boolean {
  return /[`$]|\r|\n/.test(command);
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

export function isTrustedScriptPath(scriptPath: string, roots = [BUILTIN_SKILLS_DIR, USER_SKILLS_DIR]): boolean {
  if (hasShellExpansionMetacharacter(scriptPath)) return false;
  const literalPath = resolve(scriptPath);
  const realPath = realpathIfExists(literalPath);
  const literalExt = extname(literalPath).toLowerCase();
  const realExt = extname(realPath).toLowerCase();
  if ((literalExt !== ".mjs" && literalExt !== ".js") || (realExt !== ".mjs" && realExt !== ".js")) {
    return false;
  }
  return roots.some((root) => {
    const literalRoot = resolve(root);
    const realRoot = realpathIfExists(literalRoot);
    return isInsideRoot(literalPath, literalRoot) && isInsideRoot(realPath, realRoot);
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

function validateJsonLocalPathReferences(value: unknown, workspaceCwd: string, flag: string, insideAttachments = false): PolicyDecision | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const decision = validateJsonLocalPathReferences(item, workspaceCwd, flag, insideAttachments);
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

function evaluateNodeCommand(args: string[], options: CommandPolicyOptions): PolicyDecision {
  const script = findNodeScriptArg(args);
  if (!script.script) {
    return { action: "deny", reason: script.reason ?? "node 必须指定脚本" };
  }
  const cwd = options.workspaceCwd ?? SANDBOX_SESSIONS_BASE;
  const scriptAbs = isAbsolute(script.script) ? script.script : resolve(cwd, script.script);
  if (!isTrustedScriptPath(scriptAbs, options.trustedScriptRoots)) {
    return {
      action: "deny",
      reason: "node 只能运行受信 skills 目录下的 .mjs/.js 脚本,不能运行 /workspace 任意脚本",
    };
  }
  const scriptArgs = args.slice((script.scriptIndex ?? 0) + 1);
  const fileArgDecision = validateTrustedScriptFileArgs(scriptArgs, cwd);
  if (fileArgDecision) return fileArgDecision;
  return { action: "allow", credentialConsumer: "trusted-node-skill" };
}

function stripLarkGlobalFlags(args: string[]): string[] {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--profile") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--profile=") || arg === "-h" || arg === "--help" || arg === "-v" || arg === "--version") {
      continue;
    }
    positional.push(arg);
  }
  return positional;
}

// lark-cli 是受信产品级 CLI(裸命令名由上游强制、装在只读的 SANDBOX_BIN_DIR、版本由我们锁),
// 能力受用户 OAuth 授权范围限定。产品定位是"用户授权后 AI 代操作其飞书",所以默认放开读写——
// 安全由:① OAuth 授权范围;② 系统提示防注入红线;③ 命令卡可见 + 上游路径/元字符拦截。
// 授权编排只允许 connector service 的固定 argv runner 执行；模型命令 gate 封死全部授权入口。
//  - update/upgrade:触发 npm 自更新,网络阻塞/版本漂移,版本由产品锁定,不许 agent 跑。
//  - auth login/logout/qrcode 与 config init:一律 deny(不分前后台)。授权与应用配置的
//    唯一入口是 feishu_auth_start → connector service 的固定 argv runner;模型侧封死,
//    防止绕过连接器拼接授权命令(device_code 只在 service 内部,不得进入对话链路)。
function evaluateLarkCli(args: string[], options: CommandPolicyOptions): PolicyDecision {
  // cobra 持久全局 flag 可在子命令前或中间出现;先剥掉已知全局 flag,再判断真实子命令序列。
  const cleanArgs = stripLarkGlobalFlags(args);
  const sub = (cleanArgs[0] ?? "").toLowerCase();
  if (sub === "update" || sub === "upgrade") {
    return { action: "deny", reason: "不允许 agent 触发 lark-cli 自更新(版本由产品锁定)" };
  }
  const action = (cleanArgs[1] ?? "").toLowerCase();
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

/** 执行前硬 gate:白名单放行,其余拒绝或留给未来审批流。 */
export function evaluateCommandPolicy(command: string, options: CommandPolicyOptions = {}): PolicyDecision {
  if (command.trim().length === 0) {
    return { action: "deny", reason: "命令为空" };
  }
  if (hasUnsafeExpansionSyntax(command)) {
    return { action: "deny", reason: "命令含 shell 展开 / 命令替换 / 多行语法,不允许" };
  }

  let tokens: ShellQuoteToken[];
  try {
    tokens = parseShell(command);
  } catch {
    return { action: "deny", reason: "命令无法安全解析" };
  }
  if (tokens.length === 0) {
    return { action: "deny", reason: "命令为空" };
  }
  // 放行无害的 shell 修饰(2>&1、末尾 || true 等容错尾巴),剥离后按剩余 token 判定。
  const effectiveTokens = stripBenignShellOps(tokens);
  if (!effectiveTokens.every(isStringToken)) {
    return { action: "deny", reason: "命令含 shell 元字符 / 组合 / 重定向 / 替换 / glob,不允许" };
  }

  // 剥离白名单内的无害 env 前缀(LARK_CLI_NO_PROXY=1,供坏代理下自救);
  // NO_PROXY/no_proxy 会覆盖 buildSandboxEnv 注入的飞书直连保护,不剥 → 落到兜底 deny。
  // 剥完按真正的命令名判定;非白名单赋值(PATH= / HTTPS_PROXY= 等)不剥 → 落到兜底 deny。
  const commandTokens = stripAllowedEnvPrefix(effectiveTokens as string[]);
  const [rawCommand, ...args] = commandTokens;
  if (!rawCommand) {
    return { action: "deny", reason: "命令为空(仅含环境变量赋值或为空)" };
  }
  if (rawCommand.includes("=")) {
    return { action: "deny", reason: "环境变量前缀未被允许或值不安全" };
  }
  const cmd = commandName(rawCommand);
  // 受信命令(node / lark-cli)必须是裸命令名,经受控 PATH(打包 node shim + 系统二进制)解析。
  // 路径限定形式(/workspace/node、./node、/tmp/x/node)可能指向工作区内模型自己写的 fake 可执行
  // 文件——basename 命中白名单会被当成受信 node 放行,实际却跑攻击者文件(R10 codex-4)。故白名单
  // 分支只认裸名;denied 解释器仍按 basename 拦(/usr/bin/python3 也要 deny)。
  const isBareCommand = !/[/\\]/.test(rawCommand);
  if (DENIED_INTERPRETERS.has(cmd)) {
    return { action: "deny", reason: "不允许运行该解释器 / shell" };
  }
  if (isBareCommand && NODE_COMMANDS.has(cmd)) {
    return evaluateNodeCommand(args, options);
  }
  if (isBareCommand && cmd === "lark-cli") {
    return evaluateLarkCli(args, options);
  }
  if (!isBareCommand) {
    return {
      action: "deny",
      reason: "命令必须用裸命令名(经受控 PATH 解析到打包 node shim / 系统二进制),不允许路径限定的可执行文件",
    };
  }
  // 产品安装进 SANDBOX_BIN_DIR 的第三方 CLI 仍在既有 OS 沙箱中运行：cwd 已锁定会话目录，
  // 写入边界由 OS 沙箱承担。这里不复制 lark-cli 的逐 flag 路径白名单；lark-cli 因持有专有
  // OAuth 凭据继续走上面的特批分支。实名文件还需 realpath 留在 bin 内，避免 symlink 指向目录外。
  if (isInstalledSandboxBinCli(rawCommand, options.sandboxBinDir)) {
    return { action: "allow" };
  }

  const verdict = assessCommand(command);
  if (verdict.risk === "confirm") {
    return {
      action: "confirm",
      reason: verdict.detail ?? "该命令需要用户审批,当前版本不执行未审批命令",
    };
  }
  if (verdict.risk === "deny") {
    return { action: "deny", reason: verdict.denyReason ?? "命令被风险策略拒绝" };
  }
  return { action: "deny", reason: "命令不在允许清单内" };
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
