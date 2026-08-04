import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const files = [
  "apps/web/src/pages/workspace/components/DocToolbar.tsx",
  "apps/web/src/pages/workspace/components/DocumentSnapshotView.tsx",
  "apps/web/src/pages/workspace/data/insertUploadedAsset.ts",
  "apps/web/src/pages/workspace/data/uploadAsset.ts",
];

const forbidden = [
  "URL.createObjectURL",
  "blob:",
];

let failed = false;
for (const file of files) {
  const text = readFileSync(path.join(repoRoot, file), "utf8");
  for (const term of forbidden) {
    if (text.includes(term)) {
      console.error(`${file}: forbidden image/file insertion term "${term}"`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log("pm:image:check PASS");
