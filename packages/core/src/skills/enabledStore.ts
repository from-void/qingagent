import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { USER_SKILLS_DIR } from "./paths.js";

// Keep the disabled-set file inside the user skills directory so it always
// lives in a writable, user-owned location regardless of how USER_SKILLS_DIR
// is configured (the previous "../disabled.json" form could escape to e.g.
// "/disabled.json" when QINGAGENT_USER_SKILLS_DIR pointed at a root-level dir).
const DISABLED_FILE = join(USER_SKILLS_DIR, ".disabled.json");

function normalizeName(name: string): string {
  return name.trim();
}

export async function readDisabledSet(): Promise<Set<string>> {
  try {
    const raw = await readFile(DISABLED_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed
        .filter((item): item is string => typeof item === "string")
        .map(normalizeName)
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

export async function writeDisabledSet(set: Set<string>): Promise<void> {
  try {
    await mkdir(dirname(DISABLED_FILE), { recursive: true });
    const names = Array.from(set).map(normalizeName).filter(Boolean).sort();
    // Atomic-ish write: write to a temp file in the same directory, then
    // rename over the target so readers never observe a truncated file
    // (a partial write would parse-fail and silently re-enable everything).
    const tmp = `${DISABLED_FILE}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(names, null, 2)}\n`, "utf8");
    await rename(tmp, DISABLED_FILE);
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
    if (enabled) disabled.delete(normalized);
    else disabled.add(normalized);
    await writeDisabledSet(disabled);
  });
  // Keep the chain alive even if this link rejects (writeDisabledSet already
  // swallows IO errors, but guard against unexpected throws in readDisabledSet).
  writeChain = run.catch(() => undefined);
  await run;
}
