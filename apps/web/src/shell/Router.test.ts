// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  isRouteAvailable,
  parseRoute,
  routeToNewWorkspaceHash,
  useRoute,
} from "./Router";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

describe("Router dev-only routes", () => {
  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    window.history.replaceState(null, "", "#/");
  });

  it("生产环境不暴露 gallery/spec/debug hash 路由", () => {
    for (const route of ["debug", "gallery", "spec"] as const) {
      expect(isRouteAvailable(route, false)).toBe(false);
      expect(parseRoute(`#/${route}`, { devRoutesEnabled: false })).toBe("home");
      expect(parseRoute(`#/${route}?case=1`, { devRoutesEnabled: false })).toBe("home");
      expect(parseRoute(`#/${route}`, { devRoutesEnabled: true })).toBe(route);
    }
  });

  it("useRoute 响应 popstate,支持非 hashchange 的历史回退/前进信号", async () => {
    window.history.replaceState(null, "", "#/");
    await render(createElement(RouteProbe));

    expect(getProbe("route").textContent).toBe("home");
    act(() => {
      window.history.pushState(null, "", "#/workspace");
      window.dispatchEvent(new Event("popstate"));
    });

    expect(getProbe("route").textContent).toBe("workspace");
  });

  it("带 `;` 残留后缀的旧链接仍解析到正确路由（overlay 弹窗已下线,仅容错）", () => {
    expect(parseRoute("#/workspace;modal-import")).toBe("workspace");
    expect(parseRoute("#modal-import")).toBe("home");
    expect(parseRoute("#/;anything")).toBe("home");
  });

  it("已拆除的新建页 hash 回落首页(旧链接/书签不白屏)", () => {
    expect(parseRoute("#/new")).toBe("home");
    expect(parseRoute("#/new?template=essay")).toBe("home");
    expect(parseRoute("#/new;modal-import")).toBe("home");
    expect(parseRoute("#/new", { devRoutesEnabled: true })).toBe("home");
  });

  it("首页新建入口用 query 明示 new 意图", () => {
    expect(routeToNewWorkspaceHash()).toBe("#/workspace?intent=new");
    expect(parseRoute(routeToNewWorkspaceHash())).toBe("workspace");
  });
});

function RouteProbe() {
  const route = useRoute();
  return createElement("div", { "data-probe": "route" }, route);
}

async function render(element: ReturnType<typeof createElement>): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(element);
  });
}

function getProbe(name: string): HTMLElement {
  const node = host?.querySelector<HTMLElement>(`[data-probe="${name}"]`);
  if (!node) throw new Error(`${name} probe not found`);
  return node;
}
