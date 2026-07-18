import {
  assertFetchAddressAllowed,
  validateFetchUrl,
} from "@qingagent/doc-render/fetch-url";

export const ALLOW_PRIVATE_MODEL_HOST_ENV = "QINGAGENT_ALLOW_PRIVATE_MODEL_HOST";

type Env = Readonly<Record<string, string | undefined>>;

export function allowsPrivateModelHost(env: Env = process.env): boolean {
  return env[ALLOW_PRIVATE_MODEL_HOST_ENV] === "1";
}

/** 主模型出站统一策略：本机模型合法，私网/链路本地默认拒绝，部署者可显式放行。 */
export function validateModelFetchUrl(rawUrl: string, env: Env = process.env): Promise<URL> {
  return validateFetchUrl(rawUrl, {
    allowLoopback: true,
    allowPrivate: allowsPrivateModelHost(env),
  });
}

/** 供连接层 DNS 固定器复用同一地址范围与 loopback/逃生舱语义。 */
export function assertModelFetchAddressAllowed(
  address: string,
  sourceHostname: string,
  env: Env = process.env,
): void {
  assertFetchAddressAllowed(address, sourceHostname, {
    allowLoopback: true,
    allowPrivate: allowsPrivateModelHost(env),
  });
}
