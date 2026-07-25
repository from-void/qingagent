// 沙箱命令的有界静态分析与危险意图分类。
// 这里绝不执行、展开或重写命令；分析结果只用于 policy/确认卡，沙箱始终收到原始 command。

import { basename } from "node:path";

export type CommandRisk = "safe" | "confirm" | "deny";
export type CommandEffect = "install" | "send" | "destructive";
export type CommandConfirmKind = "install" | "send" | "command";

export interface RiskVerdict {
  risk: CommandRisk;
  effects: CommandEffect[];
  confirmKind?: CommandConfirmKind;
  /** 给用户看的人话标题。 */
  title: string;
  /** 副说明(影响/提示),可空。 */
  detail?: string;
  /** 危险度图标提示。 */
  icon: string;
  /** deny 时的拒绝原因(给模型)。 */
  denyReason?: string;
}

export const COMMAND_ANALYSIS_LIMITS = Object.freeze({
  maxLength: 8_192,
  maxCommands: 256,
  maxDepth: 24,
  maxSteps: 8_192 * 32,
});

export interface AnalyzedShellWord {
  /** 去掉 shell 引号、保留变量/替换原文的静态值；从不读取 process.env。 */
  value: string;
  quoted: boolean;
  dynamic: boolean;
}

export interface AnalyzedSimpleCommand {
  /** 去掉前置赋值和常见 wrapper 后的 argv。 */
  argv: string[];
  words: AnalyzedShellWord[];
  originalArgv: string[];
  originalWords: AnalyzedShellWord[];
  envAssignments: string[];
  wrapperUsed: boolean;
  depth: number;
  topLevel: boolean;
  derived: boolean;
  pipelineId?: number;
  pipeFromPrevious: boolean;
  pipeToNext: boolean;
  hasInputRedirect: boolean;
  hasRedirection: boolean;
}

export interface CommandAnalysis {
  commands: AnalyzedSimpleCommand[];
  topLevelCommands: AnalyzedSimpleCommand[];
  hasShellSyntax: boolean;
  hasNestedCommands: boolean;
  error?: string;
}

interface WordToken extends AnalyzedShellWord {
  kind: "word";
}

interface OperatorToken {
  kind: "operator";
  value: string;
}

type LexToken = WordToken | OperatorToken;

interface ScanBudget {
  steps: number;
  commands: number;
  nextPipelineId: number;
}

interface MutableAnalysis {
  commands: AnalyzedSimpleCommand[];
  topLevelCommands: AnalyzedSimpleCommand[];
  hasShellSyntax: boolean;
  hasNestedCommands: boolean;
}

class CommandAnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandAnalysisError";
  }
}

const CONTROL_OPERATORS = [";;&", "&&", "||", "|&", ";;", ";&"] as const;
const REDIRECTION_OPERATORS = ["&>>", "<<<", "<<-", ">>", "<<", ">&", "<&", "<>", ">|", "&>"] as const;
const REDIRECTION_SET = new Set<string>([...REDIRECTION_OPERATORS, ">", "<"]);
const SEPARATOR_SET = new Set([";", ";;", ";&", ";;&", "&&", "||", "|", "|&", "&", "\n", "(", ")", "{", "}"]);
const PIPE_SET = new Set(["|", "|&"]);
const SHELL_COMMANDS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const REMOTE_CODE_SINKS = new Set([
  ...SHELL_COMMANDS,
  "node", "nodejs", "python", "python3", "ruby", "perl", "php", "pwsh", "powershell",
]);
const WRAPPER_COMMANDS = new Set(["env", "sudo", "command", "exec", "nohup", "time"]);
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

function tick(budget: ScanBudget, amount = 1): void {
  budget.steps += amount;
  if (budget.steps > COMMAND_ANALYSIS_LIMITS.maxSteps) {
    throw new CommandAnalysisError("命令解析超过扫描预算");
  }
}

function commandName(value: string): string {
  return basename(value.replaceAll("\\", "/")).toLowerCase();
}

function matchingOperatorAt(source: string, index: number): string | null {
  for (const op of CONTROL_OPERATORS) {
    if (source.startsWith(op, index)) return op;
  }
  for (const op of REDIRECTION_OPERATORS) {
    if (source.startsWith(op, index)) return op;
  }
  const char = source[index];
  return char && ";|&<>()".includes(char) ? char : null;
}

function isStandaloneBrace(source: string, index: number): boolean {
  const char = source[index];
  if (char !== "{" && char !== "}") return false;
  const before = index === 0 ? " " : source[index - 1]!;
  const after = index + 1 >= source.length ? " " : source[index + 1]!;
  return /\s|[;&|()]/.test(before) && /\s|[;&|()]/.test(after);
}

interface BalancedSlice {
  body: string;
  end: number;
}

function extractBalanced(
  source: string,
  openIndex: number,
  open: "(" | "{",
  close: ")" | "}",
  budget: ScanBudget,
): BalancedSlice {
  let depth = 1;
  let quote: "'" | '"' | null = null;
  for (let i = openIndex + 1; i < source.length; i += 1) {
    tick(budget);
    const char = source[i]!;
    if (char === "\\" && quote !== "'") {
      i += 1;
      if (i >= source.length) throw new CommandAnalysisError("命令以未完成的转义结尾");
      tick(budget);
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "`") {
      const nested = extractBackticks(source, i, budget);
      i = nested.end;
      continue;
    }
    if (char === open) {
      depth += 1;
      if (depth > COMMAND_ANALYSIS_LIMITS.maxDepth) {
        throw new CommandAnalysisError("命令嵌套超过深度预算");
      }
      continue;
    }
    if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return { body: source.slice(openIndex + 1, i), end: i };
      }
    }
  }
  throw new CommandAnalysisError(`命令含未闭合的 ${open}${close} 结构`);
}

function extractBackticks(source: string, openIndex: number, budget: ScanBudget): BalancedSlice {
  for (let i = openIndex + 1; i < source.length; i += 1) {
    tick(budget);
    if (source[i] === "\\") {
      i += 1;
      if (i >= source.length) throw new CommandAnalysisError("反引号替换以未完成的转义结尾");
      tick(budget);
      continue;
    }
    if (source[i] === "`") {
      return { body: source.slice(openIndex + 1, i), end: i };
    }
  }
  throw new CommandAnalysisError("命令含未闭合的反引号替换");
}

