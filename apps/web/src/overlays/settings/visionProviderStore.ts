// 图像识别副基模(多模态)配置:visitor 层,随请求 header(x-vision-*)透传,服务端不落盘
// ——与主模型 visitor key 同哲学(见 visitorKeyStore.ts)。持久化后端经 clientPersist:
// 桌面端落 userData(打包后不丢)、web 端仍用 localStorage。
// DeepSeek 暂不支持多模态,故现在只接第三方多模态厂商;待 DeepSeek 原生支持后复用主模型 key。

import { readPersisted, writePersistedAwaited } from "./clientPersist";

const VISION_PROVIDER_KEY = "qingagent.vision_provider";

const DEFAULT_PROTOCOL = "openai";

/** 副基模配置(契约 C)。enabled 关闭时 header 不透传、Agent 视为未配置。 */
export interface VisionProvider {
  enabled: boolean;
  protocol: "openai" | "anthropic";
  baseUrl: string;
  apiKey: string;
  model: string;
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

export function readVisionProvider(): VisionProvider | null {
  try {
    const raw = readPersisted(VISION_PROVIDER_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as Partial<VisionProvider>;
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

export function writeVisionProvider(v: VisionProvider): Promise<boolean> {
  return writePersistedAwaited(VISION_PROVIDER_KEY, JSON.stringify(v));
}

export function clearVisionProvider(): Promise<boolean> {
  return writePersistedAwaited(VISION_PROVIDER_KEY, null);
}

/** 给请求层用:仅当已配置且启用时,返回要附加的 x-vision-* header(契约 A)。 */
export function visionKeyHeaders(): Record<string, string> {
  const v = readVisionProvider();
  if (!v || !v.enabled) return {};
  return {
    "x-vision-key": v.apiKey,
    "x-vision-base-url": v.baseUrl,
    "x-vision-model": v.model,
    "x-vision-protocol": v.protocol,
  };
}

export const DEFAULT_VISION_PROTOCOL = DEFAULT_PROTOCOL;
