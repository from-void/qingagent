import { listConnectorDefinitions } from "./registry.js";
import { createConnectorAdapters } from "./registryCore.js";
import { mastra } from "../mastra.js";
import { createConnectorStatus } from "./service.js";
import type {
  ConnectorAdapter,
  ConnectorAuthPresentation,
  ConnectorId,
  ConnectorStatusDto,
} from "./types.js";

const logger = mastra.getLogger();

export interface ConnectorInfoDto {
  id: ConnectorId;
  name: string;
  icon: string;
  official: boolean;
  authPresentation: ConnectorAuthPresentation;
  riskNote: string | null;
  usedBySkills: string[];
  status: ConnectorStatusDto;
}

export function isConnectorId(value: string): value is ConnectorId {
  return listConnectorDefinitions().some((definition) => definition.id === value);
}

export class ConnectorService {
  constructor(private readonly adapters: Readonly<Record<ConnectorId, ConnectorAdapter>>) {}

  async list(): Promise<ConnectorInfoDto[]> {
    return Promise.all(listConnectorDefinitions().map(async (definition) => {
      try {
        return await this.info(definition.id);
      } catch (error) {
        logger.error("Connector status lookup failed", {
          connectorId: definition.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          id: definition.id,
          name: definition.name,
          icon: definition.icon,
          official: definition.official,
          authPresentation: definition.authPresentation,
          riskNote: definition.riskNote ?? null,
          usedBySkills: [...definition.usedBySkills],
          status: createConnectorStatus("unavailable", {
            reasonCode: "CONNECTOR_STATUS_UNAVAILABLE",
            statusFreshness: "unknown",
            canProbe: false,
          }),
        };
      }
    }));
  }

  async info(id: ConnectorId, pendingId?: string): Promise<ConnectorInfoDto> {
    const definition = listConnectorDefinitions().find((item) => item.id === id)!;
    return {
      id,
      name: definition.name,
      icon: definition.icon,
      official: definition.official,
      authPresentation: definition.authPresentation,
      riskNote: definition.riskNote ?? null,
      usedBySkills: [...definition.usedBySkills],
      status: await this.adapters[id].status(pendingId),
    };
  }

  async start(id: ConnectorId, input?: unknown): Promise<unknown> {
    const adapter = this.adapters[id];
    if (!adapter.start) throw Object.assign(new Error("该连接器不支持发起授权"), { code: "CONNECTOR_START_UNSUPPORTED", status: 409 });
    return adapter.start(input);
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
      authPresentation: definition.authPresentation,
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
      authPresentation: definition.authPresentation,
      riskNote: definition.riskNote ?? null,
      usedBySkills: [...definition.usedBySkills],
      status,
    };
  }
}

let defaultService: ConnectorService | null = null;

export function getConnectorService(): ConnectorService {
  defaultService ??= new ConnectorService(createConnectorAdapters());
  return defaultService;
}
