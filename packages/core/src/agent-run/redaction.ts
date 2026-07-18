import { truncateUtf8 } from "../observability/innerLlmSpan.js";

const DEFAULT_TOOL_IO_MAX_BYTES = 50 * 1024;
export const LLM_IO_FIELD_LIMIT = 64 * 1024;
export const LLM_IO_TRUNCATED_SUFFIX = "…[truncated]";

// truncateUtf8 收敛到 observability/innerLlmSpan(避免双份实现漂移,prd-review 建议)。

export function getToolIoMaxBytes(): number {
  const raw = process.env.QINGAGENT_OBS_TOOL_IO_MAX_BYTES;
  if (raw === undefined) return DEFAULT_TOOL_IO_MAX_BYTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_TOOL_IO_MAX_BYTES;
}

const SENSITIVE_FIELD_SOURCE =
  String.raw`(?:bearer[_-]?token|access[_-]?token|api[_-]?key|token|secret|password|key)`;
const SENSITIVE_FIELD_RE = new RegExp(String.raw`^${SENSITIVE_FIELD_SOURCE}$`, "i");
const ENV_SENSITIVE_FIELD_SOURCE =
  String.raw`[A-Z][A-Z0-9_]*_(?:SECRET|TOKEN|PASSWORD|API_?KEY|APP_?KEY|ACCESS_?KEY)`;
