import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const commands = [
  ["pnpm", ["--filter", "@qingagent/web", "exec", "vitest", "run", "src/pages/workspace/__tests__/workspaceCssContract.test.ts"]],
];

for (const [command, args] of commands) {
  execFileSync(command, args, { cwd: repoRoot, stdio: "inherit" });
}

console.log("pm:css:check PASS");
