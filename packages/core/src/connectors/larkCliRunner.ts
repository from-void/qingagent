import { execFile as execFileCallback, spawn as spawnChild } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { extractLarkConfigInitUrl } from "../tools/larkConfigUrl.js";
import { SANDBOX_BIN_DIR } from "../workspace/sandboxPaths.js";

export const LARK_CLI_TIMEOUT_MS = 8_000;
export const LARK_CLI_MAX_OUTPUT_BYTES = 128 * 1024;

export type LarkCliCommand =
  | readonly ["config", "show"]
  | readonly ["auth", "status", "--json"]
  | readonly ["auth", "logout"]
  | readonly ["config", "init", "--new", "--brand", "feishu", "--lang", "zh"]
  | readonly ["auth", "login", "--domain", string, "--no-wait", "--json"]
  | readonly ["auth", "login", "--device-code", string];

export const LARK_AUTH_DOMAINS = [
  "docs", "base", "sheets", "calendar", "im", "drive", "mail", "task",
  "approval", "contact", "minutes", "wiki",
] as const;
export type LarkAuthDomain = typeof LARK_AUTH_DOMAINS[number];
export const LARK_DEVICE_CODE = Symbol("lark-device-code");

export type LarkCliReasonCode =
  | "LARK_CLI_MISSING"
  | "LARK_CLI_SPAWN_FAILED"
  | "LARK_CLI_VERSION_TIMEOUT"
  | "LARK_CLI_TIMEOUT"
  | "LARK_CLI_OUTPUT_LIMIT"
  | "LARK_CLI_FAILED"
  | "LARK_CLI_DIRTY_OUTPUT"
  | "LARK_CLI_VERSION_UNSUPPORTED";

export type LarkCliRunResult =
  | {
      ok: true;
      stdout: string;
      stderr: string;
      cliVersion: string | null;
      source: "bundle" | "shim" | "path";
      [LARK_DEVICE_CODE]?: string;
    }
  | {
      ok: false;
      reasonCode: LarkCliReasonCode;
      message: string;
      cliVersion: string | null;
      source: "bundle" | "shim" | "path" | null;
    };

export interface LarkCliBackgroundRun {
  initial: Promise<LarkCliRunResult>;
  completion: Promise<LarkCliRunResult>;
}

interface ExecResult {
  stdout: string;
  stderr: string;
}

type ExecFile = (
  file: string,
  args: readonly string[],
  options: {
    timeout: number;
    maxBuffer: number;
    windowsHide: boolean;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
  },
) => Promise<ExecResult>;

export interface LarkCliRunnerOptions {
  execFile?: ExecFile;
  shimPath?: string;
  timeoutMs?: number;
  configInitUrlTimeoutMs?: number;
  maxOutputBytes?: number;
  platform?: NodeJS.Platform;
  bundledRunJsPath?: string;
  nodePath?: string;
  nodeOptions?: string;
  electronAsNode?: boolean;
  exists?: (path: string) => boolean;
}

export function hasLarkConfigInitUrl(
  output: string,
  options: { requireTerminator?: boolean } = {},
): boolean {
  return extractLarkConfigInitUrl(output, options) !== null;
}

interface LarkCliInvocation {
  file: string;
  argsPrefix: string[];
  source: "bundle" | "shim" | "path";
  env?: NodeJS.ProcessEnv;
}

const ALLOWED_COMMANDS = new Set([
  "config\0show",
  "auth\0status\0--json",
  "auth\0logout",
  "config\0init\0--new\0--brand\0feishu\0--lang\0zh",
]);

function isAllowedCommand(command: LarkCliCommand): boolean {
  if (ALLOWED_COMMANDS.has(command.join("\0"))) return true;
  if (command.length === 6 && command[0] === "auth" && command[1] === "login" &&
      command[2] === "--domain" && command[3].split(",").length > 0 &&
      command[3].split(",").every((domain) => (LARK_AUTH_DOMAINS as readonly string[]).includes(domain)) &&
      command[4] === "--no-wait" && command[5] === "--json") return true;
  return command.length === 4 && command[0] === "auth" && command[1] === "login" &&
    command[2] === "--device-code" && typeof command[3] === "string" &&
    !command[3].startsWith("-") && /^[A-Za-z0-9._~-]{6,512}$/.test(command[3]);
}

