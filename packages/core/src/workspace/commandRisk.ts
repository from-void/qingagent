// 沙箱命令危险度判定 + 用户友好文案生成。
// 最终执行权限由 commandPolicy 的白名单 gate 决定;这里提供风险标签与展示文案。

export type CommandRisk = "safe" | "confirm" | "deny";

export interface RiskVerdict {
  risk: CommandRisk;
  /** 给用户看的人话标题(意图化,如"把文档发布到飞书")。 */
  title: string;
  /** 副说明(影响/提示),可空。 */
  detail?: string;
  /** 危险度图标提示。 */
  icon: string;
  /** deny 时的拒绝原因(给模型)。 */
  denyReason?: string;
}

// shell 元字符:出现即不能当"安全只读"放行(可能链式/重定向/替换)
const SHELL_METACHARS = /[;&|`$><(){}]|\$\(|&&|\|\|/;

// 明确禁止的模式(读凭据/外传/inline 执行/路径穿越)
const DENY_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\bprocess\.env\b|\$\{?[A-Z_]*(TOKEN|SECRET|KEY|PASSWORD)|\b(printenv|env)\b|\b(TOKEN|SECRET|PASSWORD|APP_SECRET)\b/i, reason: "命令试图读取凭据/密钥环境变量" },
  { re: /\b(node|deno|bun)\s+-e\b|\b(bash|sh|zsh)\s+-c\b/, reason: "命令试图执行内联脚本(node -e / bash -c),不允许" },
  // 命令替换 $(...) / 反引号:外传/执行面。但 $((...)) 是算术展开(纯数值,安全),
  // 不能误判——用负向先行排除紧跟第二个左括号的算术形式。
  { re: /\$\((?!\()|`[^`]*`/, reason: "命令含命令替换,不允许" },
  { re: /\.\.\//, reason: "命令含路径穿越(../),不允许" },
  { re: /\b(curl|wget|nc|ncat)\b/, reason: "命令试图发起外部网络传输(curl/wget 等),不允许" },
];

// 平台发布类命令 → 识别成友好意图
interface PlatformOp {
  match: RegExp;
  title: (cmd: string) => string;
  detail?: string;
}
const PLATFORM_OPS: PlatformOp[] = [
  { match: /lark-cli\s+docs\s+\+create/, title: () => "把文档发布到你的飞书", detail: "将创建一篇新的飞书云文档" },
  { match: /lark-cli\s+docs\s+\+update/, title: () => "更新你的飞书文档", detail: "将修改已有的飞书文档内容" },
  { match: /dingtalk\.mjs\s+doc-create/, title: () => "把文档发布到你的钉钉知识库", detail: "将创建一篇新的钉钉文档" },
];

// 文件破坏性操作
const DESTRUCTIVE = [
  { re: /\brm\s|\bdel\s|\bunlink\b/, title: "删除文件", detail: "将删除工作目录里的文件" },
  { re: /\bmv\s|\bmove\s/, title: "移动/重命名文件", detail: "将移动工作目录里的文件" },
];

// 已知安全的只读/计算技能脚本
const SAFE_SKILL_SCRIPTS = /\b(calc\.mjs)\b/;

/** 判定命令危险度并生成友好文案。 */
export function assessCommand(command: string): RiskVerdict {
  const cmd = command.trim();

  // 1) 明确禁止
  for (const { re, reason } of DENY_PATTERNS) {
    if (re.test(cmd)) {
      return { risk: "deny", title: "操作被拒绝", icon: "🚫", denyReason: reason };
    }
  }

  // 2) 平台发布/破坏性 → 确认(带友好文案)
  for (const op of PLATFORM_OPS) {
    if (op.match.test(cmd)) {
      return { risk: "confirm", title: `需要执行：${op.title(cmd)}`, detail: op.detail, icon: "📤" };
    }
  }
  for (const d of DESTRUCTIVE) {
    if (d.re.test(cmd)) {
      return { risk: "confirm", title: `需要执行：${d.title}`, detail: d.detail, icon: "🗑️" };
    }
  }

  // 3) 已知安全:只读计算脚本,且无 shell 元字符 → 放行
  if (SAFE_SKILL_SCRIPTS.test(cmd) && !SHELL_METACHARS.test(cmd)) {
    return { risk: "safe", title: "计算", icon: "🧮" };
  }

  // 4) 其余:有 shell 元字符或未知命令 → 保守确认(通用文案)
  if (SHELL_METACHARS.test(cmd)) {
    return {
      risk: "confirm",
      title: "需要执行一个组合命令",
      detail: "命令包含多步操作，请确认后再执行",
      icon: "⚙️",
    };
  }
  // 普通单命令(如 lark-cli 只读子命令、node 跑技能脚本):默认放行
  return { risk: "safe", title: "执行操作", icon: "⚙️" };
}
