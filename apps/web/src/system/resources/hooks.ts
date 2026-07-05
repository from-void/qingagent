import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import type { Resource, ResourceDomain, ResourceRef } from "@qingagent/contract-ts";
import { resources } from "./registry";

export function useResource(ref: ResourceRef | null): Resource | null {
  const subscribe = useCallback(
    (listener: () => void) => resources.subscribe(() => listener()),
    [],
  );
  const getSnapshot = useCallback(
    () => (ref ? resources.get(ref) : null),
    [ref],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useResourceList(domain?: ResourceDomain): Resource[] {
  const subscribe = useCallback(
    (listener: () => void) => resources.subscribe(() => listener()),
    [],
  );
  // useSyncExternalStore demands snapshot stability: the same input
  // state must yield the SAME array identity. Use a ref to memoize
  // the most recent snapshot and only return a new array when the
  // store actually changed.
  const cache = useRef<Resource[] | null>(null);
  const getSnapshot = useMemo(() => {
    return () => {
      const next = resources.list(domain);
      const prev = cache.current;
      if (
        prev !== null &&
        prev.length === next.length &&
        prev.every((r, i) => r === next[i])
      ) {
        return prev;
      }
      cache.current = next;
      return next;
    };
  }, [domain]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