function defaultExecFile(
  file: string,
  args: readonly string[],
  options: {
    timeout: number;
    maxBuffer: number;
    windowsHide: boolean;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
  },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFileCallback(file, [...args], { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, { stdout, stderr });
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/** 仅脱敏凭证类字段；状态/域信息保留给 parser，runner 从不记录原始输出。 */
export function redactLarkCliOutput(value: string): string {
  return value
    .replace(
      /(["']?(?:appSecret|app_secret|clientSecret|client_secret|accessToken|access_token|refreshToken|refresh_token|deviceCode|device_code|token|secret)["']?\s*[:=]\s*["']?)([^\s,"'}]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/(Bearer\s+)[^\s,"'}]+/gi, "$1[REDACTED]")
    .slice(0, LARK_CLI_MAX_OUTPUT_BYTES);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function errorKilled(error: unknown): boolean {
  return typeof error === "object" && error !== null && "killed" in error
    ? (error as { killed?: unknown }).killed === true
    : false;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactLarkCliOutput(message).replace(/\s+/g, " ").slice(0, 240);
}

function isSpawnErrorCode(code: string | undefined): boolean {
  return code === "EACCES" || code === "EINVAL" || code === "ENOEXEC" || code === "EPERM";
}

export function resolveLarkCliInvocation(options: {
  platform?: NodeJS.Platform;
  shimPath: string;
  bundledRunJsPath?: string;
  nodePath?: string;
  nodeOptions?: string;
  electronAsNode?: boolean;
  exists?: (path: string) => boolean;
}): LarkCliInvocation {
  const platform = options.platform ?? process.platform;
  const pathExists = options.exists ?? existsSync;
  // Windows 的 Node 20+ 不允许 execFile 直接启动 .cmd/.bat。打包桌面端因此绕过
  // PATH shim，以 Electron-as-Node + 随包 run.js 的固定 argv 直接启动官方 Node CLI。
  if (
    platform === "win32" &&
    options.bundledRunJsPath &&
    options.nodePath &&
    pathExists(options.bundledRunJsPath) &&
    pathExists(options.nodePath)
  ) {
    return {
      file: options.nodePath,
      argsPrefix: [options.bundledRunJsPath],
      source: "bundle",
      env: {
        ...process.env,
        ...(options.electronAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        ...(options.nodeOptions ? { NODE_OPTIONS: options.nodeOptions } : {}),
      },
    };
  }
  if (pathExists(options.shimPath)) {
    return { file: options.shimPath, argsPrefix: [], source: "shim" };
  }
  return { file: "lark-cli", argsPrefix: [], source: "path" };
}

export class LarkCliRunner {
  private readonly execFile: ExecFile;
  private readonly timeoutMs: number;
  private readonly configInitUrlTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly invocation: LarkCliInvocation;
  /** 成功验证后在 runner 生命周期内复用；失败不缓存，让冷启动超时可在下次检查自愈。 */
  private verifiedCliVersion: string | null = null;

  constructor(options: LarkCliRunnerOptions = {}) {
    this.execFile = options.execFile ?? defaultExecFile;
    const platform = options.platform ?? process.platform;
    const shimPath = options.shimPath ?? join(SANDBOX_BIN_DIR, platform === "win32" ? "lark-cli.cmd" : "lark-cli");
    this.invocation = resolveLarkCliInvocation({
      platform,
      shimPath,
      bundledRunJsPath: options.bundledRunJsPath ?? process.env.QINGAGENT_LARK_CLI_RUN_JS,
      nodePath: options.nodePath ?? process.env.QINGAGENT_LARK_CLI_NODE_PATH,
      nodeOptions: options.nodeOptions ?? process.env.QINGAGENT_LARK_CLI_NODE_OPTIONS,
      electronAsNode: options.electronAsNode ??
        process.env.QINGAGENT_LARK_CLI_ELECTRON_AS_NODE === "1",
      exists: options.exists,
    });
    this.timeoutMs = options.timeoutMs ?? LARK_CLI_TIMEOUT_MS;
    this.configInitUrlTimeoutMs =
      options.configInitUrlTimeoutMs ?? LARK_CLI_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? LARK_CLI_MAX_OUTPUT_BYTES;
  }

  async run(command: LarkCliCommand, runOptions: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<LarkCliRunResult> {
    if (!isAllowedCommand(command)) {
      throw new Error("lark-cli 命令不在固定白名单");
    }

    const { file: executable, argsPrefix, source, env } = this.invocation;
    let cliVersion: string | null = this.verifiedCliVersion;
    let probingVersion = cliVersion === null;
    try {
      if (cliVersion === null) {
        const versionResult = await this.execFile(executable, [...argsPrefix, "--version"], this.options({}, env));
        cliVersion = parseLarkCliVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
        if (!cliVersion || !/^1\.0\./.test(cliVersion)) {
          return {
            ok: false,
            reasonCode: "LARK_CLI_VERSION_UNSUPPORTED",
            message: "lark-cli 版本无法确认或暂未验证",
            cliVersion,
            source,
          };
        }
        this.verifiedCliVersion = cliVersion;
      }
      probingVersion = false;
      const result = await this.execFile(executable, [...argsPrefix, ...command], this.options(runOptions, env));
      const deviceCode = command[0] === "auth" && command[1] === "login" && command.includes("--no-wait")
        ? extractDeviceCode(result.stdout)
        : null;
      return {
        ok: true,
        stdout: redactLarkCliOutput(result.stdout),
        stderr: redactLarkCliOutput(result.stderr),
        // PATH 兜底必须公开版本；shim 也保留版本便于诊断，但绝不公开路径。
        cliVersion,
        source,
        ...(deviceCode ? { [LARK_DEVICE_CODE]: deviceCode } : {}),
      };
    } catch (error) {
      const code = errorCode(error);
      const reasonCode: LarkCliReasonCode =
        code === "ENOENT"
          ? "LARK_CLI_MISSING"
          : errorKilled(error) || code === "ETIMEDOUT" || code === "ABORT_ERR"
            ? probingVersion ? "LARK_CLI_VERSION_TIMEOUT" : "LARK_CLI_TIMEOUT"
            : code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
              ? "LARK_CLI_OUTPUT_LIMIT"
              : isSpawnErrorCode(code)
                ? "LARK_CLI_SPAWN_FAILED"
              : "LARK_CLI_FAILED";
      return {
        ok: false,
        reasonCode,
        message: safeErrorMessage(error),
        cliVersion,
        source,
      };
    }
  }

  /** config init 专用后台进程：首段 stdout 用于立即出创建卡，completion 负责生命周期收尾。 */
  async startConfigInit(signal: AbortSignal): Promise<LarkCliBackgroundRun> {
    const command = ["config", "init", "--new", "--brand", "feishu", "--lang", "zh"] as const;
    const { file: executable, argsPrefix, source, env } = this.invocation;
    let cliVersion: string | null = this.verifiedCliVersion;
    try {
      if (cliVersion === null) {
        const versionResult = await this.execFile(
          executable,
          [...argsPrefix, "--version"],
          this.options({ signal }, env),
        );
        cliVersion = parseLarkCliVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
        if (!cliVersion || !/^1\.0\./.test(cliVersion)) {
          const failed: LarkCliRunResult = { ok: false, reasonCode: "LARK_CLI_VERSION_UNSUPPORTED", message: "lark-cli 版本无法确认或暂未验证", cliVersion, source };
          return { initial: Promise.resolve(failed), completion: Promise.resolve(failed) };
        }
        this.verifiedCliVersion = cliVersion;
      }
    } catch (error) {
      const failed = this.failure(error, cliVersion, source, true);
      return { initial: Promise.resolve(failed), completion: Promise.resolve(failed) };
    }

    let resolveInitial!: (result: LarkCliRunResult) => void;
    let initialSettled = false;
    const initial = new Promise<LarkCliRunResult>((resolve) => { resolveInitial = resolve; });
    const completion = new Promise<LarkCliRunResult>((resolve) => {
      const child = spawnChild(executable, [...argsPrefix, ...command], {
        windowsHide: true,
        signal,
        stdio: ["ignore", "pipe", "pipe"],
        ...(env ? { env } : {}),
      });
      let stdout = "";
      let stderr = "";
      let overflow = false;
      let completionSettled = false;
      const settleCompletion = (result: LarkCliRunResult): void => {
        if (completionSettled) return;
        completionSettled = true;
        clearTimeout(initialUrlTimeout);
        if (!initialSettled) {
          initialSettled = true;
          resolveInitial(result);
        }
        resolve(result);
      };
      const initialUrlTimeout = setTimeout(() => {
        const failed: LarkCliRunResult = {
          ok: false,
          reasonCode: "LARK_CLI_TIMEOUT",
          message: "lark-cli 未及时返回创建应用链接",
          cliVersion,
          source,
        };
        child.kill();
        settleCompletion(failed);
      }, this.configInitUrlTimeoutMs);
      initialUrlTimeout.unref?.();
      const append = (current: string, chunk: Buffer): string => {
        const next = current + chunk.toString("utf8");
        if (Buffer.byteLength(next) > this.maxOutputBytes) { overflow = true; child.kill(); }
        return next.slice(0, this.maxOutputBytes);
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdout = append(stdout, chunk);
        if (
          !initialSettled &&
          hasLarkConfigInitUrl(stdout, { requireTerminator: true })
        ) {
          initialSettled = true;
          clearTimeout(initialUrlTimeout);
          resolveInitial({ ok: true, stdout: redactLarkCliOutput(stdout), stderr: redactLarkCliOutput(stderr), cliVersion, source });
        }
      });
      child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
      child.on("error", (error) => {
        const failed = this.failure(error, cliVersion, source);
        settleCompletion(failed);
      });
      child.on("close", (code) => {
        const result: LarkCliRunResult = overflow
          ? { ok: false, reasonCode: "LARK_CLI_OUTPUT_LIMIT", message: "lark-cli 输出超过限制", cliVersion, source }
          : code === 0
            ? { ok: true, stdout: redactLarkCliOutput(stdout), stderr: redactLarkCliOutput(stderr), cliVersion, source }
            : { ok: false, reasonCode: signal.aborted ? "LARK_CLI_TIMEOUT" : "LARK_CLI_FAILED", message: signal.aborted ? "lark-cli 已中止" : `lark-cli 退出码 ${code}`, cliVersion, source };
        settleCompletion(result);
      });
    });
    return { initial, completion };
  }

  private failure(
    error: unknown,
    cliVersion: string | null,
    source: "bundle" | "shim" | "path",
    probingVersion = false,
  ): LarkCliRunResult {
    const code = errorCode(error);
    return {
      ok: false, reasonCode: code === "ENOENT"
        ? "LARK_CLI_MISSING"
        : errorKilled(error) || code === "ETIMEDOUT" || code === "ABORT_ERR"
          ? probingVersion ? "LARK_CLI_VERSION_TIMEOUT" : "LARK_CLI_TIMEOUT"
          : code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
            ? "LARK_CLI_OUTPUT_LIMIT"
            : isSpawnErrorCode(code)
              ? "LARK_CLI_SPAWN_FAILED"
              : "LARK_CLI_FAILED",
      message: safeErrorMessage(error), cliVersion, source,
    };
  }

  private options(
    runOptions: { signal?: AbortSignal; timeoutMs?: number } = {},
    env?: NodeJS.ProcessEnv,
  ) {
    return {
      timeout: runOptions.timeoutMs ?? this.timeoutMs,
      maxBuffer: this.maxOutputBytes,
      windowsHide: true,
      ...(runOptions.signal ? { signal: runOptions.signal } : {}),
      ...(env ? { env } : {}),
    };
  }
}

function extractDeviceCode(output: string): string | null {
  const match = output.match(/["']device_code["']\s*:\s*["']([^"']+)["']/i) ??
    output.match(/["']deviceCode["']\s*:\s*["']([^"']+)["']/i);
  return match?.[1]?.trim() || null;
}

export function parseLarkCliVersion(output: string): string | null {
  return output.match(/(?:lark-cli\s+)?version\s+([0-9]+(?:\.[0-9]+){1,3})/i)?.[1] ?? null;
}
