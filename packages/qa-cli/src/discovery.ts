import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { QaCliError } from "./errors.js";

export interface InstanceInfo {
  port: number;
  pid: number;
  version: string;
  token: string;
  startedAt: string;
}

export function instanceFilePath(home = os.homedir()): string {
  return path.join(home, ".qingagent", "instance.json");
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function discoverInstance(filePath = instanceFilePath()): Promise<InstanceInfo> {
  let info: InstanceInfo;
  try {
    info = JSON.parse(await readFile(filePath, "utf8")) as InstanceInfo;
  } catch {
    throw new QaCliError("NO_INSTANCE", "请先打开青简应用");
  }
  if (!isPidAlive(info.pid)) throw new QaCliError("NO_INSTANCE", "请先打开青简应用");
  const res = await fetch(`http://127.0.0.1:${info.port}/api/v1/external/health`, {
    headers: { Authorization: `Bearer ${info.token}` },
  }).catch(() => null);
  if (!res) throw new QaCliError("NO_INSTANCE", "请先打开青简应用");
  if (res.status === 401) throw new QaCliError("AUTH_FAILED", "实例可能已重启");
  if (!res.ok) throw new QaCliError("NO_INSTANCE", "请先打开青简应用");
  return info;
}
