/** 模型密钥的实际来源；独立于 provider 与 DB，供记账边界共享。 */
export type ApiKeyOrigin = "visitor" | "global-db" | "env" | "vision" | "none";
