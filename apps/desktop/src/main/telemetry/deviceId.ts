import { app } from "electron";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

let cachedDeviceId: string | null = null;

function isUsableDeviceId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export async function getTelemetryDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;

  const idFile = path.join(app.getPath("userData"), ".qing-telemetry-id");
  try {
    const existing = (await readFile(idFile, "utf8")).trim();
    if (isUsableDeviceId(existing)) {
      cachedDeviceId = existing;
      return cachedDeviceId;
    }
  } catch {
    // 文件不存在或不可读都不影响启动,后面尝试生成新匿名 id。
  }

  const nextId = randomUUID();
  try {
    // 不用 flag:"wx":文件缺失时创建,文件存在但内容损坏(非法 UUID)时**覆盖修复**——
    // 否则坏文件会让每次启动都生成不同 id、设备追踪失效。桌面单实例无并发写竞争。
    await writeFile(idFile, `${nextId}\n`, { encoding: "utf8" });
  } catch {
    // 写入失败时退化为进程内临时 id,绝不阻塞应用启动。
  }

  cachedDeviceId = nextId;
  return cachedDeviceId;
}
