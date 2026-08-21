// 图像识别副基模(多模态)配置:visitor 层,随请求 header(x-vision-*)透传,服务端不落盘
// ——与主模型 visitor key 同哲学(见 visitorKeyStore.ts)。持久化后端经 clientPersist:
// 桌面端落 userData(打包后不丢)、web 端仍用 localStorage。
// DeepSeek/Kimi 均原生支持,显式第三方配置仍优先。

import { readPersisted, writePersistedAwaited } from "./clientPersist";

const VISION_PROVIDER_KEY = "qingagent.vision_provider";

const DEFAULT_PROTOCOL = "openai";

export type VisionSource = "deepseek" | "kimi" | "custom";

/** 副基模配置(契约 C)。enabled 关闭时 header 不透传、Agent 视为未配置。 */
export interface VisionProvider {
  enabled: boolean;
  protocol: "openai" | "anthropic";
  baseUrl: string;
  apiKey: string;
  model: string;
}

type VisionProviderRecord = Partial<VisionProvider> & { source?: unknown };

function readVisionProviderRecord(): VisionProviderRecord | null {
  try {
    const raw = readPersisted(VISION_PROVIDER_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as unknown;
    return value !== null && typeof value === "object"
      ? value as VisionProviderRecord
      : null;
  } catch {
    return null;
  }
}

function normalizeProtocol(raw: unknown): "openai" | "anthropic" {
  return raw === "anthropic" ? "anthropic" : "openai";
}

/** 读取已保存的副基模配置;字段不全(缺 baseUrl/key/model)视为未配置返回 null。 */
/** baseUrl 必须是合法 http(s) URL,否则视为未配置(防脏值塞进 x-vision-* header)。 */
export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * 唯一一种"可修复的格式错误":用户只填了 `host/v1`(漏掉 http(s)://)。
 * 能补 `https://` 补成合法地址就返回补齐值,否则返回 null(真格式错,照旧按非法提示)。
 * 刻意收窄,别把任意串都当可修复:
 * ① 已带任意 scheme(含 ftp:// 之类)一律不改写;
 * ② 补齐后主机名必须像个主机——带点、或 localhost、或显式端口,
 *    否则 `not-a-url` 这类明显笔误也会被 new URL 认成合法主机。
 */
export function repairBaseUrlScheme(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (isHttpUrl(trimmed)) return trimmed;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/.exec(trimmed);
  // 冒号后是纯数字端口(如 localhost:11434/v1)不算 scheme,仍可补;其余已带 scheme 的不改写。
  if (scheme && !/^\d+(?:\/|$)/.test(scheme[2] ?? "")) return null;
  const repaired = `https://${trimmed}`;
  if (!isHttpUrl(repaired)) return null;
  try {
    const url = new URL(repaired);
    const host = url.hostname.toLowerCase();
    const hostLike = host.includes(".") || host === "localhost" || url.port !== "";
    return hostLike ? repaired : null;
  } catch {
    return null;
  }
}

export function readVisionProvider(): VisionProvider | null {
  try {
    const o = readVisionProviderRecord();
    if (
      !o ||
      typeof o.baseUrl !== "string" ||
      typeof o.apiKey !== "string" ||
      typeof o.model !== "string"
    ) {
      return null;
    }
    // 归一化:trim 全部字段;baseUrl 校验 http(s);任一为空/非法 → 视为未配置。
    const baseUrl = o.baseUrl.trim();
    const apiKey = o.apiKey.trim();
    const model = o.model.trim();
    if (!apiKey || !model || !isHttpUrl(baseUrl)) return null;
    return {
      enabled: o.enabled !== false,
      protocol: normalizeProtocol(o.protocol),
      baseUrl,
      apiKey,
      model,
    };
  } catch {
    return null;
  }
}

/** source 与自定义表单共用 qingagent.vision_provider，不引入新的顶层持久化键。 */
export function readVisionSource(): VisionSource | null {
  const source = readVisionProviderRecord()?.source;
  return source === "deepseek" || source === "kimi" || source === "custom"
    ? source
    : null;
}

export function writeVisionProvider(v: VisionProvider): Promise<boolean> {
  const source = readVisionSource();
  return writePersistedAwaited(
    VISION_PROVIDER_KEY,
    JSON.stringify({ ...v, ...(source ? { source } : {}) }),
  );
}

export function writeVisionSource(source: VisionSource): Promise<boolean> {
  const custom = readVisionProvider();
  return writePersistedAwaited(
    VISION_PROVIDER_KEY,
    JSON.stringify({ ...(custom ?? {}), source }),
  );
}

export function clearVisionProvider(): Promise<boolean> {
  const source = readVisionSource();
  return writePersistedAwaited(
    VISION_PROVIDER_KEY,
    source ? JSON.stringify({ source }) : null,
  );
}

/** 给请求层用：source 缺省保持旧 header；原生 source 只附对应官方 visitor key。 */
export function visionKeyHeaders(
  officialKeys: Partial<Record<"deepseek" | "kimi", string | null | undefined>> = {},
): Record<string, string> {
  const source = readVisionSource();
  if (source === "deepseek" || source === "kimi") {
    const apiKey = officialKeys[source]?.trim();
    return {
      "x-vision-source": source,
      ...(apiKey ? { "x-vision-key": apiKey } : {}),
    };
  }
  const v = readVisionProvider();
  if (source === "custom") {
    if (!v || !v.enabled) return { "x-vision-source": "custom" };
    return {
      "x-vision-source": "custom",
      "x-vision-key": v.apiKey,
      "x-vision-base-url": v.baseUrl,
      "x-vision-model": v.model,
      "x-vision-protocol": v.protocol,
    };
  }
  if (!v || !v.enabled) return {};
  return {
    "x-vision-key": v.apiKey,
    "x-vision-base-url": v.baseUrl,
    "x-vision-model": v.model,
    "x-vision-protocol": v.protocol,
  };
}

export const DEFAULT_VISION_PROTOCOL = DEFAULT_PROTOCOL;
