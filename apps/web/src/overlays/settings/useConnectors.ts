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
      setError(cause instanceof Error ? cause.message : "连接列表加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const mutate = useCallback(async (id: ConnectorId, method: "POST" | "DELETE") => {
    const path = method === "POST"
      ? `/api/v1/connectors/${encodeURIComponent(id)}/probe`
      : `/api/v1/connectors/${encodeURIComponent(id)}`;
    const response = await fetch(path, { method });
    if (!response.ok) throw new Error(`连接操作失败 (${response.status})`);
    const connector = await response.json() as ConnectorInfo;
    setConnectors((current) => current.map((item) => item.id === id ? connector : item));
    return connector;
  }, []);

  return {
    connectors,
    loading,
    error,
    refresh,
    probe: (id: ConnectorId) => mutate(id, "POST"),
    disconnect: (id: ConnectorId) => mutate(id, "DELETE"),
  };
}
