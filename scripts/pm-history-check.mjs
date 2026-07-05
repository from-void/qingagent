import { readFileSync } from "node:fs";

const checks = [
  {
    file: "packages/server/src/routes/history.ts",
    forbidden: ["v-101", "首次成稿", "补充指标段落"],
  },
];

let failed = false;
for (const check of checks) {
  const text = readFileSync(check.file, "utf8");
  for (const term of check.forbidden) {
    if (text.includes(term)) {
      console.error(`${check.file}: forbidden history mock term "${term}"`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log("pm:history:check PASS");