interface HeredocBody {
  body: string;
  expand: boolean;
}

interface HeredocDeclaration {
  delimiter: string;
  stripTabs: boolean;
  expand: boolean;
}

function heredocDeclarations(
  line: string,
  budget: ScanBudget,
  initialQuote: "'" | '"' | null,
): { declarations: HeredocDeclaration[]; quote: "'" | '"' | null } {
  const declarations: HeredocDeclaration[] = [];
  let quote = initialQuote;
  let tokenStart = true;
  for (let i = 0; i < line.length; i += 1) {
    tick(budget);
    const char = line[i]!;
    if (char === "\\" && quote !== "'") {
      i += 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (/\s/.test(char)) {
      tokenStart = true;
      continue;
    }
    if (char === "#" && tokenStart) break;
    if (char === "'" || char === '"') {
      quote = char;
      tokenStart = false;
      continue;
    }
    if (!line.startsWith("<<", i) || line.startsWith("<<<", i)) {
      tokenStart = ";|&()".includes(char);
      continue;
    }
    let cursor = i + 2;
    let stripTabs = false;
    if (line[cursor] === "-") {
      stripTabs = true;
      cursor += 1;
    }
    while (cursor < line.length && /[ \t]/.test(line[cursor]!)) cursor += 1;
    const delimiterQuote = line[cursor] === "'" || line[cursor] === '"' ? line[cursor] : null;
    if (delimiterQuote) cursor += 1;
    const start = cursor;
    if (delimiterQuote) {
      while (cursor < line.length && line[cursor] !== delimiterQuote) cursor += 1;
      if (cursor >= line.length) throw new CommandAnalysisError("heredoc delimiter 引号未闭合");
    } else {
      while (cursor < line.length && !/[\s;&|()<>]/.test(line[cursor]!)) cursor += 1;
    }
    const delimiter = line.slice(start, cursor);
    if (!delimiter) throw new CommandAnalysisError("heredoc 缺少 delimiter");
    declarations.push({ delimiter, stripTabs, expand: delimiterQuote === null });
    i = cursor;
    tokenStart = false;
  }
  return { declarations, quote };
}

/**
 * heredoc 正文是数据，不应把其中的 `rm` 等字样当命令；仅保留未引用 heredoc 中真实会执行的替换。
 * 返回等长 mask，保持后续位置/换行语义稳定。
 */
function maskHeredocBodies(source: string, budget: ScanBudget): { source: string; bodies: HeredocBody[] } {
  const chars = source.split("");
  const bodies: HeredocBody[] = [];
  const pending: HeredocDeclaration[] = [];
  let headerQuote: "'" | '"' | null = null;
  let lineStart = 0;
  while (lineStart <= source.length) {
    const newline = source.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? source.length : newline;
    const line = source.slice(lineStart, lineEnd).replace(/\r$/, "");
    tick(budget, line.length + 1);
    if (pending.length > 0) {
      const declaration = pending[0]!;
      const comparable = declaration.stripTabs ? line.replace(/^\t+/, "") : line;
      const isTerminator = comparable === declaration.delimiter;
      if (!isTerminator) bodies.push({ body: line, expand: declaration.expand });
      for (let i = lineStart; i < lineEnd; i += 1) chars[i] = " ";
      if (isTerminator) pending.shift();
    } else {
      const declarations = heredocDeclarations(line, budget, headerQuote);
      pending.push(...declarations.declarations);
      headerQuote = declarations.quote;
      if (pending.length > 0) headerQuote = null;
    }
    if (newline < 0) break;
    lineStart = newline + 1;
  }
  if (pending.length > 0) throw new CommandAnalysisError("命令含未闭合的 heredoc");
  return { source: chars.join(""), bodies };
}

function scanNestedExpansions(
  source: string,
  depth: number,
  budget: ScanBudget,
  output: MutableAnalysis,
): void {
  for (let i = 0; i < source.length; i += 1) {
    tick(budget);
    if (source[i] === "\\") {
      i += 1;
      continue;
    }
    if (source[i] === "`") {
      const nested = extractBackticks(source, i, budget);
      output.hasNestedCommands = true;
      parseScript(nested.body, depth + 1, budget, output);
      i = nested.end;
      continue;
    }
    if (source.startsWith("$(", i)) {
      const nested = extractBalanced(source, i + 1, "(", ")", budget);
      if (source[i + 2] === "(") {
        scanNestedExpansions(nested.body, depth + 1, budget, output);
      } else {
        output.hasNestedCommands = true;
        parseScript(nested.body, depth + 1, budget, output);
      }
      i = nested.end;
    }
  }
}

function scanWord(
  source: string,
  start: number,
  depth: number,
  budget: ScanBudget,
  output: MutableAnalysis,
): { token: WordToken; end: number } {
  let value = "";
  let quoted = false;
  let dynamic = false;
  let quote: "'" | '"' | null = null;
  let i = start;
  while (i < source.length) {
    tick(budget);
    const char = source[i]!;
    if (!quote && (/\s/.test(char) || matchingOperatorAt(source, i) || isStandaloneBrace(source, i))) break;
    if (char === "\\" && quote !== "'") {
      if (i + 1 >= source.length) throw new CommandAnalysisError("命令以未完成的转义结尾");
      value += source[i + 1]!;
      i += 2;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
        quoted = true;
        i += 1;
        continue;
      }
      if (quote === '"' && (source.startsWith("$(", i) || char === "`")) {
        dynamic = true;
        if (char === "`") {
          const nested = extractBackticks(source, i, budget);
          value += source.slice(i, nested.end + 1);
          output.hasNestedCommands = true;
          parseScript(nested.body, depth + 1, budget, output);
          i = nested.end + 1;
          continue;
        }
        const nested = extractBalanced(source, i + 1, "(", ")", budget);
        value += source.slice(i, nested.end + 1);
        if (source[i + 2] === "(") {
          scanNestedExpansions(nested.body, depth + 1, budget, output);
        } else {
          output.hasNestedCommands = true;
          parseScript(nested.body, depth + 1, budget, output);
        }
        i = nested.end + 1;
        continue;
      }
      if (quote === '"' && char === "$" && source[i + 1] === "{") {
        const nested = extractBalanced(source, i + 1, "{", "}", budget);
        value += source.slice(i, nested.end + 1);
        dynamic = true;
        scanNestedExpansions(nested.body, depth + 1, budget, output);
        i = nested.end + 1;
        continue;
      }
      if (quote === '"' && char === "$") dynamic = true;
      value += char;
      i += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      quoted = true;
      i += 1;
      continue;
    }
    if (source.startsWith("$(", i)) {
      const nested = extractBalanced(source, i + 1, "(", ")", budget);
      value += source.slice(i, nested.end + 1);
      dynamic = true;
      if (source[i + 2] === "(") {
        scanNestedExpansions(nested.body, depth + 1, budget, output);
      } else {
        output.hasNestedCommands = true;
        parseScript(nested.body, depth + 1, budget, output);
      }
      i = nested.end + 1;
      continue;
    }
    if ((char === "<" || char === ">") && source[i + 1] === "(") {
      const nested = extractBalanced(source, i + 1, "(", ")", budget);
      value += source.slice(i, nested.end + 1);
      dynamic = true;
      output.hasNestedCommands = true;
      parseScript(nested.body, depth + 1, budget, output);
      i = nested.end + 1;
      continue;
    }
    if (char === "`") {
      const nested = extractBackticks(source, i, budget);
      value += source.slice(i, nested.end + 1);
      dynamic = true;
      output.hasNestedCommands = true;
      parseScript(nested.body, depth + 1, budget, output);
      i = nested.end + 1;
      continue;
    }
    if (char === "$" && source[i + 1] === "{") {
      const nested = extractBalanced(source, i + 1, "{", "}", budget);
      value += source.slice(i, nested.end + 1);
      dynamic = true;
      scanNestedExpansions(nested.body, depth + 1, budget, output);
      i = nested.end + 1;
      continue;
    }
    if (char === "$") dynamic = true;
    value += char;
    i += 1;
  }
  if (quote) throw new CommandAnalysisError("命令含未闭合的引号");
  return { token: { kind: "word", value, quoted, dynamic }, end: i };
}

