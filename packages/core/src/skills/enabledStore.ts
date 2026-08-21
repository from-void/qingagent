import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { userSkillsDir } from "./paths.js";

// 禁用状态必须留在用户技能目录内；路径调用时求值，避免运行时 env 注入前被焊死。
function disabledFile(): string {
  return join(userSkillsDir(), ".disabled.json");
}

function normalizeName(name: string): string {
  return name.trim();
}

class AllSkillsDisabledSet extends Set<string> {
  override has(_name: string): boolean {
    return true;
  }
}

let lastValidDisabledSet: { path: string; value: Set<string> } | null = null;

function cloneAndCacheDisabledSet(path: string, disabled: Set<string>): Set<string> {
  lastValidDisabledSet = { path, value: new Set(disabled) };
  return new Set(disabled);
}

function isMissingDisabledFile(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function logReadFallback(error: unknown, usingCache: boolean): void {
  console.warn("[skills] Failed to read disabled skill state; using safe fallback", {
    usingCache,
    error: error instanceof Error ? error.message : String(error),
  });
}

export async function readDisabledSet(): Promise<Set<string>> {
  const path = disabledFile();
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.some((item) => typeof item !== "string")
    ) {
      throw new Error("disabled skill state must be a string array");
    }
    return cloneAndCacheDisabledSet(path, new Set(
      parsed
        .map(normalizeName)
        .filter(Boolean),
    ));
  } catch (error) {
    if (isMissingDisabledFile(error)) {
      return cloneAndCacheDisabledSet(path, new Set());
    }
    if (lastValidDisabledSet?.path === path) {
      logReadFallback(error, true);
      return new Set(lastValidDisabledSet.value);
    }
    logReadFallback(error, false);
    return new AllSkillsDisabledSet();
  }
}

export async function writeDisabledSet(set: Set<string>): Promise<void> {
  const path = disabledFile();
  try {
    await mkdir(dirname(path), { recursive: true });
    const names = Array.from(set).map(normalizeName).filter(Boolean).sort();
    // Atomic-ish write: write to a temp file in the same directory, then
    // rename over the target so readers never observe a truncated file
    // (a partial write would parse-fail and silently re-enable everything).
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(names, null, 2)}\n`, "utf8");
    await rename(tmp, path);
    lastValidDisabledSet = { path, value: new Set(names) };
  } catch {
    // Enable/disable state must not make agent startup or turns fail.
  }
}

export async function isDisabled(name: string): Promise<boolean> {
  const disabled = await readDisabledSet();
  return disabled.has(normalizeName(name));
}

// Serialize read-modify-write cycles in-process so concurrent toggles do not
// clobber each other (last-writer-wins on a stale snapshot).
let writeChain: Promise<void> = Promise.resolve();

export async function setEnabled(name: string, enabled: boolean): Promise<void> {
  const normalized = normalizeName(name);
  if (!normalized) return;
  const run = writeChain.then(async () => {
    const disabled = await readDisabledSet();
    if (disabled instanceof AllSkillsDisabledSet) {
      console.warn("[skills] Refusing to change skill state without a readable baseline");
      return;
    }
    if (enabled) disabled.delete(normalized);
    else disabled.add(normalized);
    await writeDisabledSet(disabled);
  });
  // Keep the chain alive even if this link rejects (writeDisabledSet already
  // swallows IO errors, but guard against unexpected throws in readDisabledSet).
  writeChain = run.catch(() => undefined);
  await run;
}
