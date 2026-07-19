import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dependencyCruiserCli = join(
  repoRoot,
  "node_modules/dependency-cruiser/bin/dependency-cruise.mjs",
);

test("页面 data 层依赖同页 components 时命中依赖守卫", async () => {
  const fixtureRoot = join(
    repoRoot,
    "apps/web/src/pages",
    `__depcruise_guard_${process.pid}_${Date.now()}`,
  );
  const dataDir = join(fixtureRoot, "data");
  const componentsDir = join(fixtureRoot, "components");
  const entryPath = join(dataDir, "entry.ts");
  const reportPath = join(fixtureRoot, "violations.txt");

  try {
    await mkdir(dataDir, { recursive: true });
    await mkdir(componentsDir, { recursive: true });
    await writeFile(join(componentsDir, "Bad.ts"), "export const bad = true;\n");
    await writeFile(entryPath, 'import { bad } from "../components/Bad";\nexport { bad };\n');

    const result = await new Promise((resolve) => {
      execFile(
        process.execPath,
        [
          dependencyCruiserCli,
          relative(repoRoot, entryPath),
          "--config",
          join(repoRoot, ".dependency-cruiser.cjs"),
          "--output-to",
          reportPath,
        ],
        { cwd: repoRoot, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
        (error, stdout, stderr) => resolve({ error, stdout, stderr }),
      );
    });
    const report = await readFile(reportPath, "utf8");
    const output = `${report}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`;

    assert.ok(result.error, output);
    assert.notEqual(result.error.code, 0, output);
    assert.match(output, /web-page-data-no-components/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