function lexScript(
  source: string,
  depth: number,
  budget: ScanBudget,
  output: MutableAnalysis,
): LexToken[] {
  const tokens: LexToken[] = [];
  let groupDepth = 0;
  for (let i = 0; i < source.length;) {
    tick(budget);
    const char = source[i]!;
    if (char === " " || char === "\t" || char === "\r") {
      i += 1;
      continue;
    }
    if (char === "\n") {
      tokens.push({ kind: "operator", value: "\n" });
      output.hasShellSyntax = true;
      i += 1;
      continue;
    }
    // shell 注释只在 token 起始位置生效；quoted/word 中的 # 是普通数据。
    if (char === "#") {
      const newline = source.indexOf("\n", i);
      i = newline < 0 ? source.length : newline;
      continue;
    }
    const operator = isStandaloneBrace(source, i) ? char : matchingOperatorAt(source, i);
    if (operator) {
      if (operator === "(" || operator === "{") {
        groupDepth += 1;
        if (groupDepth + depth > COMMAND_ANALYSIS_LIMITS.maxDepth) {
          throw new CommandAnalysisError("命令嵌套超过深度预算");
        }
      } else if (operator === ")" || operator === "}") {
        groupDepth -= 1;
        if (groupDepth < 0) throw new CommandAnalysisError("命令含未配对的分组结束符");
      }
      tokens.push({ kind: "operator", value: operator });
      output.hasShellSyntax = true;
      i += operator.length;
      continue;
    }
    const word = scanWord(source, i, depth, budget, output);
    if (word.end === i) throw new CommandAnalysisError("命令无法推进解析");
    tokens.push(word.token);
    i = word.end;
  }
  if (groupDepth !== 0) throw new CommandAnalysisError("命令含未闭合的分组结构");
  return tokens;
}

