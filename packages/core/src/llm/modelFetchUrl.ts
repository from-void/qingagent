import { validateFetchUrl } from "@qingagent/doc-render/fetch-url";

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
