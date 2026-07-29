import { useSyncExternalStore } from "react";
import type { ConnectorId, QrCardBody } from "@qingagent/contract-ts";

export interface ConnectorAuthSession {
  connectorId: ConnectorId;
  pendingId: string;
  startedAt: number;
  card: QrCardBody;
}

export type ConnectorAuthSessions = Readonly<
  Partial<Record<ConnectorId, ConnectorAuthSession>>
>;

let sessions: ConnectorAuthSessions = {};
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function saveConnectorAuthSession(session: ConnectorAuthSession): void {
  sessions = { ...sessions, [session.connectorId]: session };
  emit();
}

export function clearConnectorAuthSession(
  connectorId: ConnectorId,
  pendingId?: string,
): void {
  const current = sessions[connectorId];
  if (!current || (pendingId && current.pendingId !== pendingId)) return;
  const next = { ...sessions };
  delete next[connectorId];
  sessions = next;
  emit();
}

export function getConnectorAuthSessions(): ConnectorAuthSessions {
  return sessions;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useConnectorAuthSessions(): ConnectorAuthSessions {
  return useSyncExternalStore(subscribe, getConnectorAuthSessions, getConnectorAuthSessions);
}

export function resetConnectorAuthSessionsForTests(): void {
  sessions = {};
  emit();
}
