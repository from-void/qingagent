import { execFile } from "node:child_process";

export interface ReadWallProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ReadWallProcessOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  cwd?: string;
}

export type ReadWallProcessRunner = (
  command: string,
  args: string[],
  options?: ReadWallProcessOptions,
) => Promise<ReadWallProcessResult>;

export const runReadWallProcess: ReadWallProcessRunner = async (command, args, options = {}) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs ?? 15_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const exitCode =
          error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
            ? (error as NodeJS.ErrnoException & { code: number }).code
            : error
              ? 1
              : 0;
        resolve({ exitCode, stdout: String(stdout), stderr: String(stderr || error?.message || "") });
      },
    );
  });

export function shellQuoteReadWallPath(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
