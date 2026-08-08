import { existsSync } from "node:fs";
import { join } from "node:path";
import { LocalSandbox } from "@mastra/core/workspace";
import {
  SANDBOX_BIN_DIR,
  SANDBOX_NODE_RUNTIME_DIR,
  resolveNodeRuntimePathPlacement,
  type ResolvedIsolation,
} from "./sessionWorkspace.js";
import { isPyodideRuntimeAvailable } from "../runtime/pyodideRunner.js";

export type NodeRuntimeCapability = "shim-ready" | "host";
export type PythonRuntimeCapability = "pyodide-on" | "disabled";
export type LarkCliCapability = "present" | "missing";

export interface SandboxRuntimeCapabilities {
  node: NodeRuntimeCapability;
  python: PythonRuntimeCapability;
  larkCli: LarkCliCapability;
  isolation: ResolvedIsolation;
}

function hasAnySandboxBin(names: string[], dir = SANDBOX_BIN_DIR): boolean {
  return names.some((name) => existsSync(join(dir, name)));
}

/**
 * 沙箱里的 `node` 究竟来自谁。
 *
 * 宿主优先档(无隔离/用户已全局免询问)下,PATH 上先命中的一定是宿主自己的 Node——
 * 产品自带运行时只排在末尾兜底,不该再对模型宣称"产品运行时就绪"。
 */
function detectNodeRuntime(): NodeRuntimeCapability {
  if (resolveNodeRuntimePathPlacement() === "host-first") return "host";
  const shimNames = process.platform === "win32" ? ["node.cmd", "node.exe", "node"] : ["node"];
  return hasAnySandboxBin(shimNames, SANDBOX_NODE_RUNTIME_DIR) ? "shim-ready" : "host";
}

function detectLarkCli(): LarkCliCapability {
  const names = process.platform === "win32"
    ? ["lark-cli.cmd", "lark-cli.exe", "lark-cli"]
    : ["lark-cli"];
  return hasAnySandboxBin(names) ? "present" : "missing";
}

function detectIsolationWithoutCache(): ResolvedIsolation {
  const forced = process.env.QINGAGENT_SANDBOX_ISOLATION;
  if (forced === "none" || forced === "seatbelt" || forced === "bwrap") return forced;
  try {
    const detected = LocalSandbox.detectIsolation();
    return detected.available ? detected.backend : "none";
  } catch {
    return "none";
  }
}

export function detectSandboxRuntimeCapabilities(): SandboxRuntimeCapabilities {
  return {
    node: detectNodeRuntime(),
    python: isPyodideRuntimeAvailable() ? "pyodide-on" : "disabled",
    larkCli: detectLarkCli(),
    isolation: detectIsolationWithoutCache(),
  };
}

export function formatSandboxRuntimeCapabilities(capabilities: SandboxRuntimeCapabilities): string {
  return `node=${capabilities.node}; python=${capabilities.python}; larkCli=${capabilities.larkCli}; isolation=${capabilities.isolation}`;
}

export function buildRuntimeCapabilityDirective(capabilities: SandboxRuntimeCapabilities): string {
  const pythonDirective = capabilities.python === "pyodide-on"
    ? "不要直接写 python、pip、curl、wget、node -e、内联 eval 或依赖系统 PATH 查找解释器；Python 仅可通过 run_python 工具使用。"
    : "不要直接写 python、pip、curl、wget、node -e、内联 eval 或依赖系统 PATH 查找解释器；Python 当前不可用，只有明确暴露 run_python 时才可用。";
  return [
    `6. **启动期能力约束**：当前本地运行能力为 ${formatSandboxRuntimeCapabilities(capabilities)}。`,
    "精确计算/数据转换优先调用 run_js；表格、财务、统计类计算用 doc-calc 的 node 脚本，并用 --json 或 --file 传数据，绝不要用管道/重定向。",
    pythonDirective,
  ].join("");
}
