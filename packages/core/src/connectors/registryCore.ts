import type { ConnectorAdapter, ConnectorDefinition, ConnectorId } from "./types.js";

export type ConnectorAdapterFactory = () => ConnectorAdapter;
type RegisteredConnectorDefinition = {
  [Id in ConnectorId]: ConnectorDefinition & { id: Id };
}[ConnectorId];

interface ConnectorRegistration {
  definition: ConnectorDefinition;
  createAdapter: ConnectorAdapterFactory;
}

const registrationsById = new Map<ConnectorId, ConnectorRegistration>();
const mutableConnectorRegistry: RegisteredConnectorDefinition[] = [];

export const CONNECTOR_REGISTRY: readonly RegisteredConnectorDefinition[] = mutableConnectorRegistry;

export function registerConnector(
  definition: ConnectorDefinition,
  createAdapter: ConnectorAdapterFactory,
): void {
  if (registrationsById.has(definition.id)) {
    throw new Error(`连接器重复注册: ${definition.id}`);
  }
  registrationsById.set(definition.id, { definition, createAdapter });
  mutableConnectorRegistry.push(definition as RegisteredConnectorDefinition);
}

export function getConnectorDefinition(id: ConnectorId): ConnectorDefinition {
  const registration = registrationsById.get(id);
  if (!registration) throw new Error(`未知连接器: ${id}`);
  return registration.definition;
}

export function listConnectorDefinitions(): readonly ConnectorDefinition[] {
  return CONNECTOR_REGISTRY;
}

export function createConnectorAdapters(): Readonly<Record<ConnectorId, ConnectorAdapter>> {
  return Object.fromEntries(
    [...registrationsById].map(([id, registration]) => [id, registration.createAdapter()]),
  ) as Record<ConnectorId, ConnectorAdapter>;
}
