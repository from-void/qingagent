import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile, chmod } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ExternalInstanceInfo {
  port: number;
  pid: number;
  version: string;
  token: string;
  startedAt: string;
}

let current: ExternalInstanceInfo | null = null;
let hooksInstalled = false;

export function externalInstancePath(home = os.homedir()): string {
  return path.join(home, ".qingagent", "instance.json");
}

export function getExternalToken(): string | null {
  return current?.token ?? null;
}

export function getExternalInstancePublicInfo(): Omit<ExternalInstanceInfo, "token"> | null {
  if (!current) return null;
  const { token: _token, ...publicInfo } = current;
  return publicInfo;
}

export async function readExternalInstanceFile(filePath = externalInstancePath()): Promise<ExternalInstanceInfo> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as ExternalInstanceInfo;
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

export async function startExternalInstance(opts: {
  port: number;
  version?: string;
  filePath?: string;
}): Promise<ExternalInstanceInfo> {
  const version = opts.version ?? await readPackageVersion();
  const filePath = opts.filePath ?? externalInstancePath();
  const info: ExternalInstanceInfo = {
    port: opts.port,
    pid: process.pid,
    version,
    token: randomBytes(32).toString("hex"),
    startedAt: new Date().toISOString(),
  };
  await writeInstanceFile(filePath, info);
  current = info;
  installCleanupHooks(filePath);
  return info;
}

export async function stopExternalInstance(filePath = externalInstancePath()): Promise<void> {
  current = null;
  await rm(filePath, { force: true }).catch(() => undefined);
}

async function writeInstanceFile(filePath: string, info: ExternalInstanceInfo): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => undefined);
  await rename(tmp, filePath);
  await chmod(filePath, 0o600).catch(() => undefined);
}

function installCleanupHooks(filePath: string): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.once("exit", () => {
    if (existsSync(filePath)) {
      try {
        rmSync(filePath, { force: true });
      } catch {
        // exit 钩子内只能尽力清理。
      }
    }
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void stopExternalInstance(filePath).finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
    });
  }
}

async function readPackageVersion(): Promise<string> {
  try {
    const raw = await readFile(new URL("../../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