const WRAPPER_OPTIONS_WITH_VALUE = new Map<string, Set<string>>([
  ["env", new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"])],
  ["sudo", new Set(["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "--close-from"])],
  ["command", new Set(["-p", "-v", "-V"])],
  ["time", new Set(["-f", "--format", "-o", "--output"])],
]);

function unwrapCommand(words: AnalyzedShellWord[]): {
  words: AnalyzedShellWord[];
  envAssignments: string[];
  wrapperUsed: boolean;
} {
  let cursor = 0;
  const envAssignments: string[] = [];
  let wrapperUsed = false;
  while (cursor < words.length && ENV_ASSIGNMENT_RE.test(words[cursor]!.value)) {
    envAssignments.push(words[cursor]!.value);
    cursor += 1;
  }
  while (cursor < words.length) {
    const wrapperIndex = cursor;
    const wrapper = commandName(words[cursor]!.value);
    if (!WRAPPER_COMMANDS.has(wrapper)) break;
    wrapperUsed = true;
    cursor += 1;
    const valueOptions = WRAPPER_OPTIONS_WITH_VALUE.get(wrapper) ?? new Set<string>();
    while (cursor < words.length) {
      const value = words[cursor]!.value;
      if (wrapper === "env" && ENV_ASSIGNMENT_RE.test(value)) {
        envAssignments.push(value);
        cursor += 1;
        continue;
      }
      if (wrapper === "env" && (value === "-S" || value === "--split-string" || value.startsWith("--split-string=") || /^-S.+/.test(value))) {
        // env -S 会把一个静态字符串重新拆成命令；保留 env 本体，后续专门递归分析该字符串。
        return { words: words.slice(wrapperIndex), envAssignments, wrapperUsed: true };
      }
      if (value === "--") {
        cursor += 1;
        break;
      }
      if (!value.startsWith("-") || value === "-") break;
      const flag = value.split("=", 1)[0]!;
      cursor += 1;
      if (!value.includes("=") && valueOptions.has(flag) && cursor < words.length) cursor += 1;
    }
  }
  return { words: words.slice(cursor), envAssignments, wrapperUsed };
}

function makeCommand(
  originalWords: AnalyzedShellWord[],
  properties: Omit<AnalyzedSimpleCommand, "argv" | "words" | "originalArgv" | "originalWords" | "envAssignments" | "wrapperUsed">,
): AnalyzedSimpleCommand | null {
  const unwrapped = unwrapCommand(originalWords);
  if (unwrapped.words.length === 0) return null;
  return {
    ...properties,
    argv: unwrapped.words.map((word) => word.value),
    words: unwrapped.words,
    originalArgv: originalWords.map((word) => word.value),
    originalWords,
    envAssignments: unwrapped.envAssignments,
    wrapperUsed: unwrapped.wrapperUsed,
  };
}

function addCommand(command: AnalyzedSimpleCommand, budget: ScanBudget, output: MutableAnalysis): void {
  budget.commands += 1;
  if (budget.commands > COMMAND_ANALYSIS_LIMITS.maxCommands) {
    throw new CommandAnalysisError("命令段数量超过解析预算");
  }
  output.commands.push(command);
  if (command.topLevel && !command.derived) output.topLevelCommands.push(command);
}

function nestedCommandWords(values: AnalyzedShellWord[]): AnalyzedShellWord[] {
  return values.map((word) => ({ ...word }));
}

function xargsNestedWords(command: AnalyzedSimpleCommand): AnalyzedShellWord[] | null {
  if (commandName(command.argv[0] ?? "") !== "xargs") return null;
  const optionsWithValue = new Set(["-a", "--arg-file", "-d", "--delimiter", "-E", "--eof", "-I", "--replace", "-L", "--max-lines", "-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars"]);
  let cursor = 1;
  while (cursor < command.words.length) {
    const value = command.words[cursor]!.value;
    if (value === "--") return command.words.slice(cursor + 1);
    if (!value.startsWith("-") || value === "-") return command.words.slice(cursor);
    const flag = value.split("=", 1)[0]!;
    cursor += 1;
    if (!value.includes("=") && optionsWithValue.has(flag)) cursor += 1;
  }
  return null;
}

function findExecNestedWords(command: AnalyzedSimpleCommand): AnalyzedShellWord[][] {
  if (commandName(command.argv[0] ?? "") !== "find") return [];
  const nested: AnalyzedShellWord[][] = [];
  for (let i = 1; i < command.words.length; i += 1) {
    if (command.words[i]!.value !== "-exec" && command.words[i]!.value !== "-execdir") continue;
    const start = i + 1;
    let end = start;
    while (end < command.words.length && command.words[end]!.value !== ";" && command.words[end]!.value !== "+") end += 1;
    if (end > start) nested.push(command.words.slice(start, end));
    i = end;
  }
  return nested;
}

function shellBodyWord(command: AnalyzedSimpleCommand): AnalyzedShellWord | null {
  if (!SHELL_COMMANDS.has(commandName(command.argv[0] ?? ""))) return null;
  for (let i = 1; i < command.words.length; i += 1) {
    const flag = command.words[i]!.value;
    if (flag === "--") continue;
    if (flag === "-c" || (/^-[A-Za-z]+$/.test(flag) && flag.slice(1).includes("c"))) {
      return command.words[i + 1] ?? null;
    }
    if (!flag.startsWith("-")) break;
  }
  return null;
}

function envSplitBodyWord(command: AnalyzedSimpleCommand): AnalyzedShellWord | null {
  if (commandName(command.argv[0] ?? "") !== "env") return null;
  const joinRemainder = (words: AnalyzedShellWord[]): AnalyzedShellWord | null => {
    if (words.length === 0) return null;
    return {
      value: words.map((word) => word.value).join(" "),
      quoted: words.some((word) => word.quoted),
      dynamic: words.some((word) => word.dynamic),
    };
  };
  for (let i = 1; i < command.words.length; i += 1) {
    const value = command.words[i]!.value;
    if (value === "-S" || value === "--split-string") {
      return joinRemainder(command.words.slice(i + 1));
    }
    if (value.startsWith("--split-string=")) {
      return joinRemainder([
        {
          value: value.slice("--split-string=".length),
          quoted: command.words[i]!.quoted,
          dynamic: command.words[i]!.dynamic,
        },
        ...command.words.slice(i + 1),
      ]);
    }
    if (/^-S.+/.test(value)) {
      return joinRemainder([
        {
          value: value.slice(2),
          quoted: command.words[i]!.quoted,
          dynamic: command.words[i]!.dynamic,
        },
        ...command.words.slice(i + 1),
      ]);
    }
  }
  return null;
}

function addDerivedCommand(
  words: AnalyzedShellWord[],
  parent: AnalyzedSimpleCommand,
  budget: ScanBudget,
  output: MutableAnalysis,
): void {
  const command = makeCommand(nestedCommandWords(words), {
    depth: parent.depth + 1,
    topLevel: false,
    derived: true,
    pipeFromPrevious: false,
    pipeToNext: false,
    hasInputRedirect: false,
    hasRedirection: false,
  });
  if (command) {
    addCommand(command, budget, output);
    parseStaticCommandBodies([command], parent.depth + 1, budget, output);
  }
}

function parseStaticCommandBodies(
  commands: AnalyzedSimpleCommand[],
  depth: number,
  budget: ScanBudget,
  output: MutableAnalysis,
): void {
  for (const command of commands) {
    const envBody = envSplitBodyWord(command);
    if (envBody && !envBody.dynamic) {
      output.hasNestedCommands = true;
      parseScript(envBody.value, depth + 1, budget, output);
    }
    const body = shellBodyWord(command);
    if (body && !body.dynamic) {
      output.hasNestedCommands = true;
      parseScript(body.value, depth + 1, budget, output);
    }
    if (commandName(command.argv[0] ?? "") === "eval") {
      const args = command.words.slice(1);
      if (args.length > 0 && args.every((word) => !word.dynamic)) {
        output.hasNestedCommands = true;
        parseScript(args.map((word) => word.value).join(" "), depth + 1, budget, output);
      }
    }
    const xargsWords = xargsNestedWords(command);
    if (xargsWords?.length) addDerivedCommand(xargsWords, command, budget, output);
    for (const findWords of findExecNestedWords(command)) addDerivedCommand(findWords, command, budget, output);
  }
}

function commandsFromTokens(
  tokens: LexToken[],
  depth: number,
  budget: ScanBudget,
  output: MutableAnalysis,
): AnalyzedSimpleCommand[] {
  const localCommands: AnalyzedSimpleCommand[] = [];
  let words: AnalyzedShellWord[] = [];
  let hasInputRedirect = false;
  let hasRedirection = false;
  let skipRedirectTarget = false;
  let nextPipeFrom = false;
  let pipelineId: number | undefined;

  const finish = (): AnalyzedSimpleCommand | null => {
    const command = makeCommand(words, {
      depth,
      topLevel: depth === 0,
      derived: false,
      ...(pipelineId === undefined ? {} : { pipelineId }),
      pipeFromPrevious: nextPipeFrom,
      pipeToNext: false,
      hasInputRedirect,
      hasRedirection,
    });
    words = [];
    hasInputRedirect = false;
    hasRedirection = false;
    skipRedirectTarget = false;
    if (command) {
      localCommands.push(command);
      addCommand(command, budget, output);
    }
    return command;
  };

  for (const token of tokens) {
    if (token.kind === "word") {
      if (skipRedirectTarget) {
        skipRedirectTarget = false;
        continue;
      }
      words.push(token);
      continue;
    }
    if (REDIRECTION_SET.has(token.value)) {
      hasRedirection = true;
      if (token.value.startsWith("<")) hasInputRedirect = true;
      if (words.at(-1)?.value.match(/^\d+$/)) words.pop();
      skipRedirectTarget = true;
      continue;
    }
    if (!SEPARATOR_SET.has(token.value)) continue;
    const previous = finish();
    if (PIPE_SET.has(token.value)) {
      if (pipelineId === undefined) pipelineId = budget.nextPipelineId++;
      if (previous) {
        previous.pipelineId = pipelineId;
        previous.pipeToNext = true;
      }
      nextPipeFrom = true;
    } else {
      pipelineId = undefined;
      nextPipeFrom = false;
    }
  }
  finish();
  return localCommands;
}

function parseScript(
  source: string,
  depth: number,
  budget: ScanBudget,
  output: MutableAnalysis,
): void {
  if (depth > COMMAND_ANALYSIS_LIMITS.maxDepth) {
    throw new CommandAnalysisError("命令嵌套超过深度预算");
  }
  const heredoc = maskHeredocBodies(source, budget);
  const tokens = lexScript(heredoc.source, depth, budget, output);
  const localCommands = commandsFromTokens(tokens, depth, budget, output);
  parseStaticCommandBodies(localCommands, depth, budget, output);
  for (const body of heredoc.bodies) {
    if (body.expand) scanNestedExpansions(body.body, depth, budget, output);
  }
}

/** 对 command 做确定性、有界、quote-aware 静态分析；异常永远折叠成 error，不向 gate 抛出。 */
export function analyzeCommand(command: string): CommandAnalysis {
  if (typeof command !== "string") {
    return { commands: [], topLevelCommands: [], hasShellSyntax: false, hasNestedCommands: false, error: "命令必须是字符串" };
  }
  if (command.length > COMMAND_ANALYSIS_LIMITS.maxLength) {
    return { commands: [], topLevelCommands: [], hasShellSyntax: false, hasNestedCommands: false, error: "命令长度超过解析上限" };
  }
  if (command.includes("\0")) {
    return { commands: [], topLevelCommands: [], hasShellSyntax: false, hasNestedCommands: false, error: "命令不能包含 null 字节" };
  }
  if (command.trim().length === 0) {
    return { commands: [], topLevelCommands: [], hasShellSyntax: false, hasNestedCommands: false, error: "命令为空" };
  }
  const output: MutableAnalysis = {
    commands: [],
    topLevelCommands: [],
    hasShellSyntax: false,
    hasNestedCommands: false,
  };
  const budget: ScanBudget = { steps: 0, commands: 0, nextPipelineId: 1 };
  try {
    parseScript(command, 0, budget, output);
    return output;
  } catch (error) {
    return {
      ...output,
      error: error instanceof CommandAnalysisError ? error.message : "命令解析发生内部异常",
    };
  }
}

function hasHelpFlag(command: AnalyzedSimpleCommand): boolean {
  return command.argv.slice(1).some((arg) => arg === "--help" || arg === "-h" || arg === "/?");
}

function firstPositional(args: string[]): string | undefined {
  return args.find((arg) => !arg.startsWith("-"));
}

function isInstallCommand(command: AnalyzedSimpleCommand, pipeline: AnalyzedSimpleCommand[]): boolean {
  const name = commandName(command.argv[0] ?? "");
  const args = command.argv.slice(1).map((arg) => arg.toLowerCase());
  const action = firstPositional(args);
  if (name === "npx") return true;
  if (name === "npm" && action && new Set(["install", "i", "ci", "update", "exec"]).has(action)) return true;
  if (name === "pnpm" && action && new Set(["add", "install", "i", "up", "update", "dlx"]).has(action)) return true;
  if (name === "yarn" && action && new Set(["add", "install", "up", "upgrade", "dlx"]).has(action)) return true;
  if ((name === "pip" || name === "pip3") && action === "install") return true;
  if (/^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/.test(name) && args[0] === "-m" && args[1] === "pip" && args[2] === "install") return true;
  if (name === "uv" && args.some((arg) => new Set(["add", "install", "sync", "update", "upgrade"]).has(arg))) return true;
  if (new Set(["pipx", "poetry", "pdm"]).has(name) && action && new Set(["add", "install", "sync", "update", "upgrade"]).has(action)) return true;
  if (new Set(["apt", "apt-get", "brew", "dnf", "yum", "apk", "pacman", "zypper", "choco", "winget", "scoop"]).has(name) &&
      args.some((arg) => new Set(["install", "add", "upgrade"]).has(arg))) return true;
  if (name === "gem" && action && new Set(["install", "update"]).has(action)) return true;
  if ((name === "bundle" || name === "bundler") && action && new Set(["install", "update"]).has(action)) return true;
  if (name === "cargo" && action && new Set(["install", "update"]).has(action)) return true;
  if (name === "go" && action && new Set(["install", "get"]).has(action)) return true;
  if (name === "composer" && action && new Set(["install", "update", "require"]).has(action)) return true;
  if (name === "dotnet" && args[0] === "tool" && new Set(["install", "update"]).has(args[1] ?? "")) return true;
  if (new Set(["conda", "mamba", "micromamba"]).has(name) && action && new Set(["install", "update", "upgrade"]).has(action)) return true;
  if (name === "make" && args.some((arg) => arg === "install")) return true;
  if (name === "cmake" && args.some((arg) => arg === "--install")) return true;
  if (/^(?:install|setup|bootstrap)(?:\.[a-z0-9]+)?$/.test(name)) return true;

  if (command.pipelineId !== undefined && REMOTE_CODE_SINKS.has(name)) {
    const commandIndex = pipeline.indexOf(command);
    const upstream = pipeline.slice(0, commandIndex).filter((item) => item.pipelineId === command.pipelineId);
    if (upstream.some((item) => new Set(["curl", "wget", "fetch"]).has(commandName(item.argv[0] ?? "")))) return true;
  }
  if (command.pipelineId !== undefined && new Set(["iex", "invoke-expression"]).has(name)) {
    const commandIndex = pipeline.indexOf(command);
    const upstream = pipeline.slice(0, commandIndex).filter((item) => item.pipelineId === command.pipelineId);
    if (upstream.some((item) => new Set(["iwr", "irm", "invoke-webrequest", "invoke-restmethod"]).has(commandName(item.argv[0] ?? "")))) return true;
  }
  return false;
}

function larkWrites(command: AnalyzedSimpleCommand): boolean {
  if (commandName(command.argv[0] ?? "") !== "lark-cli") return false;
  const writeActions = new Set([
    "send", "reply", "forward", "create", "update", "append", "upload", "import", "publish", "delete",
    "+send", "+reply", "+forward", "+create", "+update", "+append", "+upload", "+import", "+publish", "+delete",
  ]);
  const args = command.argv.slice(1).map((arg) => arg.toLowerCase());
  const commandPath: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--profile") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--profile=") || arg === "-h" || arg === "--help" || arg === "-v" || arg === "--version") {
      continue;
    }
    if (arg.startsWith("-")) break;
    commandPath.push(arg);
  }
  // lark-cli 的写动作只看模块后的实际子命令位，不能扫 flag value/正文中的通用 create/update 等词。
  if (writeActions.has(commandPath[1] ?? "") || writeActions.has(commandPath[2] ?? "")) return true;
  const apiIndex = args.indexOf("api");
  return apiIndex >= 0 && new Set(["post", "put", "patch", "delete"]).has(args[apiIndex + 1] ?? "");
}

const CURL_LOCAL_OUTPUT_LONG_OPTIONS = new Set([
  "--output",
  "--output-dir",
  "--trace",
  "--trace-ascii",
  "--cookie-jar",
  "--dump-header",
]);

const CURL_LOCAL_OUTPUT_SHORT_OPTIONS = ["-o", "-c", "-D"] as const;
const WGET_LOCAL_OUTPUT_LONG_OPTIONS = new Set([
  "--append-output",
  "--directory-prefix",
  "--output-document",
  "--output-file",
]);
const WGET_LOCAL_OUTPUT_SHORT_OPTIONS = ["-a", "-O", "-o", "-P"] as const;
const SCP_OPTIONS_WITH_VALUE = new Set([
  "-c", "-D", "-F", "-i", "-J", "-l", "-o", "-P", "-S", "-X",
]);
const RSYNC_OPTIONS_WITH_VALUE = new Set([
  "-B", "-e", "-f", "-M", "-T",
  "--address", "--backup-dir", "--block-size", "--bwlimit", "--chown",
  "--compare-dest", "--compress-choice", "--compress-level", "--contimeout",
  "--copy-dest", "--exclude", "--exclude-from", "--files-from", "--filter",
  "--groupmap", "--include", "--include-from", "--link-dest", "--log-file",
  "--log-file-format", "--max-alloc", "--max-size", "--min-size", "--out-format",
  "--password-file", "--port", "--rsync-path", "--rsh", "--sockopts", "--suffix",
  "--temp-dir", "--timeout", "--usermap",
]);
const NC_OPTIONS_WITH_VALUE = new Set([
  "-e", "-I", "-i", "-M", "-m", "-O", "-P", "-p", "-q", "-s", "-T", "-V",
  "-w", "-X", "-x",
]);

function optionTakesSeparateValue(value: string, optionsWithValue: Set<string>): boolean {
  if (optionsWithValue.has(value)) return true;
  if (!value.startsWith("--") || value.includes("=")) return false;
  return optionsWithValue.has(value.toLowerCase());
}

function positionalWords(
  words: AnalyzedShellWord[],
  optionsWithValue: Set<string>,
): AnalyzedShellWord[] {
  const positional: AnalyzedShellWord[] = [];
  let optionsEnded = false;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    const value = word.value;
    if (!optionsEnded && value === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && value.startsWith("-") && value !== "-") {
      if (optionTakesSeparateValue(value, optionsWithValue)) i += 1;
      continue;
    }
    positional.push(word);
  }
  return positional;
}

