import { useCallback, useEffect, useState } from "react";
import type { ConnectorId, ConnectorInfo } from "@qingagent/contract-ts";
import {
  clearConnectorAuthSession,
  useConnectorAuthSessions,
} from "./connectorAuthSession";

const PENDING_REFRESH_INTERVAL_MS = 30_000;
const CHECKING_REFRESH_INTERVAL_MS = 5_000;
const FEISHU_TRANSIENT_REASON_CODES = new Set([
  "LARK_CLI_VERSION_TIMEOUT",
  "LARK_CLI_TIMEOUT",
  "LARK_CLI_OUTPUT_LIMIT",
  "LARK_CLI_DIRTY_OUTPUT",
  "LARK_CLI_FAILED",
]);

export function useConnectors() {
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const pendingSessions = useConnectorAuthSessions();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/connectors");
      if (!response.ok) throw new Error(`连接列表加载失败 (${response.status})`);
      const body = await response.json() as { connectors?: ConnectorInfo[] };
      let next = Array.isArray(body.connectors) ? body.connectors : [];
      const pendingEntries = Object.values(pendingSessions).filter(
        (session) => session !== undefined,
      );
      if (pendingEntries.length > 0) {
        const statuses = await Promise.all(pendingEntries.map(async (session) => {
          const statusResponse = await fetch(`/api/v1/connectors/${encodeURIComponent(session.connectorId)}?pendingId=${encodeURIComponent(session.pendingId)}`);
          if (!statusResponse.ok) {
            if (statusResponse.status === 410) {
              clearConnectorAuthSession(session.connectorId, session.pendingId);
            }
            return null;
          }
          return {
            session,
            connector: await statusResponse.json() as ConnectorInfo,
          };
        }));
        for (const status of statuses) {
          if (!status) continue;
          next = next.map((item) =>
            item.id === status.session.connectorId ? status.connector : item
          );
          if (status.connector.status.state !== "pending") {
            clearConnectorAuthSession(
              status.session.connectorId,
              status.session.pendingId,
            );
          }
        }
      }
      setConnectors(next);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "连接列表加载失败";
      setError(message);
      throw cause instanceof Error ? cause : new Error(message);
    } finally {
      setLoading(false);
    }
  }, [pendingSessions]);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  const hasPending = Object.keys(pendingSessions).length > 0 || connectors.some(
    (connector) => connector.status.state === "pending",
  );
  useEffect(() => {
    if (!hasPending) return;
    const refreshPending = () => { void refresh().catch(() => undefined); };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refreshPending();
    };
    window.addEventListener("focus", refreshPending);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    const interval = window.setInterval(refreshPending, PENDING_REFRESH_INTERVAL_MS);
    return () => {
      window.removeEventListener("focus", refreshPending);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.clearInterval(interval);
    };
  }, [hasPending, refresh]);

  const hasChecking = connectors.some(
    (connector) => connector.status.state === "checking" || (
      connector.id === "feishu" &&
      connector.status.reasonCode !== null &&
      FEISHU_TRANSIENT_REASON_CODES.has(connector.status.reasonCode)
    ),
  );
  useEffect(() => {
    if (!hasChecking) return;
    const refreshChecking = () => { void refresh().catch(() => undefined); };
    const interval = window.setInterval(refreshChecking, CHECKING_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refreshChecking);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshChecking);
    };
  }, [hasChecking, refresh]);

  const mutate = useCallback(async (id: ConnectorId, method: "POST" | "DELETE") => {
    const path = method === "POST"
      ? `/api/v1/connectors/${encodeURIComponent(id)}/probe`
      : `/api/v1/connectors/${encodeURIComponent(id)}`;
    const response = await fetch(path, { method });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string; message?: string; reasonCode?: string };
      throw new Error(`${body.message ?? body.error ?? "连接操作失败"} (${response.status})${body.reasonCode ? `：${body.reasonCode}` : ""}`);
    }
    const connector = await response.json() as ConnectorInfo;
    setConnectors((current) => current.map((item) => item.id === id ? connector : item));
    return connector;
  }, []);

  const start = useCallback(async (id: ConnectorId, body: Record<string, unknown> = {}) => {
    const response = await fetch(`/api/v1/connectors/${encodeURIComponent(id)}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({})) as { error?: string; message?: string; reasonCode?: string };
      throw new Error(`${result.message ?? result.error ?? "连接操作失败"} (${response.status})${result.reasonCode ? `：${result.reasonCode}` : ""}`);
    }
    return response.json() as Promise<unknown>;
  }, []);

  const cancel = useCallback(async (id: ConnectorId, pendingId: string) => {
    const response = await fetch(
      `/api/v1/connectors/${encodeURIComponent(id)}/pending/${encodeURIComponent(pendingId)}`,
      { method: "DELETE" },
    );
    if (!response.ok) {
      if (response.status === 410) clearConnectorAuthSession(id, pendingId);
      const body = await response.json().catch(() => ({})) as {
        error?: string;
        message?: string;
        reasonCode?: string;
      };
      throw new Error(`${body.message ?? body.error ?? "取消授权失败"} (${response.status})${body.reasonCode ? `：${body.reasonCode}` : ""}`);
    }
    const connector = await response.json() as ConnectorInfo;
    clearConnectorAuthSession(id, pendingId);
    setConnectors((current) =>
      current.map((item) => item.id === id ? connector : item)
    );
    return connector;
  }, []);

  return {
    connectors,
    pendingSessions,
    loading,
    error,
    refresh,
    start,
    cancel,
    probe: (id: ConnectorId) => mutate(id, "POST"),
    disconnect: (id: ConnectorId) => mutate(id, "DELETE"),
  };
}
