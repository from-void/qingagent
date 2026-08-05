import { lstatSync, realpathSync } from "node:fs";
import { win32 } from "node:path";
import type { CommandAnalysis } from "./commandRisk.js";

export interface WindowsCommandBoundaryOptions {
  workspaceCwd: string;
  env: NodeJS.ProcessEnv;
  dataDir: string;
}

export interface WindowsCommandBoundaryDecision {
  action: "deny" | "confirm";
  reason: string;
  /** 工作目录外普通文件读取只能按本次命令确认，不能被全局免询问或类别授权跳过。 */
  requiresExplicitApproval?: true;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const POWERSHELL_ENCODED_COMMAND =
  /(?:^|[\s"'])(?:powershell|pwsh)(?:\.exe)?\b[\s\S]*?(?:^|\s)-(?:enc|encodedcommand|encodedarguments)(?:\s|:|=|$)/i;
const WRITE_INTENT =
  /(?:^|[\s;&|("'])(?:set-content|add-content|out-file|new-item|copy-item|move-item|rename-item|remove-item|export-csv|tee-object|copy|xcopy|robocopy|move|ren|rename|del|erase|rd|rmdir|mkdir|md|mklink|fsutil|compact|cipher|attrib|icacls|takeown|reg|cp|mv|rm|touch|tee|install|truncate)(?:\.exe)?(?=$|[\s;&|)"'])|(?:^|\s)--?(?:o|out|output|output-dir|output-path|destination|dest|target)(?:=|\s)/i;
const INLINE_CODE_WRITE_INTENT =
  /(?:\b(?:writefile(?:sync)?|appendfile(?:sync)?|createwritestream|copyfile(?:sync)?|rename(?:sync)?|mkdir(?:sync)?|rm(?:sync)?|unlink(?:sync)?)\s*\(|::(?:writealltext|writeallbytes|appendalltext|create|openwrite)\s*\(|\.(?:write_text|write_bytes|mkdir|unlink|rename|replace)\s*\(|\bopen\s*\([^)]{0,240},\s*r?["'][^"']*[wax+])/i;
const DYNAMIC_PATH_REFERENCE = /%[^%]+%|![^!]+!|\$(?:env:|\{env:)?[A-Za-z_][A-Za-z0-9_]*(?:})?/i;
const OUTPUT_REDIRECTION_SYNTAX = /(?:^|[^>])>>?(?![&=])/;
const DIRECTORY_ENUMERATION_INTENT =
  /(?:^|[\s;&|("'])(?:dir|tree|ls|get-childitem|gci)(?:\.exe)?(?=$|[\s;&|)"'])/i;
const FILE_READ_INTENT =
  /(?:^|[\s;&|("'])(?:type|more|findstr|cat|head|tail|grep|stat|get-content|gc|import-csv|select-string|test-path|resolve-path|dir|tree|ls|get-childitem|gci)(?:\.exe)?(?=$|[\s;&|)"'])/i;

function lookupEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  const lowerName = name.toLowerCase();
  const entry = Object.entries(env).find(([key]) => key.toLowerCase() === lowerName);
  return entry?.[1];
}

function expandKnownWindowsEnvironment(input: string, env: NodeJS.ProcessEnv): string {
  let output = input.replace(/%([^%]+)%/g, (whole, name: string) => lookupEnv(env, name) ?? whole);
  output = output.replace(
    /\$env:([A-Za-z_][A-Za-z0-9_]*)|\$\{env:([A-Za-z_][A-Za-z0-9_]*)}/gi,
    (whole, directName: string | undefined, bracedName: string | undefined) =>
      lookupEnv(env, directName ?? bracedName ?? "") ?? whole,
  );
  const home = lookupEnv(env, "USERPROFILE");
  if (home) {
    output = output.replace(/(^|[\s"'=(:,;])~(?=[\\/])/g, (_whole, prefix: string) => `${prefix}${home}`);
  }
  return output;
}

function comparableText(input: string): string {
  return input
    .normalize("NFKC")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, "")
    // cmd 的 ^ 与 PowerShell 的 ` 都可把路径字符拆开；引号/字符串加号也不应逃过前缀检查。
    .replace(/[`^'"“”‘’]/g, "")
    .replace(/\s*\+\s*/g, "")
    .replaceAll("/", "\\")
    .toLowerCase();
}

function comparablePath(path: string): string {
  return win32.normalize(path).replace(/[\\/]+$/, "").toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsPathRoot(text: string, root: string): boolean {
  const normalizedRoot = comparablePath(root);
  if (!normalizedRoot) return false;
  const rootPattern = escapeRegExp(normalizedRoot);
  // Win32 会忽略路径分段末尾的点和空格，不能让 C:\\Windows.\\ 形成别名绕过。
  return new RegExp(`${rootPattern}[ .]*(?:\\\\|$|[\\s,;|&><)\]}])`, "i").test(text);
}

function systemRoots(env: NodeJS.ProcessEnv): string[] {
  const roots = new Set<string>();
  const add = (value: string | undefined): void => {
    if (value?.trim()) roots.add(comparablePath(value.trim()));
  };
  add(lookupEnv(env, "SystemRoot"));
  add(lookupEnv(env, "windir"));
  add(lookupEnv(env, "ProgramFiles"));
  add(lookupEnv(env, "ProgramFiles(x86)"));
  add(lookupEnv(env, "ProgramW6432"));
  add(lookupEnv(env, "ProgramData"));

  const systemDrive = lookupEnv(env, "SystemDrive")?.trim()
    ?? [...roots].map((root) => win32.parse(root).root.replace(/[\\/]+$/, "")).find(Boolean)
    ?? "C:";
  add(win32.join(systemDrive, "Windows"));
  add(win32.join(systemDrive, "Program Files"));
  add(win32.join(systemDrive, "Program Files (x86)"));
  add(win32.join(systemDrive, "ProgramData"));
  // 常见 8.3 别名不能绕过 Program Files 前缀。
  add(win32.join(systemDrive, "PROGRA~1"));
  add(win32.join(systemDrive, "PROGRA~2"));
  return [...roots];
}

function containsSystemPath(text: string, env: NodeJS.ProcessEnv): boolean {
  // cmd 的 %VAR:~start,len% 可从受保护变量重组路径，不能只展开精确变量名。
  if (/%(?:systemroot|windir|systemdrive|programfiles(?:\(x86\))?|programw6432|programdata)(?::[^%]*)?%/i.test(text)) {
    return true;
  }
  if (systemRoots(env).some((root) => containsPathRoot(text, root))) return true;
  // Win32 device path 与本机管理共享可绕过普通盘符前缀，统一按系统路径拒绝。
  return /(?:^|[\s=(:,;])(?:\\\\[?.]\\|\\[?]?[?]\\|\\\\(?:localhost|127\.0\.0\.1)\\[a-z]\$\\)/i.test(text);
}

function userDataRoot(dataDir: string): string {
  const normalized = win32.normalize(dataDir);
  return win32.basename(normalized).toLowerCase() === "data"
    ? win32.dirname(normalized)
    : normalized;
}

function containsCredentialPath(text: string, options: WindowsCommandBoundaryOptions): boolean {
  const home = lookupEnv(options.env, "USERPROFILE");
  if (home && containsPathRoot(text, win32.join(home, ".qingagent"))) return true;
  // 即使 USERPROFILE 被拆写或环境不完整，凭据目录名本身也不得通过。
  if (/(?:^|\\)\.qingagent(?:\\|$|[\s,;|&><)\]}])/i.test(text)) return true;

  const appRoot = comparablePath(userDataRoot(options.dataDir));
  const appRootPattern = escapeRegExp(appRoot);
  const protectedUnderUserData = new RegExp(
    String.raw`${appRootPattern}\\(?:` +
      String.raw`(?:[^\\\s"']+\\)*\.env|` +
      String.raw`(?:[^\\\s"']+\\)*[^\\\s"']+\.db(?:-[^\\\s"']+)?|` +
      String.raw`(?:[^\\\s"']+\\)*local storage(?:\\|$)|` +
      String.raw`data\\(?:\.cred-key|instance\.json)(?:$|[\s,;|&><)\]}])` +
    ")",
    "i",
  );
  if (protectedUnderUserData.test(text)) return true;

  // 通用凭据与浏览器身份库是永久硬拒绝面。allow-list 的按次确认只给普通文件开口，
  // 不能把“确认了一条 type 命令”变成读取 SSH key、云凭据或浏览器 cookie 的通行证。
  const credentialRoots = new Set<string>();
  const addRoot = (root: string | undefined): void => {
    if (root?.trim()) credentialRoots.add(root.trim());
  };
  if (home) {
    for (const relative of [
      ".ssh",
      ".aws",
      ".gnupg",
      ".kube",
      ".azure",
      ".docker",
      ".terraform.d",
      ".config\\gcloud",
      ".config\\gh",
    ]) {
      addRoot(win32.join(home, relative));
    }
  }
  const roaming = lookupEnv(options.env, "APPDATA") ??
    (home ? win32.join(home, "AppData", "Roaming") : undefined);
  const local = lookupEnv(options.env, "LOCALAPPDATA") ??
    (home ? win32.join(home, "AppData", "Local") : undefined);
  for (const base of [roaming, local]) {
    if (!base) continue;
    for (const relative of [
      "Google\\Chrome\\User Data",
      "Chromium\\User Data",
      "Microsoft\\Edge\\User Data",
      "BraveSoftware\\Brave-Browser\\User Data",
      "Mozilla\\Firefox\\Profiles",
      "Opera Software",
      "Microsoft\\Credentials",
      "Microsoft\\Vault",
      "Microsoft\\Crypto",
      "Microsoft\\Protect",
    ]) {
      addRoot(win32.join(base, relative));
    }
  }
  if ([...credentialRoots].some((root) => containsPathRoot(text, root))) return true;

  return /(?:^|\\)(?:\.netrc|\.npmrc|\.git-credentials|\.pypirc)(?:$|[\s,;|&><)\]}])/i.test(text);
}

interface RedirectionTarget {
  value: string;
  dynamic: boolean;
}

function outputRedirectionTargets(command: string): RedirectionTarget[] {
  const targets: RedirectionTarget[] = [];
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (char === "^" && quote === null) {
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char !== ">") continue;
    if (command[index + 1] === ">") index += 1;
    let cursor = index + 1;
    while (cursor < command.length && /\s/.test(command[cursor]!)) cursor += 1;
    // 2>&1 / >&2 是描述符复制，不是文件写目标。
    if (command[cursor] === "&" && /[0-9-]/.test(command[cursor + 1] ?? "")) continue;
    let value = "";
    const targetQuote = command[cursor] === "'" || command[cursor] === '"'
      ? command[cursor++] as "'" | '"'
      : null;
    while (cursor < command.length) {
      const targetChar = command[cursor]!;
      if (targetQuote ? targetChar === targetQuote : /[\s;&|<>()]/.test(targetChar)) break;
      value += targetChar;
      cursor += 1;
    }
    if (value) targets.push({ value, dynamic: DYNAMIC_PATH_REFERENCE.test(value) });
    index = Math.max(index, cursor - 1);
  }
  return targets;
}

function canonicalizeWithMissingTail(path: string): string {
  const absolute = win32.resolve(path);
  if (process.platform !== "win32") return win32.normalize(absolute);
  const missing: string[] = [];
  let cursor = absolute;
  while (true) {
    try {
      return win32.resolve(realpathSync.native(cursor), ...missing.reverse());
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code !== "ENOENT" && code !== "ENOTDIR") return win32.normalize(absolute);
      try {
        const info = lstatSync(cursor);
        if (info.isSymbolicLink()) return win32.normalize(absolute);
      } catch {
        // 继续向现存祖先回溯。
      }
      const parent = win32.dirname(cursor);
      if (parent === cursor) return win32.normalize(absolute);
      missing.push(win32.basename(cursor));
      cursor = parent;
    }
  }
}

function isInsideWorkspace(path: string, workspaceCwd: string): boolean {
  const candidate = comparablePath(canonicalizeWithMissingTail(path));
  const workspace = comparablePath(canonicalizeWithMissingTail(workspaceCwd));
  const relative = win32.relative(workspace, candidate);
  return relative === "" || (!relative.startsWith("..") && !win32.isAbsolute(relative));
}

function normalizeCandidate(raw: string): string | null {
  let value = raw.trim().replace(/^[,;]+|[,;]+$/g, "");
  if (!value) return null;
  const driveIndex = value.search(/[A-Za-z]:[\\/]/);
  const uncIndex = value.search(/\\\\[^\\/]+[\\/]/);
  const indexes = [driveIndex, uncIndex].filter((index) => index >= 0);
  if (indexes.length > 0) value = value.slice(Math.min(...indexes)).replace(/^[=:(]+/, "");
  if (!win32.isAbsolute(value)) {
    const traversal = value.match(/(?:^|[\s=:(])(\.\.[\\/][^\s"';&|<>()]*)/);
    if (traversal) value = traversal[1]!;
  }
  return value;
}

function pathCandidates(command: string): string[] {
  const candidates = new Set<string>();
  const parts = command.match(/"[^"]*"|'[^']*'|[^\s;&|><()]+/g) ?? [];
  for (const part of parts) {
    const candidate = normalizeCandidate(part.replace(/^['"]|['"]$/g, ""));
    if (candidate) candidates.add(candidate);
  }
  return [...candidates];
}

function isSameOrInside(candidate: string, root: string): boolean {
  const relative = win32.relative(comparablePath(root), comparablePath(candidate));
  return relative === "" || (!relative.startsWith("..") && !win32.isAbsolute(relative));
}

function sensitiveCandidateDenial(
  expandedCommand: string,
  options: WindowsCommandBoundaryOptions,
): WindowsCommandBoundaryDecision | null {
  const workspace = canonicalizeWithMissingTail(options.workspaceCwd);
  const appRoot = canonicalizeWithMissingTail(userDataRoot(options.dataDir));
  const protectedSystemRoots = systemRoots(options.env).map(canonicalizeWithMissingTail);

  for (const candidate of pathCandidates(expandedCommand)) {
    const resolved = canonicalizeWithMissingTail(
      win32.isAbsolute(candidate) ? candidate : win32.resolve(options.workspaceCwd, candidate),
    );
    if (protectedSystemRoots.some((root) => isSameOrInside(resolved, root))) {
      return { action: "deny", reason: "Windows 命令不允许读取或写入系统路径" };
    }
    // userData 是产品自身状态面。session 工作目录是唯一例外；其余位置不向命令开放，
    // 同时堵住 ..\\..\\instance.json 与工作区内 junction 指向凭据文件的别名。
    if (isSameOrInside(resolved, appRoot) && !isSameOrInside(resolved, workspace)) {
      return { action: "deny", reason: "Windows 命令不允许读取或写入应用凭据或配置路径" };
    }
  }
  return null;
}

function outsideWriteDenial(
  expandedCommand: string,
  analysis: CommandAnalysis,
  options: WindowsCommandBoundaryOptions,
): WindowsCommandBoundaryDecision | null {
  const redirections = outputRedirectionTargets(expandedCommand);
  for (const target of redirections) {
    if (target.dynamic) {
      return { action: "deny", reason: "Windows 写入目标无法静态确定，已拒绝工作目录外写入" };
    }
    const resolved = win32.isAbsolute(target.value)
      ? target.value
      : win32.resolve(options.workspaceCwd, target.value);
    if (!isInsideWorkspace(resolved, options.workspaceCwd)) {
      return { action: "deny", reason: "Windows 命令不允许写入当前会话工作目录之外" };
    }
  }

  // PowerShell 的 -Command body 通常整体被引号包住，外层扫描不会把其中的 > 当重定向；
  // 但对路径写墙而言它仍是实际文件写入，必须按写意图处理。
  const hasWriteIntent = redirections.length > 0 ||
    OUTPUT_REDIRECTION_SYNTAX.test(expandedCommand) ||
    WRITE_INTENT.test(expandedCommand) ||
    INLINE_CODE_WRITE_INTENT.test(expandedCommand);
  if (!hasWriteIntent) return null;
  if (analysis.commands.some((command) => command.words.some((word) => word.dynamic)) &&
      DYNAMIC_PATH_REFERENCE.test(expandedCommand)) {
    return { action: "deny", reason: "Windows 写入目标无法静态确定，已拒绝工作目录外写入" };
  }
  for (const candidate of pathCandidates(expandedCommand)) {
    const resolved = win32.isAbsolute(candidate)
      ? candidate
      : win32.resolve(options.workspaceCwd, candidate);
    if (!isInsideWorkspace(resolved, options.workspaceCwd)) {
      return { action: "deny", reason: "Windows 命令不允许写入当前会话工作目录之外" };
    }
  }
  return null;
}

function outsideReadDecision(
  expandedCommand: string,
  analysis: CommandAnalysis,
  options: WindowsCommandBoundaryOptions,
): WindowsCommandBoundaryDecision | null {
  if (FILE_READ_INTENT.test(expandedCommand) && DYNAMIC_PATH_REFERENCE.test(expandedCommand)) {
    return {
      action: "deny",
      reason: "Windows 读取目标无法静态确定，已拒绝工作目录外读取",
    };
  }
  const containsLarkCli = analysis.commands.some((command) =>
    win32.basename(command.argv[0] ?? "").toLowerCase() === "lark-cli"
  );
  for (const candidate of pathCandidates(expandedCommand)) {
    const resolved = win32.isAbsolute(candidate)
      ? candidate
      : win32.resolve(options.workspaceCwd, candidate);
    if (isInsideWorkspace(resolved, options.workspaceCwd)) continue;
    // lark-cli 的本地文件参数有更窄的专用硬边界；这里不能把 deny 降成可确认例外。
    if (containsLarkCli) {
      return {
        action: "deny",
        reason: "lark-cli --file 等本地路径参数只能读取当前会话工作目录内的文件",
      };
    }
    if (DIRECTORY_ENUMERATION_INTENT.test(expandedCommand)) {
      return {
        action: "deny",
        reason: "Windows 命令不允许枚举当前会话工作目录之外的目录；请先通过资料库选择器连接该目录",
      };
    }
    return {
      action: "confirm",
      reason: "Windows 命令读取当前会话工作目录之外的文件，需要用户按次确认",
      requiresExplicitApproval: true,
    };
  }
  return null;
}

/**
 * Windows 没有 Mastra 原生文件隔离时的同步执行 gate。
 * 它不依赖模型判断：任何命中都在 subprocess 创建前直接拒绝，前后台命令共用。
 */
export function evaluateWindowsCommandBoundary(
  command: string,
  analysis: CommandAnalysis,
  options: WindowsCommandBoundaryOptions,
): WindowsCommandBoundaryDecision | null {
  if (!command || CONTROL_CHARACTERS.test(command.replace(/[\r\n\t]/g, ""))) {
    return { action: "deny", reason: "Windows 命令包含不安全的控制字符" };
  }
  if (POWERSHELL_ENCODED_COMMAND.test(command)) {
    return { action: "deny", reason: "Windows 不允许执行无法审计路径的编码 PowerShell 命令" };
  }
  const expanded = expandKnownWindowsEnvironment(command, options.env);
  const comparable = comparableText(expanded);
  if (containsSystemPath(comparable, options.env)) {
    return { action: "deny", reason: "Windows 命令不允许读取或写入系统路径" };
  }
  if (containsCredentialPath(comparable, options)) {
    return { action: "deny", reason: "Windows 命令不允许读取或写入凭据或配置路径" };
  }
  const sensitiveCandidate = sensitiveCandidateDenial(expanded, options);
  if (sensitiveCandidate) return sensitiveCandidate;
  const outsideWrite = outsideWriteDenial(expanded, analysis, options);
  if (outsideWrite) return outsideWrite;
  return outsideReadDecision(expanded, analysis, options);
}