function isDynamicLocalOutputWord(
  words: AnalyzedShellWord[],
  index: number,
  shortOptions: readonly string[],
  longOptions: Set<string>,
): boolean {
  const value = words[index]!.value;
  const previous = words[index - 1]?.value;
  if (
    previous &&
    (shortOptions.includes(previous) || longOptions.has(previous.toLowerCase()))
  ) {
    return true;
  }
  const equalsIndex = value.indexOf("=");
  if (equalsIndex > 0 && longOptions.has(value.slice(0, equalsIndex).toLowerCase())) {
    return true;
  }
  return shortOptions.some((option) => value.startsWith(option) && value.length > option.length);
}

/**
 * 网络 sink 的静态命令名一旦已识别，运行时才能确定的 URL/header/远端目标/主机
 * 必须 fail-closed 升级为 send。curl/wget 的本地输出文件名是唯一豁免；它不会进入
 * 请求，且短参允许 `-oFILE`/`-cFILE`/`-DFILE` 这类附着值。
 */
function hasDynamicExternalLocation(command: AnalyzedSimpleCommand): boolean {
  const name = commandName(command.argv[0] ?? "");
  const words = command.words.slice(1);
  if (name === "curl") {
    return words.some((word, index) =>
      word.dynamic &&
      !isDynamicLocalOutputWord(
        words,
        index,
        CURL_LOCAL_OUTPUT_SHORT_OPTIONS,
        CURL_LOCAL_OUTPUT_LONG_OPTIONS,
      ));
  }
  if (name === "wget") {
    return words.some((word, index) =>
      word.dynamic &&
      !isDynamicLocalOutputWord(
        words,
        index,
        WGET_LOCAL_OUTPUT_SHORT_OPTIONS,
        WGET_LOCAL_OUTPUT_LONG_OPTIONS,
      ));
  }
  if (name === "scp" || name === "rsync") {
    const operands = positionalWords(
      words,
      name === "scp" ? SCP_OPTIONS_WITH_VALUE : RSYNC_OPTIONS_WITH_VALUE,
    );
    return operands.length >= 2 && operands.at(-1)!.dynamic;
  }
  if (name === "nc" || name === "ncat" || name === "netcat") {
    const lowerArgs = command.argv.slice(1).map((arg) => arg.toLowerCase());
    if (lowerArgs.some((arg) => arg === "-l" || arg === "--listen" || /^-[^-]*l/.test(arg))) {
      return false;
    }
    return positionalWords(words, NC_OPTIONS_WITH_VALUE).some((word) => word.dynamic);
  }
  return false;
}

