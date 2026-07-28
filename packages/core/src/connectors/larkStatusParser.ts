export interface ParsedLarkConfig {
  configured: boolean;
  appIdShape: string | null;
  brand: string | null;
}

export interface ParsedLarkAuthStatus {
  connected: boolean;
  needsReauth: boolean;
  account: { id?: string; displayName: string } | null;
  scopes: string[] | null;
}

export interface ParsedLarkDeviceFlow {
  verificationUrl: string;
  /** 真实 CLI 顶层可能不带 user_code(嵌在 verification_url 查询参数里),可为 null。 */
  userCode: string | null;
  deviceCode: string;
  expiresIn: number;
}

export type LarkParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; reasonCode: "LARK_CLI_DIRTY_OUTPUT"; message: string };

function extractFirstJsonObject(input: string): unknown {
  const start = input.indexOf("{");
  if (start < 0) throw new Error("缺少 JSON 对象");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < input.length; index += 1) {
    const char = input[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(input.slice(start, index + 1));
    }
  }
  throw new Error("JSON 对象被截断");
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(value: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const field = value[key];
    if (typeof field === "string" && field.trim()) return field.trim();
  }
  return null;
}

function dirty<T>(error: unknown): LarkParseResult<T> {
  return {
    ok: false,
    reasonCode: "LARK_CLI_DIRTY_OUTPUT",
    message: error instanceof Error ? error.message : "无法解析 lark-cli 输出",
  };
}

export function parseLarkConfigOutput(output: string): LarkParseResult<ParsedLarkConfig> {
  try {
    const root = record(extractFirstJsonObject(output));
    if (!root) throw new Error("config 根节点不是对象");
    const appId = stringField(root, "appId", "app_id");
    const brand = stringField(root, "brand");
    // appId 缺失是合法的“未配置”，但字段类型错误是脏输出。
    if (("appId" in root && root.appId !== null && typeof root.appId !== "string") ||
        ("app_id" in root && root.app_id !== null && typeof root.app_id !== "string")) {
      throw new Error("config.appId 类型非法");
    }
    return {
      ok: true,
      value: {
        configured: Boolean(appId),
        appIdShape: appId ? appId.replace(/[A-Za-z0-9](?=.{4})/g, "*") : null,
        brand,
      },
    };
  } catch (error) {
    return dirty(error);
  }
}

const LARK_CONNECTED_STATUSES = ["ready", "needs_refresh", "active", "valid"];
const LARK_NEEDS_REAUTH_STATUSES = [
  "expired",
  "revoked",
  "invalid",
  "unauthorized",
  "needs_reauth",
];

export function parseLarkAuthStatusOutput(output: string): LarkParseResult<ParsedLarkAuthStatus> {
  try {
    const root = record(extractFirstJsonObject(output));
    const identities = root && record(root.identities);
    const user = identities && record(identities.user);
    if (!root || !identities || !user) throw new Error("auth status 缺少 identities.user");
    const status = stringField(user, "status", "tokenStatus", "token_status");
    if (!status || typeof user.available !== "boolean") {
      throw new Error("auth status 核心状态字段缺失");
    }
    const normalized = status.toLowerCase();
    const connected = user.available && LARK_CONNECTED_STATUSES.includes(normalized);
    // 真实 lark-cli(实测 1.0.65 `auth status --json`)在用户身份不可用时一律给
    // status:"missing";光看 status 分不出"从没登录过"和"令牌过期了",而 token 维度
    // (tokenStatus:"expired"/"revoked")才是那条真信号。旧逻辑只认 status,过期账号
    // 会被判成 needsReauth:false。这里改成:status 不是已知连接态时回退看 token 维度;
    // 没有 token 痕迹的 missing 仍是"未连接",不谎称"授权已失效"。
    const tokenStatus = stringField(user, "tokenStatus", "token_status")?.toLowerCase() ?? null;
    const needsReauth = LARK_NEEDS_REAUTH_STATUSES.includes(normalized) ||
      (!LARK_CONNECTED_STATUSES.includes(normalized) &&
        tokenStatus !== null &&
        LARK_NEEDS_REAUTH_STATUSES.includes(tokenStatus));
    const userName = stringField(user, "userName", "user_name");
    const openId = stringField(user, "openId", "open_id");
    const rawScopes = user.scope ?? user.scopes;
    let scopes: string[] | null = null;
    if (typeof rawScopes === "string") {
      scopes = rawScopes.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
    } else if (Array.isArray(rawScopes) && rawScopes.every((item) => typeof item === "string")) {
      scopes = rawScopes.map((item) => item.trim()).filter(Boolean);
    }
    return {
      ok: true,
      value: {
        connected,
        needsReauth,
        account: userName || openId
          ? { ...(openId ? { id: openId } : {}), displayName: userName ?? openId! }
          : null,
        // scopes 解析失败不推翻核心授权状态。
        scopes,
      },
    };
  } catch (error) {
    return dirty(error);
  }
}

export function parseLarkDeviceFlowOutput(output: string): LarkParseResult<ParsedLarkDeviceFlow> {
  try {
    const root = record(extractFirstJsonObject(output));
    if (!root) throw new Error("device flow 根节点不是对象");
    const verificationUrl = stringField(root, "verification_url", "verification_uri", "verificationUrl");
    const deviceCode = stringField(root, "device_code", "deviceCode");
    const expiresIn = root.expires_in ?? root.expiresIn;
    // user_code 不是必填:真实 lark-cli(实测 1.0.53 `auth login --no-wait --json`)顶层
    // 只有 device_code/expires_in/hint/verification_url,user_code 仅作为查询参数嵌在
    // verification_url 里。此前把它当必填导致飞书授权在真机上必死(核心字段缺失)。
    if (!verificationUrl || !deviceCode || typeof expiresIn !== "number" ||
        !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error("device flow 核心字段缺失或类型非法");
    }
    const url = new URL(verificationUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("verification_url 协议非法");
    const userCode = stringField(root, "user_code", "userCode") ??
      (url.searchParams.get("user_code")?.trim() || null);
    return { ok: true, value: { verificationUrl, userCode, deviceCode, expiresIn } };
  } catch (error) {
    return dirty(error);
  }
}
