import { startTransition, useEffect, useState } from "react";
import type { ReactNode } from "react";

export type RouteName = "home" | "workspace" | "debug" | "gallery" | "spec" | "uikit";

const DEV_ONLY_ROUTES = new Set<RouteName>(["debug", "gallery", "spec", "uikit"]);

const ROUTE_TO_HASH: Record<RouteName, string> = {
  home: "#/",
  workspace: "#/workspace",
  debug: "#/debug",
  gallery: "#/gallery",
  spec: "#/spec",
  uikit: "#/uikit",
};

const HASH_TO_ROUTE: Record<string, RouteName> = {
  "": "home",
  "#": "home",
  "#/": "home",
  "#/workspace": "workspace",
  "#/debug": "debug",
  "#/gallery": "gallery",
  "#/spec": "spec",
  "#/uikit": "uikit",
};

export interface RouterProps {
  /** Slot for each route. Routes not in the map render `null`. */
  routes: Partial<Record<RouteName, ReactNode>>;
  /** Default render when no route matched (after stripping overlay hashes). */
  fallback?: ReactNode;
}

/**
 * Minimal hash router. Stage A keeps routing dependency-free; Stage B
 * may swap in a richer router if needed.
 *
 * Hash format: `#/<path>` for the route, with an optional `;<suffix>`
 * segment that routing ignores (历史上曾承载 overlay 弹窗,现仅为
 * 容错保留:带残留后缀的旧链接仍能解析到正确路由)。Examples:
 *   `#/`                → home
 *   `#/workspace`       → workspace
 *   `#/workspace;x`     → workspace (suffix ignored)
 */
export function Router({ routes, fallback = null }: RouterProps) {
  const route = useRoute();
  const node = routes[route];
  return <>{node ?? fallback}</>;
}

export function useRoute(): RouteName {
  const [route, setRoute] = useState<RouteName>(() => parseRoute(window.location.hash));
  useEffect(() => {
    // Normalize empty hashes to `#/` so the URL bar stays canonical.
    if (window.location.hash === "" || window.location.hash === "#") {
      window.history.replaceState(null, "", "#/");
    }
    const onChange = () => {
      startTransition(() => {
        setRoute(parseRoute(window.location.hash));
      });
    };
    window.addEventListener("hashchange", onChange);
    window.addEventListener("popstate", onChange);
    return () => {
      window.removeEventListener("hashchange", onChange);
      window.removeEventListener("popstate", onChange);
    };
  }, []);
  return route;
}

/** Internal: split `hash` into its route + overlay parts. */
export function splitHash(hash: string): { routeHash: string; overlay: string | null } {
  if (hash === "" || hash === "#") {
    return { routeHash: "#/", overlay: null };
  }
  const idx = hash.indexOf(";");
  if (idx >= 0) {
    return {
      routeHash: hash.slice(0, idx) || "#/",
      overlay: hash.slice(idx + 1) || null,
    };
  }
  // Bare `#modal-foo` — no `;`, no `/`. Treat the whole thing as overlay
  // shorthand so visual tests written as `gotoHash("#modal-import")`
  // still work, defaulting to the home route.
  if (!hash.startsWith("#/")) {
    return { routeHash: "#/", overlay: hash.slice(1) || null };
  }
  return { routeHash: hash, overlay: null };
}

export function isRouteAvailable(route: RouteName, devRoutesEnabled = import.meta.env.DEV): boolean {
  return devRoutesEnabled || !DEV_ONLY_ROUTES.has(route);
}

export function parseRoute(
  hash: string,
  options: { devRoutesEnabled?: boolean } = {},
): RouteName {
  const { routeHash } = splitHash(hash);
  // Strip `?…` query suffix before lookup so deep links like
  // `#/workspace?session=abc` still resolve. The query is ignored
  // for routing but pages may read it from window.location.
  const stripped = routeHash.replace(/\?.*$/, "");
  const route = HASH_TO_ROUTE[stripped] ?? "home";
  return isRouteAvailable(route, options.devRoutesEnabled) ? route : "home";
}

export function routeToHash(route: RouteName): string {
  return ROUTE_TO_HASH[route];
}

/** 首页「新建」入口必须把意图写进 URL，不能与无参数深链混为同一条隐式路径。 */
export function routeToNewWorkspaceHash(): string {
  return `${ROUTE_TO_HASH.workspace}?intent=new`;
}
