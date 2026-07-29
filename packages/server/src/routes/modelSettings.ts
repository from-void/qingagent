import { Hono } from "hono";
import {
  DEEPSEEK_MODEL_IDS,
  KIMI_BASE_URL,
  KIMI_MODEL_IDS,
  SETTING_DEEPSEEK_GLOBAL_KEY,
  SETTING_KIMI_GLOBAL_KEY,
  SETTING_MODEL_PROVIDER,
  SETTING_MODEL_PARAMS,
  deleteAppSetting,
  getAppSetting,
  modelFetch,
  sanitizeBaseUrl,
  sanitizeModelId,
  setAppSetting,
  testVisionConnection,
  testTextModelConnection,
  validateModelFetchUrl,
  VISION_TEST_TIMEOUT_MS,
  allowGlobalModelFallback,
  type ModelProtocol,
  type ModelProvider,
  type ModelParamOverrides,
} from "@qingagent/core";
import { z } from "zod";
import { invalidateModelOverridesCache, resolveRequestModelOverrides } from "../modelOverridesProvider";
import { requireTrustedOrigin } from "../lib/trustedOrigin";
import { parseBody } from "../lib/validation";

export const modelSettingsRoutes = new Hono();

/** PUT /settings/model 外层:任意字符串键对象(apiKey/params 条件校验在 handler 内保留)。 */
const modelSettingsBodySchema = z.record(z.string(), z.unknown());

/** POST /settings/model/test-custom 请求体(字段沿用旧内联形状,均可选字符串)。 */
const testCustomBodySchema = z.object({
  provider: z.string().optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  protocol: z.string().optional(),
  model: z.string().optional(),
});

const MAX_OUTPUT_TOKENS_LIMIT = 384_000;
const BALANCE_FETCH_TIMEOUT_MS = 10_000;

type VisionTestErrorKind =
  | "missing_key"
  | "invalid_config"
  | "auth"
  | "network"
  | "timeout"
  | "ssrf_blocked"
  | "unsupported_media"
  | "model_error";

type VisionTestBody = {
  protocol: ModelProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
};

function maskTail(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.slice(-4);
}

function parseModelProvider(raw: unknown): ModelProvider | null {
  return raw === "deepseek" || raw === "kimi" ? raw : null;
}

function isConnectionTimeout(error: unknown): boolean {
  return error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError");
}

function sanitizeApiKey(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "apiKey must be a string" };
  const value = raw.trim();
  if (!value) return { ok: true, value: "" };
  if (value.length > 200) return { ok: false, error: "apiKey is too long" };
  if (!/^[\x21-\x7e]+$/.test(value)) {
    return { ok: false, error: "apiKey contains invalid characters" };
  }
  return { ok: true, value };
}

async function isFetchSafeBaseUrl(baseUrl: string): Promise<boolean> {
  try {
    await validateModelFetchUrl(baseUrl);
    return true;
  } catch {
    return false;
  }
}

function parseStoredParams(raw: string | null): ModelParamOverrides {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") return {};
    const record = parsed as Record<string, unknown>;
    const params: ModelParamOverrides = {};
    if (typeof record.temperature === "number" && Number.isFinite(record.temperature)) {
      params.temperature = record.temperature;
    }
    if (typeof record.topP === "number" && Number.isFinite(record.topP)) {
      params.topP = record.topP;
    }
    if (
      typeof record.maxOutputTokens === "number" &&
      Number.isInteger(record.maxOutputTokens)
    ) {
      params.maxOutputTokens = record.maxOutputTokens;
    }
    return params;
  } catch {
    return {};
  }
}

