export interface ConnectorRuntimeCapabilityDto {
  mutationEnabled: boolean;
  reasonCode:
    | null
    | "CONNECTORS_DISABLED"
    | "PUBLIC_DEPLOYMENT"
    | "SINGLE_USER_OPT_IN_REQUIRED"
    | "AUTH_TOKEN_REQUIRED";
}

export class ConnectorMutationForbiddenError extends Error {
  readonly status = 403;
  readonly code = "CONNECTOR_MUTATION_FORBIDDEN";

  constructor(readonly reasonCode: NonNullable<ConnectorRuntimeCapabilityDto["reasonCode"]>) {
    super(`当前运行环境禁止修改连接器: ${reasonCode}`);
    this.name = "ConnectorMutationForbiddenError";
  }
}

export interface ConnectorRuntimeAccess {
  capability: ConnectorRuntimeCapabilityDto;
  assertMutationAllowed(): void;
}

type RuntimeEnv = Readonly<Record<string, string | undefined>>;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * capability DTO 与 mutation 守卫的单一判定源。M1b handler 必须调用同一返回值的
 * assertMutationAllowed()，不能只信前端隐藏按钮。
 */
export function getConnectorRuntimeAccess(env: RuntimeEnv = process.env): ConnectorRuntimeAccess {
  const host = env.QINGAGENT_HOST ?? "127.0.0.1";
  const publicDeployment = env.QINGAGENT_PUBLIC_DEPLOYMENT === "1";
  const externallyExposed = !LOOPBACK_HOSTS.has(host);

  let capability: ConnectorRuntimeCapabilityDto;
  if (publicDeployment) {
    capability = { mutationEnabled: false, reasonCode: "PUBLIC_DEPLOYMENT" };
  } else if (env.QINGAGENT_RUNTIME === "desktop") {
    capability =
      env.QINGAGENT_CONNECTORS_ENABLED === "1" && !externallyExposed
        ? { mutationEnabled: true, reasonCode: null }
        : { mutationEnabled: false, reasonCode: "CONNECTORS_DISABLED" };
  } else if (env.QINGAGENT_SINGLE_USER !== "1") {
    capability = { mutationEnabled: false, reasonCode: "SINGLE_USER_OPT_IN_REQUIRED" };
  } else if (externallyExposed && !env.QINGAGENT_AUTH_TOKEN) {
    capability = { mutationEnabled: false, reasonCode: "AUTH_TOKEN_REQUIRED" };
  } else {
    capability = { mutationEnabled: true, reasonCode: null };
  }

  return {
    capability,
    assertMutationAllowed(): void {
      if (!capability.mutationEnabled) {
        throw new ConnectorMutationForbiddenError(capability.reasonCode!);
      }
    },
  };
}