const ENV_SENSITIVE_FIELD_RE = new RegExp(String.raw`^${ENV_SENSITIVE_FIELD_SOURCE}$`);
const ENV_FIELD_PREFIX_SOURCE = String.raw`(^|[^A-Za-z0-9_])`;
const AUTH_CREDENTIAL_RE = /\b(Bearer|Basic)\s+([^\s"',;)}\]]+)/gi;
const ESCAPED_DOUBLE_QUOTED_FIELD_RE = new RegExp(
  String.raw`(\\")(${SENSITIVE_FIELD_SOURCE})(\\")(\s*[:=]\s*)(\\")(?:(?:\\\\.)|(?!\\").)*?(\\")`,
  "gi",
);
const ENV_ESCAPED_DOUBLE_QUOTED_FIELD_RE = new RegExp(
  String.raw`${ENV_FIELD_PREFIX_SOURCE}(\\")(${ENV_SENSITIVE_FIELD_SOURCE})(\\")(\s*[:=]\s*)(\\")(?:(?:\\\\.)|(?!\\").)*?(\\")`,
  "g",
);
const DOUBLE_QUOTED_FIELD_RE = new RegExp(
  String.raw`(["']?)\b(${SENSITIVE_FIELD_SOURCE})\b\1(\s*[:=]\s*)"(?:(?:\\.)|[^"\\])*"`,
  "gi",
);
const ENV_DOUBLE_QUOTED_FIELD_RE = new RegExp(
  String.raw`${ENV_FIELD_PREFIX_SOURCE}(["']?)(${ENV_SENSITIVE_FIELD_SOURCE})\2(\s*[:=]\s*)"(?:(?:\\.)|[^"\\])*"`,
  "g",
);
const SINGLE_QUOTED_FIELD_RE = new RegExp(
  String.raw`(["']?)\b(${SENSITIVE_FIELD_SOURCE})\b\1(\s*[:=]\s*)'(?:(?:\\.)|[^'\\])*'`,
  "gi",
);
const ENV_SINGLE_QUOTED_FIELD_RE = new RegExp(
  String.raw`${ENV_FIELD_PREFIX_SOURCE}(["']?)(${ENV_SENSITIVE_FIELD_SOURCE})\2(\s*[:=]\s*)'(?:(?:\\.)|[^'\\])*'`,
  "g",
);
const UNQUOTED_FIELD_RE = new RegExp(
  String.raw`(["']?)\b(${SENSITIVE_FIELD_SOURCE})\b\1(\s*[:=]\s*)([^\s,;)}\]"']+)`,
  "gi",
);
const ENV_UNQUOTED_FIELD_RE = new RegExp(
  String.raw`${ENV_FIELD_PREFIX_SOURCE}(["']?)(${ENV_SENSITIVE_FIELD_SOURCE})\2(\s*[:=]\s*)([^\s,;)}\]"']+)`,
  "g",
);
// 空格分隔 + 引号包裹的值:`password 'secret'` / `api_key "x"` / `--token 'x'`。
// 之前只有 `[:=]` 分隔的引号值(DOUBLE/SINGLE_QUOTED_FIELD_RE)和空格分隔的裸值
// (SPACE_FIELD_RE,值类排除引号)被处理,空格+引号值漏网泄漏(R11-1)。
const SPACE_DOUBLE_QUOTED_FIELD_RE = new RegExp(
  String.raw`\b(${SENSITIVE_FIELD_SOURCE})\b(\s+)"(?:(?:\\.)|[^"\\])*"`,
  "gi",
);
const ENV_SPACE_DOUBLE_QUOTED_FIELD_RE = new RegExp(
  String.raw`${ENV_FIELD_PREFIX_SOURCE}(${ENV_SENSITIVE_FIELD_SOURCE})(\s+)"(?:(?:\\.)|[^"\\])*"`,
  "g",
);
const SPACE_SINGLE_QUOTED_FIELD_RE = new RegExp(
  String.raw`\b(${SENSITIVE_FIELD_SOURCE})\b(\s+)'(?:(?:\\.)|[^'\\])*'`,
  "gi",
);
const ENV_SPACE_SINGLE_QUOTED_FIELD_RE = new RegExp(
  String.raw`${ENV_FIELD_PREFIX_SOURCE}(${ENV_SENSITIVE_FIELD_SOURCE})(\s+)'(?:(?:\\.)|[^'\\])*'`,
  "g",
);
const SPACE_FIELD_RE = new RegExp(
  String.raw`\b(${SENSITIVE_FIELD_SOURCE})\b(\s+)([^\s,;)}\]"']+)`,
  "gi",
);
const ENV_SPACE_FIELD_RE = new RegExp(
  String.raw`${ENV_FIELD_PREFIX_SOURCE}(${ENV_SENSITIVE_FIELD_SOURCE})(\s+)([^\s,;)}\]"']+)`,
  "g",
);

function isSensitiveField(key: string): boolean {
  return SENSITIVE_FIELD_RE.test(key) || ENV_SENSITIVE_FIELD_RE.test(key);
}

export function redactSensitiveText(text: string): string {
  return text
    .replace(AUTH_CREDENTIAL_RE, "$1 ***")
    .replace(
      ENV_SPACE_DOUBLE_QUOTED_FIELD_RE,
      (_match, prefix: string, key: string, separator: string) =>
        `${prefix}${key}${separator}"***"`,
    )
    .replace(
      ENV_SPACE_SINGLE_QUOTED_FIELD_RE,
      (_match, prefix: string, key: string, separator: string) =>
        `${prefix}${key}${separator}'***'`,
    )
    .replace(
      SPACE_DOUBLE_QUOTED_FIELD_RE,
      (_match, key: string, separator: string) => `${key}${separator}"***"`,
    )
    .replace(
      SPACE_SINGLE_QUOTED_FIELD_RE,
      (_match, key: string, separator: string) => `${key}${separator}'***'`,
    )
    .replace(
      ESCAPED_DOUBLE_QUOTED_FIELD_RE,
      (_match, open: string, key: string, close: string, separator: string, valueOpen: string, valueClose: string) =>
        `${open}${key}${close}${separator}${valueOpen}***${valueClose}`,
    )
    .replace(
      ENV_ESCAPED_DOUBLE_QUOTED_FIELD_RE,
      (
        _match,
        prefix: string,
        open: string,
        key: string,
        close: string,
        separator: string,
        valueOpen: string,
        valueClose: string,
      ) => `${prefix}${open}${key}${close}${separator}${valueOpen}***${valueClose}`,
    )
    .replace(
      ENV_DOUBLE_QUOTED_FIELD_RE,
      (_match, prefix: string, keyQuote: string, key: string, separator: string) =>
        `${prefix}${keyQuote}${key}${keyQuote}${separator}"***"`,
    )
    .replace(
      DOUBLE_QUOTED_FIELD_RE,
      (_match, keyQuote: string, key: string, separator: string) =>
        `${keyQuote}${key}${keyQuote}${separator}"***"`,
    )
    .replace(
      ENV_SINGLE_QUOTED_FIELD_RE,
      (_match, prefix: string, keyQuote: string, key: string, separator: string) =>
        `${prefix}${keyQuote}${key}${keyQuote}${separator}'***'`,
    )
    .replace(
      SINGLE_QUOTED_FIELD_RE,
      (_match, keyQuote: string, key: string, separator: string) =>
        `${keyQuote}${key}${keyQuote}${separator}'***'`,
    )
    .replace(
      ENV_UNQUOTED_FIELD_RE,
      (_match, prefix: string, keyQuote: string, key: string, separator: string) =>
        `${prefix}${keyQuote}${key}${keyQuote}${separator}***`,
    )
    .replace(
      UNQUOTED_FIELD_RE,
      (_match, keyQuote: string, key: string, separator: string) =>
        `${keyQuote}${key}${keyQuote}${separator}***`,
    )
    .replace(
      ENV_SPACE_FIELD_RE,
      (_match, prefix: string, key: string, separator: string) =>
        `${prefix}${key}${separator}***`,
    )
    .replace(
      SPACE_FIELD_RE,
      (_match, key: string, separator: string) => `${key}${separator}***`,
    );
}

function redactedJsonReplacer(key: string, nested: unknown): unknown {
  if (key && isSensitiveField(key)) return "***";
  if (typeof nested === "string") return redactSensitiveText(nested);
  return nested;
}

export function redactedSerializedText(value: unknown, maxBytes = getToolIoMaxBytes()): string {
  let text: string;
  try {
    const json = JSON.stringify(value, redactedJsonReplacer);
    text = redactSensitiveText(json ?? "");
  } catch {
    text = redactSensitiveText(String(value));
  }
  // 上限封顶:argsJson / 命令卡等帧字段不能因超长输入(大 args / 大 code)无界膨胀,
  // 撑爆单帧(R11-1)。超限截断并加标记。
  const capped = truncateUtf8(text, maxBytes);
  return capped.truncated ? `${capped.text}…[truncated]` : capped.text;
}

export function redactedJsonText(value: unknown): string {
  if (typeof value === "string") return redactSensitiveText(value);
  return redactedSerializedText(value);
}

export function redactedToolResultPreview(value: unknown, maxChars = 200): string {
  return redactedSerializedText(value).slice(0, maxChars);
}

// 给前端工具卡(UToolBar)用的结果摘要:只保留标量(数字/布尔/短字符串)与数组长度
// (<key>Count),丢弃大数组/嵌套正文,确保 200 字符内是「可解析的紧凑 JSON」。
// 否则像 readDraft 这种 { blocks:[…大数组…], wordCount } 会被截断、JSON 解析失败 →
// 前端 pickOutputSummary 取不到 wordCount → 只能显示"已完成"(应显示"N 字")。
// 前端 pickOutputSummary 取得到状态文案,关键标量必须留在紧凑对象里。除顶层标量/数组长度外,
// 再把一层嵌套小对象(如 readDiff 的 stats、parseFile 的 metadata)里的标量按 `<父>.<子>` 提上来——
// 否则这些工具最有信息量的数字(差异处数 / 解析字数)会随整个 record 被丢弃,只能显示"已完成"。
export function toolResultCardSummary(value: unknown, maxChars = 200): string {
  if (isRecord(value)) {
    const compact: Record<string, unknown> = {};
    const addScalar = (key: string, v: unknown) => {
      if (typeof v === "number" || typeof v === "boolean") compact[key] = v;
      else if (typeof v === "string" && v.length <= 40) compact[key] = v;
    };
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "number" || typeof v === "boolean") compact[k] = v;
      else if (typeof v === "string") {
        if (v.length <= 40) compact[k] = v;
      } else if (Array.isArray(v)) compact[`${k}Count`] = v.length;
      else if (isRecord(v)) {
        // 仅下钻一层,把嵌套标量按 `<父>.<子>` 提上来(不递归,避免膨胀超 maxChars)。
        for (const [ck, cv] of Object.entries(v)) addScalar(`${k}.${ck}`, cv);
      }
    }
    const json = redactedSerializedText(compact);
    if (json.length <= maxChars) return json;
  }
  return redactedToolResultPreview(value, maxChars);
}

