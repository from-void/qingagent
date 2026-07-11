import type { ConnectorDefinition, ConnectorId } from "./types.js";

export const CONNECTOR_REGISTRY = [
  {
    id: "github",
    name: "GitHub",
    icon: "github",
    official: true,
    authStrategy: "oauth2-device",
    custody: "internal",
    scopeGroups: [
      {
        id: "public",
        name: "公开仓库",
        scopes: ["public_repo"],
        description: "读取账号可见的公开仓库",
      },
      {
        id: "private",
        name: "私有仓库",
        scopes: ["repo"],
        description: "读取账号可见的公开与私有仓库",
      },
    ],
    tools: [
      "github_list_repos",
      "github_repo_tree",
      "github_read_file",
    ],
    usedBySkills: ["github-materials"],
  },
  {
    id: "feishu",
    name: "飞书",
    icon: "feishu",
    official: true,
    authStrategy: "device-flow-cli",
    custody: "external-cli",
    scopeGroups: [],
    tools: [],
    usedBySkills: ["feishu"],
  },
  {
    id: "wechat-mp",
    name: "微信公众号",
    icon: "wechat",
    official: false,
    authStrategy: "qr-session",
    custody: "internal",
    scopeGroups: [],
    tools: [
      "wechat_auth_start",
      "wechat_auth_status",
      "wechat_search_mp",
      "wechat_list_articles",
    ],
    usedBySkills: ["wechat-official-account"],
    riskNote: "非官方接口，登录态可能提前失效，并存在平台风控风险。",
  },
] as const satisfies readonly ConnectorDefinition[];

const definitionsById = new Map<ConnectorId, ConnectorDefinition>(
  CONNECTOR_REGISTRY.map((definition) => [definition.id, definition]),
);

export function getConnectorDefinition(id: ConnectorId): ConnectorDefinition {
  const definition = definitionsById.get(id);
  if (!definition) {
    throw new Error(`未知连接器: ${id}`);
  }
  return definition;
}

export function listConnectorDefinitions(): readonly ConnectorDefinition[] {
  return CONNECTOR_REGISTRY;
}
