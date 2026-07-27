import {
  chmodSync,
  copyFileSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}

export function readPrivateStringMap(file: string): Record<string, string> {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return {};
    throw error;
  }

  const parsed = JSON.parse(source) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("配置文件必须是 JSON 对象");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.some(([, value]) => typeof value !== "string")) {
    throw new Error("配置文件只能包含字符串值");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function unlinkIfPresent(file: string): void {
  try {
    unlinkSync(file);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
}

export function writePrivateStringMap(
  file: string,
  value: Record<string, string>,
): void {
  const tmp = `${file}.${process.pid}.tmp`;
  const backup = `${file}.bak`;
  const backupTmp = `${backup}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "w",
    });
    try {
      copyFileSync(file, backupTmp);
      chmodSync(backupTmp, 0o600);
      renameSync(backupTmp, backup);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      unlinkIfPresent(backupTmp);
    }
    renameSync(tmp, file);
    chmodSync(file, 0o600);
  } catch (error) {
    try {
      unlinkIfPresent(tmp);
      unlinkIfPresent(backupTmp);
    } catch {
      // 保留原始写入错误。
    }
    throw error;
  }
}
