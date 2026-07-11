import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SANDBOX_BIN_DIR } from "../workspace/sandboxPaths.js";

export const LARK_CLI_TIMEOUT_MS = 8_000;
export const LARK_CLI_MAX_OUTPUT_BYTES = 128 * 1024;

export type LarkCliCommand =
  | readonly ["config", "show"]
  | readonly ["auth", "status", "--json"]
  | readonly ["auth", "logout"];

export type LarkCliReasonCode =
  | "LARK_CLI_MISSING"
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
      source: "shim" | "path";
    }
  | {
      ok: false;
      reasonCode: LarkCliReasonCode;
      message: string;
      cliVersion: string | null;
      source: "shim" | "path" | null;
    };

interface ExecResult {
  stdout: string;
  stderr: string;
}

type ExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; windowsHide: boolean },
) => Promise<ExecResult>;

export interface LarkCliRunnerOptions {
  execFile?: ExecFile;
  shimPath?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

const ALLOWED_COMMANDS = new Set([
  "config\0show",
  "auth\0status\0--json",
  "auth\0logout",
]);

function defaultExecFile(
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; windowsHide: boolean },
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
      /(["']?(?:appSecret|app_secret|clientSecret|client_secret|accessToken|access_token|refreshToken|refresh_token|token|secret)["']?\s*[:=]\s*["']?)([^\s,"'}]+)/gi,
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

export class LarkCliRunner {
  private readonly execFile: ExecFile;
  private readonly shimPath: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(options: LarkCliRunnerOptions = {}) {
    this.execFile = options.execFile ?? defaultExecFile;
    this.shimPath = options.shimPath ?? join(SANDBOX_BIN_DIR, process.platform === "win32" ? "lark-cli.cmd" : "lark-cli");
    this.timeoutMs = options.timeoutMs ?? LARK_CLI_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? LARK_CLI_MAX_OUTPUT_BYTES;
  }

  async run(command: LarkCliCommand): Promise<LarkCliRunResult> {
    if (!ALLOWED_COMMANDS.has(command.join("\0"))) {
      throw new Error("lark-cli 命令不在固定白名单");
    }

    const source = existsSync(this.shimPath) ? "shim" as const : "path" as const;
    const executable = source === "shim" ? this.shimPath : "lark-cli";
    let cliVersion: string | null = null;
    try {
      const versionResult = await this.execFile(executable, ["--version"], this.options());
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
      const result = await this.execFile(executable, command, this.options());
      return {
        ok: true,
        stdout: redactLarkCliOutput(result.stdout),
        stderr: redactLarkCliOutput(result.stderr),
        // PATH 兜底必须公开版本；shim 也保留版本便于诊断，但绝不公开路径。
        cliVersion,
        source,
      };
    } catch (error) {
      const code = errorCode(error);
      const reasonCode: LarkCliReasonCode =
        code === "ENOENT"
          ? "LARK_CLI_MISSING"
          : errorKilled(error) || code === "ETIMEDOUT"
            ? "LARK_CLI_TIMEOUT"
            : code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
              ? "LARK_CLI_OUTPUT_LIMIT"
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

  private options() {
    return {
      timeout: this.timeoutMs,
      maxBuffer: this.maxOutputBytes,
      windowsHide: true,
    };
  }
}

export function parseLarkCliVersion(output: string): string | null {
  return output.match(/(?:lark-cli\s+)?version\s+([0-9]+(?:\.[0-9]+){1,3})/i)?.[1] ?? null;
}
