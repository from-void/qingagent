import { useCallback, useEffect, useState } from "react";
import type { ConnectorId, ConnectorInfo } from "@qingagent/contract-ts";

const PENDING_REFRESH_INTERVAL_MS = 30_000;

function pendingIdFromStartResult(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const pendingId = (value as { pendingId?: unknown }).pendingId;
  return typeof pendingId === "string" && pendingId.length > 0 ? pendingId : null;
}

export function useConnectors() {
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [pendingIds, setPendingIds] = useState<Partial<Record<ConnectorId, string>>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/connectors");
      if (!response.ok) throw new Error(`连接列表加载失败 (${response.status})`);
      const body = await response.json() as { connectors?: ConnectorInfo[] };
      let next = Array.isArray(body.connectors) ? body.connectors : [];
      const pendingEntries = Object.entries(pendingIds) as Array<[ConnectorId, string]>;
      if (pendingEntries.length > 0) {
        const statuses = await Promise.all(pendingEntries.map(async ([id, pendingId]) => {
          const statusResponse = await fetch(`/api/v1/connectors/${encodeURIComponent(id)}?pendingId=${encodeURIComponent(pendingId)}`);
          if (!statusResponse.ok) return null;
          return { id, connector: await statusResponse.json() as ConnectorInfo };
        }));
        const resolvedIds: ConnectorId[] = [];
        for (const status of statuses) {
          if (!status) continue;
          next = next.map((item) => item.id === status.id ? status.connector : item);
          if (status.connector.status.state !== "pending") resolvedIds.push(status.id);
        }
        if (resolvedIds.length > 0) {
          setPendingIds((current) => {
            const remaining = { ...current };
            for (const id of resolvedIds) delete remaining[id];
            return remaining;
          });
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
  }, [pendingIds]);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  const hasPending = Object.keys(pendingIds).length > 0 || connectors.some(
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
    const result = await response.json() as unknown;
    const pendingId = pendingIdFromStartResult(result);
    if (pendingId) setPendingIds((current) => ({ ...current, [id]: pendingId }));
    return result;
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
