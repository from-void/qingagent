import { useEffect, useState } from "react";
import type { ClientCapabilities } from "@qingagent/contract-ts";

export async function fetchClientCapabilities(signal?: AbortSignal): Promise<ClientCapabilities> {
  const response = await fetch("/api/v1/capabilities", { signal });
  if (!response.ok) {
    throw new Error(`capabilities request failed: ${response.status}`);
  }
  return await response.json() as ClientCapabilities;
}

export function useClientCapabilities(): ClientCapabilities | null {
  const [capabilities, setCapabilities] = useState<ClientCapabilities | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchClientCapabilities(controller.signal)
      .then(setCapabilities)
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error("[clientCapabilities] fetch failed", error);
        setCapabilities(null);
      });
    return () => controller.abort();
  }, []);

  return capabilities;
}