function validateParams(raw: unknown): { ok: true; value: ModelParamOverrides } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: {} };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "params must be an object" };
  }
  const record = raw as Record<string, unknown>;
  // R5-B:未知字段从静默忽略改为显式 4xx(防恶意/拼错字段被吞,契约更清晰)。
  const KNOWN_PARAM_KEYS = new Set(["temperature", "topP", "maxOutputTokens"]);
  const unknownKeys = Object.keys(record).filter((k) => !KNOWN_PARAM_KEYS.has(k));
  if (unknownKeys.length > 0) {
    const preview = unknownKeys.slice(0, 5).join(", ");
    return {
      ok: false,
      error: `params contains unknown field(s): ${preview}${unknownKeys.length > 5 ? ` (+${unknownKeys.length - 5} more)` : ""}`,
    };
  }
  const params: ModelParamOverrides = {};
  if (record.temperature !== undefined) {
    if (
      typeof record.temperature !== "number" ||
      !Number.isFinite(record.temperature) ||
      record.temperature < 0 ||
      record.temperature > 2
    ) {
      return { ok: false, error: "params.temperature must be between 0 and 2" };
    }
    params.temperature = record.temperature;
  }
  if (record.topP !== undefined) {
    if (
      typeof record.topP !== "number" ||
      !Number.isFinite(record.topP) ||
      record.topP < 0 ||
      record.topP > 1
    ) {
      return { ok: false, error: "params.topP must be between 0 and 1" };
    }
    params.topP = record.topP;
  }
  if (record.maxOutputTokens !== undefined) {
    if (
      typeof record.maxOutputTokens !== "number" ||
      !Number.isInteger(record.maxOutputTokens) ||
      record.maxOutputTokens < 1 ||
      record.maxOutputTokens > MAX_OUTPUT_TOKENS_LIMIT
    ) {
      return {
        ok: false,
        error: `params.maxOutputTokens must be an integer between 1 and ${MAX_OUTPUT_TOKENS_LIMIT}`,
      };
    }
    params.maxOutputTokens = record.maxOutputTokens;
  }
  return { ok: true, value: params };
}

function parseVisionTestBody(raw: unknown): { ok: true; value: VisionTestBody } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Body must be an object" };
  }
  const record = raw as Record<string, unknown>;
  for (const field of ["protocol", "baseUrl", "apiKey", "model"] as const) {
    if (typeof record[field] !== "string") {
      return { ok: false, error: `${field} must be a string` };
    }
  }
  if (record.protocol !== "openai" && record.protocol !== "anthropic") {
    return { ok: false, error: "protocol must be openai or anthropic" };
  }
  const protocol = record.protocol as ModelProtocol;
  const baseUrl = record.baseUrl as string;
  const apiKey = record.apiKey as string;
  const model = record.model as string;
  return {
    ok: true,
    value: {
      protocol,
      baseUrl,
      apiKey,
      model,
    },
  };
}

function classifyVisionTestError(error: unknown): { kind: VisionTestErrorKind; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const status = typeof record.statusCode === "number"
    ? record.statusCode
    : typeof record.status === "number"
      ? record.status
      : undefined;
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return { kind: "timeout", message: `连接超时(${VISION_TEST_TIMEOUT_MS}ms)` };
  }
  if (/Blocked (?:private|loopback)|private hostname|private IPv[46]/i.test(message)) {
    return { kind: "ssrf_blocked", message };
  }
  if (status === 401 || status === 403 || /\b(401|403)\b|unauthorized|forbidden|api key|apikey|authentication/i.test(message)) {
    return { kind: "auth", message };
  }
  if (/unsupported.*(media|image)|invalid.*image|content.*image/i.test(message)) {
    return { kind: "unsupported_media", message };
  }
  if (/fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|getaddrinfo|network|Could not resolve|socket|TLS/i.test(message)) {
    return { kind: "network", message };
  }
  return { kind: "model_error", message };
}

async function readModelSettingsResponse() {
  const [providerRaw, deepseekDbKey, kimiDbKey, paramsRaw] = await Promise.all([
    getAppSetting(SETTING_MODEL_PROVIDER),
    getAppSetting(SETTING_DEEPSEEK_GLOBAL_KEY),
    getAppSetting(SETTING_KIMI_GLOBAL_KEY),
    getAppSetting(SETTING_MODEL_PARAMS),
  ]);
  const allowGlobalFallback = allowGlobalModelFallback();
  const provider = allowGlobalFallback
    ? parseModelProvider(providerRaw) ??
      parseModelProvider(process.env.QINGAGENT_MODEL_PROVIDER) ??
      "deepseek"
    : "deepseek";
  const providerState = (target: ModelProvider) => {
    const dbKey = allowGlobalFallback
      ? target === "kimi" ? kimiDbKey : deepseekDbKey
      : null;
    const envKey = allowGlobalFallback
      ? target === "kimi"
        ? process.env.KIMI_API_KEY ?? ""
        : process.env.DEEPSEEK_API_KEY ?? ""
      : "";
    const effectiveKey = dbKey || envKey || "";
    return {
      apiKeyConfigured: Boolean(effectiveKey),
      maskedTail: maskTail(effectiveKey),
      source: dbKey ? "db" as const : envKey ? "env" as const : "none" as const,
    };
  };
  const active = providerState(provider);
  return {
    provider,
    ...active,
    providers: {
      deepseek: providerState("deepseek"),
      kimi: providerState("kimi"),
    },
    params: parseStoredParams(paramsRaw),
  };
}

