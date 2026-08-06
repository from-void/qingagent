import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  getPyodideRuntimeAvailability,
  runPythonInWorker,
  type RunPythonResult,
  type RunPythonWorkerInput,
} from "../runtime/pyodideRunner.js";
import { RUN_SCRIPT_FAILURE_KINDS } from "../runtime/scriptFailure.js";

const MAX_CODE_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 15_000;

const runPythonInputSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(MAX_CODE_CHARS)
    .describe("要执行的 Python 代码。可读取 input/input_json，可用最后一个表达式返回结果，可用 print 输出 stdout。"),
  input_json: z.unknown().optional().describe("传给代码的结构化 JSON 输入，在代码里通过 input 或 input_json 读取。"),
  timeout_ms: z
    .number()
    .int()
    .min(1)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(`硬超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}，最大 ${MAX_TIMEOUT_MS}。`),
});

const runPythonOutputSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  stdout: z.string(),
  stderr: z.string(),
  error: z.string().nullable().optional(),
  stdout_truncated: z.boolean().optional(),
  stderr_truncated: z.boolean().optional(),
  result_truncated: z.boolean().optional(),
  load_ms: z.number().optional(),
  failureKind: z.enum(RUN_SCRIPT_FAILURE_KINDS).optional(),
});

export type RunPythonInput = z.infer<typeof runPythonInputSchema>;
export type { RunPythonResult };

let warnedUnavailableReason: string | null = null;

function isExplicitlyEnabled(): boolean {
  const value = process.env.QINGAGENT_PYODIDE_ENABLED?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "enabled" || value === "yes";
}

export const runPythonTool = createTool({
  id: "run_python",
  description:
    "进程内执行受限 Python/Pyodide 片段,用于确定性计算、JSON/文本转换和轻量数据处理。代码在 fresh worker_thread 中运行," +
    "Python 的 import js 只映射到空安全对象,不能访问 process/env/fetch/require/Buffer/Node 文件或网络能力;不加载 micropip/第三方包;" +
    "超时会硬 terminate worker。代码可通过 input/input_json 读取结构化输入,用最后一个表达式返回 JSON 结果,用 print 输出 stdout。",
  inputSchema: runPythonInputSchema,
  outputSchema: runPythonOutputSchema,
  execute: async (input, context) => {
    const parsed = runPythonInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        stdout: "",
        stderr: "",
        error: parsed.error.issues.map((issue) => issue.message).join("; "),
        failureKind: "codeError",
      } satisfies RunPythonResult;
    }
    return runPythonInWorker(parsed.data as RunPythonWorkerInput, context?.abortSignal);
  },
});

export function getPyodideTools(): Record<string, typeof runPythonTool> {
  const availability = getPyodideRuntimeAvailability();
  if (!availability.available) {
    if (isExplicitlyEnabled() && warnedUnavailableReason !== availability.reason) {
      warnedUnavailableReason = availability.reason;
      console.warn(`[run_python] QINGAGENT_PYODIDE_ENABLED=1 but pyodide is unavailable: ${availability.reason}`);
    }
    return {};
  }
  return { run_python: runPythonTool };
}
