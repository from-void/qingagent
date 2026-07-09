import { execFileSync } from "node:child_process";

const commands = [
  ["pnpm", ["--filter", "@qingagent/web", "exec", "vitest", "run", "src/pages/workspace/__tests__/workspaceCssContract.test.ts"]],
];

for (const [command, args] of commands) {
  execFileSync(command, args, { stdio: "inherit" });
}