modelSettingsRoutes.get("/settings/model", async (c) => {
  return c.json(await readModelSettingsResponse());
});

modelSettingsRoutes.put("/settings/model", async (c) => {
  const rejected = requireTrustedOrigin(c);
  if (rejected) return rejected;

  const parsed = await parseBody(c, modelSettingsBodySchema, {
    makeErrorResponse: (ctx, b) =>
      ctx.json({ error: b.error === "Invalid JSON body" ? "Invalid JSON body" : "Body must be an object" }, 400),
  });
  if (!parsed.ok) return parsed.response;
  const record = parsed.data;
  const currentSettings = await readModelSettingsResponse();
  const requestedProvider = "provider" in record
    ? parseModelProvider(record.provider)
    : currentSettings.provider;
  if (!requestedProvider) {
    return c.json({ error: "provider must be deepseek or kimi" }, 400);
  }

  const parsedKey = "apiKey" in record ? sanitizeApiKey(record.apiKey) : null;
  if (parsedKey && !parsedKey.ok) return c.json({ error: parsedKey.error }, 400);
  const parsedParams = "params" in record ? validateParams(record.params) : null;
  if (parsedParams && !parsedParams.ok) return c.json({ error: parsedParams.error }, 400);

  if ("provider" in record) {
    await setAppSetting(SETTING_MODEL_PROVIDER, requestedProvider);
  }

  if (parsedKey?.ok) {
    const settingKey = requestedProvider === "kimi"
      ? SETTING_KIMI_GLOBAL_KEY
      : SETTING_DEEPSEEK_GLOBAL_KEY;
    if (parsedKey.value) {
      await setAppSetting(settingKey, parsedKey.value);
    } else {
      await deleteAppSetting(settingKey);
    }
  }

  if (parsedParams?.ok) {
    await setAppSetting(SETTING_MODEL_PARAMS, JSON.stringify(parsedParams.value));
  }

  invalidateModelOverridesCache();
  return c.json(await readModelSettingsResponse());
});


