export type LarkCliCommandPathResult =
  | { ok: true; commandPath: string[] }
  | { ok: false; commandPath: string[]; reason: string };

// 只有确认会吞掉下一个 argv 的全局 flag 才能进入此表；误收 boolean flag 会重新打开绕过。
const LARK_GLOBAL_FLAGS_WITH_VALUE = new Set(["--profile"]);
const LARK_GLOBAL_BOOLEAN_FLAGS = new Set([
  "-h",
  "--help",
  "-v",
  "--version",
  "--json",
  "--verbose",
]);
const LARK_ROOT_ONLY_COMMANDS = new Set([
  "doctor",
  "update",
  "upgrade",
  "version",
  "whoami",
]);
const LARK_FIXED_TWO_PART_COMMANDS = new Set([
  "auth",
  "completion",
  "config",
  "help",
  "profile",
  "schema",
  "skills",
]);
const LARK_ACTIONS = new Set([
  "agenda",
  "append",
  "consume",
  "create",
  "delete",
  "detail",
  "download",
  "export",
  "fetch",
  "forward",
  "get",
  "history",
  "import",
  "inspect",
  "list",
  "publish",
  "query",
  "read",
  "reply",
  "search",
  "send",
  "show",
  "status",
  "transcript",
  "update",
  "upload",
  "watch",
]);

function shouldConsumePathToken(commandPath: string[], nextArg: string): boolean {
  if (commandPath.length === 0) return true;
  const root = commandPath[0]!;
  if (commandPath.length === 1) return !LARK_ROOT_ONLY_COMMANDS.has(root);
  if (LARK_FIXED_TWO_PART_COMMANDS.has(root) || root === "api") return false;
  if (commandPath.length >= 3) return false;

  const action = commandPath[1]!;
  if (action.startsWith("+") || LARK_ACTIONS.has(action)) {
    const lowerNext = nextArg.toLowerCase();
    // 兼容已有的 `docs +get +delete` 对抗路径；普通位置参数不再继续当子命令扫描。
    return lowerNext.startsWith("+");
  }
  // typed command 固定为 domain/resource/method 三段。
  return true;
}

/**
 * 提取 lark-cli 的真实子命令路径。
 *
 * 已知 boolean/带值全局 flag 与任意 `--flag=value` 可确定性跳过；未知的分离值
 * flag 无法判断下一项是 flag value 还是子命令，必须把歧义交给调用方 fail-closed。
 */
export function parseLarkCliCommandPath(args: string[]): LarkCliCommandPathResult {
  const commandPath: string[] = [];
  let optionsEnded = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!shouldConsumePathToken(commandPath, arg)) break;

    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith("-") && arg !== "-") {
      const lower = arg.toLowerCase();
      if (lower.startsWith("--") && lower.includes("=")) continue;
      if (LARK_GLOBAL_BOOLEAN_FLAGS.has(lower)) continue;
      if (LARK_GLOBAL_FLAGS_WITH_VALUE.has(lower)) {
        const value = args[index + 1];
        if (value === undefined || (value.startsWith("-") && value !== "-")) {
          return {
            ok: false,
            commandPath,
            reason: `lark-cli 全局参数 ${arg} 缺少可确定的值`,
          };
        }
        index += 1;
        continue;
      }
      return {
        ok: false,
        commandPath,
        reason: `无法确定 lark-cli 未知全局参数 ${arg} 是否带值`,
      };
    }

    commandPath.push(arg.toLowerCase());
  }

  return { ok: true, commandPath };
}
