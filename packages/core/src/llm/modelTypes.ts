/** 模型密钥的实际来源；独立于 provider 与 DB，供记账边界共享。 */
export type ApiKeyOrigin = "visitor" | "global-db" | "env" | "vision" | "none";

export type DeepseekTier = "flash" | "pro";

/** 模型 id 的无副作用叶子定义，避免计价与模型工厂形成循环依赖。 */
export const DEEPSEEK_MODEL_IDS: Record<DeepseekTier, string> = {
  flash: "deepseek-v4-flash",
  pro: "deepseek-v4-pro",
};

/** Kimi 只开放两档:Flash → K2.7 Code,Pro → K3。 */
export const KIMI_MODEL_IDS: Record<DeepseekTier, string> = {
  flash: "kimi-for-coding",
  pro: "k3",
};

/** 与 ModelProvider 保持同步；null=不支持，"main"=复用主模型 id，其余=固定视觉模型 id。 */
export const NATIVE_VISION_MODEL = {
  kimi: "main",
  deepseek: "deepseek-v4-flash-vision-exp",
} as const satisfies Record<"deepseek" | "kimi", "main" | string | null>;