function curlWrites(command: AnalyzedSimpleCommand): boolean {
  const args = command.argv.slice(1);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const lower = arg.toLowerCase();
    if (new Set(["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--json", "--form", "--form-string", "--upload-file"]).has(lower) || arg === "-F" || arg === "-T") return true;
    if (/^(?:--data(?:-raw|-binary|-urlencode)?|--json|--form(?:-string)?|--upload-file)=/i.test(arg)) return true;
    if (/^(?:-d|-F|-T).+/.test(arg)) return true;
    if (arg === "-X" || lower === "--request") {
      const method = (args[i + 1] ?? "").toUpperCase();
      if (new Set(["POST", "PUT", "PATCH", "DELETE"]).has(method)) return true;
    }
    const request = arg.match(/^--request=(.+)$/i)?.[1]?.toUpperCase() ?? arg.match(/^-X(.+)$/)?.[1]?.toUpperCase();
    if (request && new Set(["POST", "PUT", "PATCH", "DELETE"]).has(request)) return true;
  }
  return false;
}

function wgetWrites(command: AnalyzedSimpleCommand): boolean {
  return command.argv.slice(1).some((arg) =>
    /^(?:--post-data|--post-file)=/i.test(arg) ||
    /^(?:--method=)(?:POST|PUT|PATCH|DELETE)$/i.test(arg) ||
    new Set(["--post-data", "--post-file"]).has(arg.toLowerCase()));
}

