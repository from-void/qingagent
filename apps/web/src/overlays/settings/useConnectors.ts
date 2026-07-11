import { useCallback, useEffect, useState } from "react";
import type { ConnectorId, ConnectorInfo } from "@qingagent/contract-ts";

export function useConnectors() {
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/connectors");
      if (!response.ok) throw new Error(`连接列表加载失败 (${response.status})`);
      const body = await response.json() as { connectors?: ConnectorInfo[] };
      setConnectors(Array.isArray(body.connectors) ? body.connectors : []);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "连接列表加载失败";
      setError(message);
      throw cause instanceof Error ? cause : new Error(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  const mutate = useCallback(async (id: ConnectorId, method: "POST" | "DELETE") => {
    const path = method === "POST"
      ? `/api/v1/connectors/${encodeURIComponent(id)}/probe`
      : `/api/v1/connectors/${encodeURIComponent(id)}`;
    const response = await fetch(path, { method });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string; reasonCode?: string };
      throw new Error(`${body.error ?? "连接操作失败"} (${response.status})${body.reasonCode ? `：${body.reasonCode}` : ""}`);
    }
    const connector = await response.json() as ConnectorInfo;
    setConnectors((current) => current.map((item) => item.id === id ? connector : item));
    return connector;
  }, []);

  const start = useCallback(async (id: ConnectorId) => {
    const response = await fetch(`/api/v1/connectors/${encodeURIComponent(id)}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!response.ok) throw new Error(`连接操作失败 (${response.status})`);
    return response.json() as Promise<unknown>;
  }, []);

  return {
    connectors,
    loading,
    error,
    refresh,
    start,
    probe: (id: ConnectorId) => mutate(id, "POST"),
    disconnect: (id: ConnectorId) => mutate(id, "DELETE"),
  };
}
