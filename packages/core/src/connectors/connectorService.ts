import { FeishuConnector } from "./feishuConnector.js";
import { GithubConnector } from "./githubConnector.js";
import { listConnectorDefinitions } from "./registry.js";
import type { ConnectorAdapter, ConnectorId, ConnectorStatusDto } from "./types.js";
import { WechatConnector } from "./wechatConnector.js";

export interface ConnectorInfoDto {
  id: ConnectorId;
  name: string;
  icon: string;
  official: boolean;
  riskNote: string | null;
  usedBySkills: string[];
  status: ConnectorStatusDto;
}

const CONNECTOR_IDS = new Set<ConnectorId>(["github", "feishu", "wechat-mp"]);

export function isConnectorId(value: string): value is ConnectorId {
  return CONNECTOR_IDS.has(value as ConnectorId);
}

export class ConnectorService {
  constructor(private readonly adapters: Readonly<Record<ConnectorId, ConnectorAdapter>>) {}

  async list(): Promise<ConnectorInfoDto[]> {
    return Promise.all(listConnectorDefinitions().map((definition) => this.info(definition.id)));
  }

  async info(id: ConnectorId): Promise<ConnectorInfoDto> {
    const definition = listConnectorDefinitions().find((item) => item.id === id)!;
    return {
      id,
      name: definition.name,
      icon: definition.icon,
      official: definition.official,
      riskNote: definition.riskNote ?? null,
      usedBySkills: [...definition.usedBySkills],
      status: await this.adapters[id].status(),
    };
  }

  async probe(id: ConnectorId): Promise<ConnectorInfoDto> {
    const adapter = this.adapters[id];
    const status = adapter.probe ? await adapter.probe() : await adapter.status();
    const definition = listConnectorDefinitions().find((item) => item.id === id)!;
    return {
      id,
      name: definition.name,
      icon: definition.icon,
      official: definition.official,
      riskNote: definition.riskNote ?? null,
      usedBySkills: [...definition.usedBySkills],
      status,
    };
  }

  async disconnect(id: ConnectorId): Promise<ConnectorInfoDto> {
    const status = await this.adapters[id].disconnect();
    const definition = listConnectorDefinitions().find((item) => item.id === id)!;
    return {
      id,
      name: definition.name,
      icon: definition.icon,
      official: definition.official,
      riskNote: definition.riskNote ?? null,
      usedBySkills: [...definition.usedBySkills],
      status,
    };
  }
}

let defaultService: ConnectorService | null = null;

export function getConnectorService(): ConnectorService {
  defaultService ??= new ConnectorService({
    github: new GithubConnector(),
    feishu: new FeishuConnector(),
    "wechat-mp": new WechatConnector(),
  });
  return defaultService;
}
