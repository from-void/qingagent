import { execFileSync } from "node:child_process";

const commands = [
  ["pnpm", ["--filter", "@qingagent/web", "test", "--", "workspaceCssContract"]],
  ["git", ["diff", "--exit-code", "--", "apps/web/src/pages/workspace/workspace.css"]],
];

for (const [command, args] of commands) {
  execFileSync(command, args, { stdio: "inherit" });
}