export function summarizeToolValue(value: unknown, maxBytes = getToolIoMaxBytes()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    const redacted = redactSensitiveText(value);
    const truncated = truncateUtf8(redacted, maxBytes);
    return truncated.truncated
      ? {
          value: truncated.text,
          truncated: true,
          originalBytes: truncated.originalBytes,
          maxBytes,
        }
      : redacted;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  try {
    const json = JSON.stringify(value, redactedJsonReplacer);
    if (json === undefined) throw new Error("Unable to serialize tool value");
    const truncated = truncateUtf8(json, maxBytes);
    return truncated.truncated
      ? {
          value: truncated.text,
          truncated: true,
          originalBytes: truncated.originalBytes,
          maxBytes,
          encoding: "json",
        }
      : JSON.parse(json);
  } catch {
    const text = redactSensitiveText(String(value));
    const truncated = truncateUtf8(text, maxBytes);
    return truncated.truncated
      ? {
          value: truncated.text,
          truncated: true,
          originalBytes: truncated.originalBytes,
          maxBytes,
        }
      : text;
  }
}

export function truncateLargeStrings(
  value: unknown,
  limit = LLM_IO_FIELD_LIMIT,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") {
    return value.length > limit
      ? `${value.slice(0, limit)}${LLM_IO_TRUNCATED_SUFFIX}`
      : value;
  }
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;

  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => truncateLargeStrings(item, limit, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = truncateLargeStrings(nested, limit, seen);
  }
  return out;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