function looksRemotePath(value: string): boolean {
  if (/^(?:[a-z][a-z0-9+.-]*):\/\//i.test(value)) return true;
  if (/^[^/\s:]+@?[^/\s:]*:.+/.test(value) && !/^[A-Za-z]:[\\/]/.test(value)) return true;
  return /^(?:s3|gs|az|r2):/i.test(value);
}

function fileTransferWrites(command: AnalyzedSimpleCommand): boolean {
  const name = commandName(command.argv[0] ?? "");
  const positional = command.argv.slice(1).filter((arg) => !arg.startsWith("-"));
  if ((name === "scp" || name === "rsync") && positional.length >= 2) {
    return !looksRemotePath(positional[0]!) && looksRemotePath(positional.at(-1)!);
  }
  if (name === "aws" && command.argv[1]?.toLowerCase() === "s3" && new Set(["cp", "sync", "mv"]).has(command.argv[2]?.toLowerCase() ?? "")) {
    const operands = command.argv.slice(3).filter((arg) => !arg.startsWith("-"));
    return operands.length >= 2 && !looksRemotePath(operands[0]!) && looksRemotePath(operands.at(-1)!);
  }
  if (new Set(["gsutil", "rclone", "azcopy"]).has(name) && positional.length >= 2) {
    return !looksRemotePath(positional[0]!) && looksRemotePath(positional.at(-1)!);
  }
  return false;
}

function isSendCommand(command: AnalyzedSimpleCommand): boolean {
  const name = commandName(command.argv[0] ?? "");
  const args = command.argv.slice(1).map((arg) => arg.toLowerCase());
  if (hasDynamicExternalLocation(command)) return true;
  if (larkWrites(command)) return true;
  if (name === "curl" && curlWrites(command)) return true;
  if (name === "wget" && wgetWrites(command)) return true;
  if (name === "git" && args[0] === "push") return true;
  if (new Set(["npm", "pnpm", "yarn", "cargo", "gem", "composer"]).has(name) && args[0] === "publish") return true;
  if (new Set(["docker", "podman", "nerdctl"]).has(name) && args[0] === "push") return true;
  if (new Set(["vercel", "netlify", "wrangler", "firebase"]).has(name) && args.some((arg) => new Set(["deploy", "publish"]).has(arg))) return true;
  if (name === "gh" && args[0] === "release" && new Set(["create", "upload", "edit", "delete"]).has(args[1] ?? "")) return true;
  if ((name === "mail" || name === "slack") && args.some((arg) => new Set(["send", "reply", "forward", "post-message"]).has(arg))) return true;
  if (fileTransferWrites(command)) return true;
  if (new Set(["nc", "ncat", "netcat", "socat"]).has(name) && (command.pipeFromPrevious || command.hasInputRedirect)) return true;
  return false;
}

function dynamicExecutionTitle(command: AnalyzedSimpleCommand): string | null {
  if (command.words[0]?.dynamic) return "执行动态解析的命令";
  if (commandName(command.argv[0] ?? "") === "eval") return "执行 eval 命令";
  return null;
}

function destructiveTitle(command: AnalyzedSimpleCommand): string | null {
  const name = commandName(command.argv[0] ?? "");
  const args = command.argv.slice(1).map((arg) => arg.toLowerCase());
  if (hasHelpFlag(command)) return null;
  if (new Set(["rm", "rmdir", "unlink", "del", "erase", "shred"]).has(name)) return "删除文件";
  if (new Set(["mv", "move", "rename"]).has(name)) return "移动/重命名文件";
  if (name === "find" && args.includes("-delete")) return "删除查找到的文件";
  if (name === "git") {
    if (args[0] === "clean") return "清理版本库文件";
    if (args[0] === "reset" && args.includes("--hard")) return "强制重置版本库";
    if ((args[0] === "checkout" || args[0] === "restore") && args.some((arg) => arg === "-f" || arg === "--force")) return "强制覆盖版本库文件";
    if (args[0] === "branch" && args.includes("-d")) return "强制删除分支";
  }
  if (new Set(["npm", "pnpm", "yarn", "pip", "pip3", "brew", "apt", "apt-get", "gem", "cargo", "composer", "conda", "mamba"]).has(name) &&
      args.some((arg) => new Set(["uninstall", "remove", "purge"]).has(arg))) return "卸载依赖/工具";
  if (/^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/.test(name) && args[0] === "-m" && args[1] === "pip" && args[2] === "uninstall") return "卸载依赖/工具";
  if (name === "truncate" || name === "shred") return "截断或擦除文件";
  if (new Set(["mkfs", "fdisk", "parted"]).has(name)) return "修改磁盘或文件系统";
  if (name === "dd" && args.some((arg) => /^of=\/dev\//.test(arg) || arg === "conv=notrunc")) return "覆盖磁盘或文件";
  if (new Set(["kill", "pkill", "killall", "taskkill"]).has(name)) return "终止进程";
  if ((name === "systemctl" || name === "service") && args.some((arg) => arg === "stop" || arg === "disable")) return "停止或禁用服务";
  if (name === "dropdb") return "删除数据库";
  if (name === "redis-cli" && args.some((arg) => arg === "flushall" || arg === "flushdb")) return "清空数据存储";
  if (new Set(["psql", "mysql", "sqlite3"]).has(name) && command.argv.slice(1).some((arg) => /\b(?:drop|truncate)\s+(?:table|database|schema)\b/i.test(arg))) return "删除数据库对象";
  return null;
}

function sendTitle(commands: AnalyzedSimpleCommand[]): { title: string; detail: string } {
  if (commands.some((command) => larkWrites(command))) {
    return { title: "发送或发布到飞书", detail: "将修改你的飞书内容或向飞书发送数据" };
  }
  if (commands.some((command) => commandName(command.argv[0] ?? "") === "git" && command.argv[1]?.toLowerCase() === "push")) {
    return { title: "推送代码到远端", detail: "将修改远端代码仓库" };
  }
  return { title: "发送、上传或发布到外部", detail: "数据将离开本地或修改外部系统" };
}

function verdictFromEffects(
  effects: Set<CommandEffect>,
  commands: AnalyzedSimpleCommand[],
  destructive: string | null,
): RiskVerdict {
  const ordered = (["install", "send", "destructive"] as const).filter((effect) => effects.has(effect));
  if (ordered.length > 1) {
    const labels: Record<CommandEffect, string> = {
      install: "安装/升级环境",
      send: "外发/外部写入",
      destructive: "本地破坏",
    };
    return {
      risk: "confirm",
      effects: ordered,
      confirmKind: "command",
      title: "执行包含多种副作用的命令",
      detail: `包含：${ordered.map((effect) => labels[effect]).join("、")}`,
      icon: "⚠️",
    };
  }
  if (effects.has("install")) {
    return {
      risk: "confirm",
      effects: ["install"],
      confirmKind: "install",
      title: "安装依赖/工具",
      detail: "将下载或执行新代码，并可能改动这台电脑上的软件或设置",
      icon: "📦",
    };
  }
  if (effects.has("send")) {
    const copy = sendTitle(commands);
    return {
      risk: "confirm",
      effects: ["send"],
      confirmKind: "send",
      title: copy.title,
      detail: copy.detail,
      icon: "📤",
    };
  }
  return {
    risk: "confirm",
    effects: ["destructive"],
    confirmKind: "command",
    title: destructive ?? "执行破坏性命令",
    detail: "将删除、移动、终止或不可逆地修改本地状态",
    icon: "🗑️",
  };
}

export function assessCommandAnalysis(analysis: CommandAnalysis): RiskVerdict {
  if (analysis.error) {
    return {
      risk: "deny",
      effects: [],
      title: "操作被拒绝",
      icon: "🚫",
      denyReason: analysis.error,
    };
  }
  const effects = new Set<CommandEffect>();
  let destructive: string | null = null;
  let dynamicExecution: string | null = null;
  for (const command of analysis.commands) {
    if (isInstallCommand(command, analysis.commands)) effects.add("install");
    if (isSendCommand(command)) effects.add("send");
    dynamicExecution ??= dynamicExecutionTitle(command);
    const title = destructiveTitle(command);
    if (title) {
      effects.add("destructive");
      destructive ??= title;
    }
  }
  if (effects.size > 0) return verdictFromEffects(effects, analysis.commands, destructive);
  if (dynamicExecution) {
    return {
      risk: "confirm",
      effects: [],
      confirmKind: "command",
      title: dynamicExecution,
      detail: "实际执行内容只能在 shell 展开后确定",
      icon: "⚠️",
    };
  }
  return { risk: "safe", effects: [], title: "执行操作", icon: "⚙️" };
}

/** 判定命令危险度并生成友好文案。 */
export function assessCommand(command: string): RiskVerdict {
  return assessCommandAnalysis(analyzeCommand(command));
}
