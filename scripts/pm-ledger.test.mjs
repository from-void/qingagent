import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { scanTerms } from "./pm-ledger.mjs";

test("旧标识符只匹配完整标识符，不误报现行复合名称", async () => {
  const root = await makeFixtureRoot();
  try {
    await writeFile(
      path.join(root, "apps", "sample.ts"),
      [
        "type DocVersion = number;",
        "const expectedDocVersion = 1;",
        "const wholeDocVersion = expectedDocVersion;",
        "const buildDocVersionAwarenessContent = () => wholeDocVersion;",
      ].join("\n"),
    );

    const results = scanTerms({ root, terms: ["DocVersion"] });

    assert.deepEqual(results, [
      {
        path: "apps/sample.ts",
        group: "runtime",
        phase: "待收敛 Phase A-F",
        matches: [{ term: "DocVersion", count: 1 }],
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("代码片段规则继续按字面匹配", async () => {
  const root = await makeFixtureRoot();
  try {
    await writeFile(
      path.join(root, "packages", "sample.ts"),
      "const next = text.replace(before, after);\n",
    );

    const results = scanTerms({ root, terms: ["text.replace(before"] });

    assert.equal(results.length, 1);
    assert.deepEqual(results[0].matches, [{ term: "text.replace(before", count: 1 }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function makeFixtureRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "qingagent-pm-ledger-"));
  await Promise.all([
    mkdir(path.join(root, "apps"), { recursive: true }),
    mkdir(path.join(root, "packages"), { recursive: true }),
  ]);
  return root;
}
