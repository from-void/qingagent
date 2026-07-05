import type { Context } from "hono";
import type { z } from "zod";
import { COMMAND_KIND_SET } from "@qingagent/contract-ts/schemas";

/**
 * 统一的入站校验工具:zod safeParse 失败 → 400,错误契约 `{ error, issues[] }`。
 *
 * - `error`(string):向后兼容——web 现有错误处理只读顶层 `error` 字段;取首条 issue
 *   拼成 `"<path>: <message>"`,含字段路径,便于定位。
 * - `issues`(数组):新增的结构化明细,每条 `{ path, message, code }`。
 *
 * 覆盖 13 处路由的 `c.req.json()` + 逐字段手写校验,消灭复制粘贴的 try/catch。
 */

/** 单条结构化校验明细。 */
export interface ValidationIssue {
  path: string;
  message: string;
  code: string;
}

/** 400 错误响应体契约。 */
export interface ValidationErrorBody {
  error: string;
  issues: ValidationIssue[];
}

const DEFAULT_MAX_BODY_DEPTH = 64;

/** 把 zod issue.path(`["data","fileIds",0]`)渲染成 `data.fileIds[0]`。 */
export function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") {
      out += `[${seg}]`;
    } else {
      const key = String(seg);
      out += out.length > 0 ? `.${key}` : key;
    }
  }
  return out;
}

/** 通用 zod 错误 → `{ error, issues }`(P1 各路由私有形状用)。 */
export function formatZodError(error: z.ZodError): ValidationErrorBody {
  const issues: ValidationIssue[] = error.issues.map((issue) => ({
    path: formatIssuePath(issue.path),
    message: issue.message,
    code: issue.code,
  }));
  const first = issues[0];
  const message = first
    ? first.path.length > 0
      ? `${first.path}: ${first.message}`
      : first.message
    : "Invalid request body";
  return { error: message, issues };
}

/**
 * Command 专用错误格式化:在通用基础上加 `<kind>.` 前缀(贴近旧文案
 * `sendMessage.data.text ...`),并对"未知 kind""非对象 body"给出与旧实现同义的文案。
 */
export function formatCommandError(error: z.ZodError, body: unknown): ValidationErrorBody {
  // 非对象 body:与旧 `validateCommandKind` 首个分支同义。
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Command must be a non-null object", issues: [] };
  }
  const base = formatZodError(error);
  const kind = (body as Record<string, unknown>).kind;
  // 未知 kind:discriminatedUnion 会报 discriminator 错;这里给旧同款文案。
  if (typeof kind === "string" && !COMMAND_KIND_SET.has(kind)) {
    return { error: `Unknown command kind: ${kind}`, issues: base.issues };
  }
  if (typeof kind !== "string") {
    // kind 缺失/非字符串:discriminator 报错,补前缀无意义,直接用通用文案。
    return base;
  }
  // 合法 kind:给首条 issue 补 `<kind>.` 前缀,便于人读定位。
  const first = base.issues[0];
  if (!first) return base;
  const label = first.path.length > 0 ? `${kind}.${first.path}` : kind;
  return { error: `${label}: ${first.message}`, issues: base.issues };
}

function findPathBeyondDepth(value: unknown, maxDepth: number): string | null {
  const stack: Array<{ value: unknown; path: PropertyKey[]; depth: number }> = [
    { value, path: [], depth: 0 },
  ];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > maxDepth) return formatIssuePath(current.path);
    if (current.value === null || typeof current.value !== "object") continue;
    if (Array.isArray(current.value)) {
      for (let i = current.value.length - 1; i >= 0; i -= 1) {
        stack.push({
          value: current.value[i],
          path: [...current.path, i],
          depth: current.depth + 1,
        });
      }
      continue;
    }
    for (const [key, child] of Object.entries(current.value as Record<string, unknown>)) {
      stack.push({
        value: child,
        path: [...current.path, key],
        depth: current.depth + 1,
      });
    }
  }
  return null;
}

function formatDepthError(path: string, maxDepth: number): ValidationErrorBody {
  const message = `Request body exceeds maximum nesting depth ${maxDepth}`;
  return {
    error: path ? `${path}: ${message}` : message,
    issues: [{ path, message, code: "too_big" }],
  };
}

/** parseBody 成功/失败结果。 */
export type ParseBodyResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: Response };

/** parseBody 可选项。 */
export interface ParseBodyOptions {
  /** 自定义 zod 错误格式化(Command 路由传 formatCommandError);默认通用。 */
  formatError?: (error: z.ZodError, body: unknown) => ValidationErrorBody;
  /** JSON 解析失败时的错误文案(个别路由有自定义中文文案);默认 "Invalid JSON body"。 */
  invalidJsonMessage?: string;
  /** JSON body 最大嵌套深度;设为 null 可关闭。默认 64,用于挡深嵌套脏输入。 */
  maxDepth?: number | null;
  /** JSON 解析失败 / 校验失败的响应生成器(个别路由响应形状特殊,如 {ok:false,error})。 */
  makeErrorResponse?: (c: Context, body: ValidationErrorBody) => Response;
}

/**
 * 读取并校验请求体:JSON 解析失败 → 400;schema 校验失败 → 400 `{ error, issues }`;
 * 成功 → 返回**消毒后**的 parse 输出(未知字段已 strip)。消灭各路由复制粘贴的 try/catch。
 */
export async function parseBody<T>(
  c: Context,
  schema: z.ZodType<T>,
  options: ParseBodyOptions = {},
): Promise<ParseBodyResult<T>> {
  const formatError = options.formatError ?? ((error) => formatZodError(error));
  const makeResponse =
    options.makeErrorResponse ?? ((ctx, errBody) => ctx.json(errBody, 400));
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    const message = options.invalidJsonMessage ?? "Invalid JSON body";
    return { ok: false, response: makeResponse(c, { error: message, issues: [] }) };
  }
  const maxDepth = options.maxDepth === undefined ? DEFAULT_MAX_BODY_DEPTH : options.maxDepth;
  if (maxDepth !== null) {
    const path = findPathBeyondDepth(body, maxDepth);
    if (path !== null) {
      return { ok: false, response: makeResponse(c, formatDepthError(path, maxDepth)) };
    }
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    return { ok: false, response: makeResponse(c, formatError(result.error, body)) };
  }
  return { ok: true, data: result.data };
}