// DeepSeek 走官方余额接口；Kimi 无余额接口，显式触发时改走一次最短文本连接测试。
// 双用途:① DeepSeek 设置页展示余额;② 「测试 key」——DeepSeek 401 即 key 无效,给出明确指引(R5 发现
// 无效 key 被归为"网络异常"误导用户,这里在源头给准确反馈)。
// key 解析与对话同一优先级:visitor header > global-db > env;响应绝不回传 key。
modelSettingsRoutes.get("/settings/model/balance", async (c) => {
  const rejected = requireTrustedOrigin(c);
  if (rejected) return rejected;

  const overrides = await resolveRequestModelOverrides({
    provider: c.req.header("x-model-provider"),
    visitorKey: c.req.header("x-model-key") ?? c.req.header("x-deepseek-key"),
    baseUrl: c.req.header("x-model-base-url"),
    modelFlash: c.req.header("x-model-flash"),
    modelPro: c.req.header("x-model-pro"),
    modelTier: c.req.header("x-model-tier"),
    protocol: c.req.header("x-model-protocol"),
    visionKey: c.req.header("x-vision-key"),
    visionBaseUrl: c.req.header("x-vision-base-url"),
    visionModel: c.req.header("x-vision-model"),
    visionProtocol: c.req.header("x-vision-protocol"),
  });
  const provider = overrides.provider ?? "deepseek";
  const envKey = allowGlobalModelFallback()
    ? provider === "kimi"
      ? process.env.KIMI_API_KEY ?? ""
      : process.env.DEEPSEEK_API_KEY ?? ""
    : "";
  const apiKey = overrides.visitorApiKey ?? overrides.globalApiKey ?? envKey;
  const keySource = overrides.visitorApiKey ? "visitor" : overrides.globalApiKey ? "db" : apiKey ? "env" : "none";
  if (!apiKey) {
    return c.json({ ok: false, keySource, error: "尚未配置 API Key" }, 400);
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BALANCE_FETCH_TIMEOUT_MS);
    try {
      if (provider === "kimi") {
        const baseUrl = overrides.baseUrl ?? KIMI_BASE_URL;
        try {
          await testTextModelConnection({
            provider,
            apiKey,
            baseUrl,
            model: overrides.modelIds?.[
              overrides.tier === "pro" ? "pro" : "flash"
            ] ?? KIMI_MODEL_IDS[overrides.tier === "pro" ? "pro" : "flash"],
            protocol: "openai",
            timeoutMs: BALANCE_FETCH_TIMEOUT_MS,
          });
        } catch (error) {
          const status = typeof error === "object" && error && "statusCode" in error
            ? Number((error as { statusCode?: unknown }).statusCode)
            : typeof error === "object" && error && "status" in error
              ? Number((error as { status?: unknown }).status)
              : 0;
          if (status !== 401 && status !== 403) throw error;
          return c.json({
            ok: false,
            keySource,
            permissionDenied: true,
            error: "Kimi 返回权限不足；401/403 也可能是套餐权限限制，请核对套餐与模型权限",
          }, 200);
        }
        return c.json({
          ok: true,
          keySource,
          provider,
          balanceUnsupported: true,
          balances: [],
        });
      }
      const res = await modelFetch("https://api.deepseek.com/user/balance", {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      if (res.status === 401 || res.status === 403) {
        return c.json({ ok: false, keySource, keyInvalid: true, error: "API Key 无效或已过期,请检查后重新填写" }, 200);
      }
      if (!res.ok) {
        return c.json({ ok: false, keySource, error: `DeepSeek 返回 ${res.status}` }, 200);
      }
      const body = (await res.json()) as {
        is_available?: boolean;
        balance_infos?: Array<{ currency?: string; total_balance?: string; granted_balance?: string; topped_up_balance?: string }>;
      };
      return c.json({
        ok: true,
        keySource,
        isAvailable: body.is_available ?? null,
        balances: (body.balance_infos ?? []).map((b) => ({
          currency: b.currency ?? "",
          total: b.total_balance ?? "",
          granted: b.granted_balance ?? "",
          toppedUp: b.topped_up_balance ?? "",
        })),
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return c.json({
      ok: false,
      keySource,
      error: isConnectionTimeout(err)
        ? "查询超时,请稍后重试"
        : `无法连接 ${provider === "kimi" ? "Kimi" : "DeepSeek"},请检查网络`,
    }, 200);
  }
});

// 测试自定义 provider(其他云厂商)连通性:服务端代理调 {baseUrl}/models,避免浏览器 CORS。
modelSettingsRoutes.post("/settings/model/test-custom", async (c) => {
  const rejected = requireTrustedOrigin(c);
  if (rejected) return rejected;

  const parsedBody = await parseBody(c, testCustomBodySchema, {
    makeErrorResponse: (ctx, b) =>
      ctx.json({ ok: false, error: b.error === "Invalid JSON body" ? "请求格式错误" : b.error }, 400),
    invalidJsonMessage: "请求格式错误",
  });
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  const provider = parseModelProvider(body.provider) ?? "deepseek";
  const rawBaseUrl = (body.baseUrl ?? "").trim();
  const apiKey = (body.apiKey ?? "").trim();
  if (!rawBaseUrl || !apiKey) {
    return c.json({ ok: false, error: "缺少 API 地址或 key" });
  }
  // 与运行时(modelConfig.resolveBaseUrl)共用同一个归一化:补 /v1、剥多填的 endpoint 段、去 query/hash。
  // 否则会出现"测试通过、对话仍 404"(测的和实际跑的 baseURL 口径不一致)。
  const baseUrl = sanitizeBaseUrl(rawBaseUrl);
  if (!baseUrl) {
    return c.json({ ok: false, error: "API 地址需以 http(s):// 开头且为合法地址" });
  }
  if (!(await isFetchSafeBaseUrl(baseUrl))) {
    return c.json({
      ok: false,
      error:
        "API 地址不可用或被安全策略拒绝：仅允许公网地址及本机 localhost/127.0.0.1/[::1]；" +
        "内网、链路本地和云元数据地址默认禁止。" +
        "若这是公司或自建的内网模型服务：桌面客户端请更新到最新版（已默认放行）；" +
        "自部署请设置 QINGAGENT_ALLOW_PRIVATE_MODEL_HOST=1",
    }, 400);
  }
  const isAnthropic = provider === "deepseek" && body.protocol === "anthropic";
  const model = (body.model ?? "").trim() ||
    (provider === "kimi"
      ? KIMI_MODEL_IDS.flash
      : isAnthropic ? "glm-4.6" : DEEPSEEK_MODEL_IDS.flash);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    if (isAnthropic) {
      // anthropic 无 /models；通过 core 模型工厂发最小请求，顺带统一 usage/missing 账本。
      try {
        await testTextModelConnection({ apiKey, baseUrl, model, protocol: "anthropic", timeoutMs: 12_000 });
        return c.json({ ok: true, normalizedBaseUrl: baseUrl });
      } catch (error) {
        const status = typeof error === "object" && error && "statusCode" in error
          ? Number((error as { statusCode?: unknown }).statusCode)
          : 0;
        if (status === 401 || status === 403) return c.json({ ok: false, keyInvalid: true });
        throw error;
      }
    }
    if (provider === "kimi") {
      try {
        await testTextModelConnection({
          provider,
          apiKey,
          baseUrl,
          model,
          protocol: "openai",
          timeoutMs: 12_000,
        });
        return c.json({ ok: true, normalizedBaseUrl: baseUrl });
      } catch (error) {
        const status = typeof error === "object" && error && "statusCode" in error
          ? Number((error as { statusCode?: unknown }).statusCode)
          : typeof error === "object" && error && "status" in error
            ? Number((error as { status?: unknown }).status)
            : 0;
        if (status === 401 || status === 403) {
          return c.json({
            ok: false,
            permissionDenied: true,
            error: "Kimi 401/403 可能是套餐权限不足",
          });
        }
        throw error;
      }
    }
    // openai 兼容:归一化后已是 host/vN;再兜底探一个去版本段的根(少数 provider 把 /models 放在根)。
    // 关键:401/403 不立刻判 keyInvalid,先试完所有候选——只有全候选都失败且出现过认证错误才报 key 问题。
    const candidates = [baseUrl];
    const rootNoVer = baseUrl.replace(/\/v\d+$/, "");
    if (rootNoVer !== baseUrl) candidates.push(rootNoVer);
    let authFailed = false;
    let lastStatus = 0;
    for (const base of candidates) {
      const res = await modelFetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      if (res.ok) return c.json({ ok: true, normalizedBaseUrl: baseUrl });
      if (res.status === 401 || res.status === 403) {
        authFailed = true;
        lastStatus = res.status;
        continue;
      }
      lastStatus = res.status;
    }
    if (authFailed) return c.json({ ok: false, keyInvalid: true });
    return c.json({ ok: false, error: `接口返回 HTTP ${lastStatus}` });
  } catch (err) {
    return c.json({
      ok: false,
      error: isConnectionTimeout(err) ? "连接超时(10s)" : "无法连接该地址",
    });
  } finally {
    clearTimeout(timer);
  }
});

modelSettingsRoutes.post("/settings/vision/test", async (c) => {
  const rejected = requireTrustedOrigin(c);
  if (rejected) return rejected;

  const rawBody = await parseBody(c, z.unknown(), {
    makeErrorResponse: (ctx) =>
      ctx.json({ ok: false, errorKind: "invalid_config", message: "Invalid JSON body" }, 400),
  });
  if (!rawBody.ok) return rawBody.response;
  const parsed = parseVisionTestBody(rawBody.data);
  if (!parsed.ok) {
    return c.json({ ok: false, errorKind: "invalid_config", message: parsed.error }, 400);
  }

  const apiKeyResult = sanitizeApiKey(parsed.value.apiKey);
  if (!apiKeyResult.ok) {
    return c.json({ ok: false, errorKind: "invalid_config", message: apiKeyResult.error }, 200);
  }
  if (!apiKeyResult.value) {
    return c.json({ ok: false, errorKind: "missing_key", message: "缺少 API key" }, 200);
  }
  const baseUrl = sanitizeBaseUrl(parsed.value.baseUrl);
  const model = sanitizeModelId(parsed.value.model);
  if (!baseUrl || !model) {
    return c.json({ ok: false, errorKind: "invalid_config", message: "API 地址或模型名格式不合法" }, 200);
  }

  try {
    await testVisionConnection({
      apiKey: apiKeyResult.value,
      baseUrl,
      model,
      protocol: parsed.value.protocol,
    }, c.req.raw.signal);
    // 回传归一化地址:客户端保存的必须是"实际被请求的那个地址",而不是用户原始输入。
    return c.json({ ok: true, normalizedBaseUrl: baseUrl });
  } catch (error) {
    const classified = classifyVisionTestError(error);
    return c.json({ ok: false, errorKind: classified.kind, message: classified.message }, 200);
  }
});
