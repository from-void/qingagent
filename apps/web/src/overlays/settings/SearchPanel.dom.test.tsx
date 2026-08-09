// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchPanel } from "./SearchPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.restoreAllMocks();
});

describe("SearchPanel", () => {
  it("快速保存不同 provider 时串行请求并用最终响应校准界面", async () => {
    let resolveFirstPut!: (response: Response) => void;
    const firstPut = new Promise<Response>((resolve) => {
      resolveFirstPut = resolve;
    });
    const putUrls: string[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/settings/search/primary")) return Promise.resolve(json(primary));
      if (url.endsWith("/settings/search") && !init?.method) {
        return Promise.resolve(json({ providers: initialProviders }));
      }
      if (init?.method === "PUT") {
        putUrls.push(url);
        if (putUrls.length === 1) {
          return firstPut;
        }
        return Promise.resolve(json({ providers: configuredProviders }));
      }
      return Promise.resolve(json({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    await renderPanel();

    const searxngCard = getProviderCard("SearXNG");
    const tavilyCard = getProviderCard("Tavily");
    setInput(getCardInput(searxngCard), "https://search.example.com");
    setInput(getCardInput(tavilyCard), "tvly-concurrent-1234");

    await click(getCardButton(searxngCard, "保存"));
    await click(getCardButton(tavilyCard, "保存"));

    expect(putUrls).toEqual(["/api/v1/settings/search/searxng"]);

    await act(async () => {
      resolveFirstPut(json({ providers: searxngConfiguredProviders }));
      await firstPut;
    });
    await waitFor(() => putUrls.length === 2);
    expect(putUrls).toEqual([
      "/api/v1/settings/search/searxng",
      "/api/v1/settings/search/tavily",
    ]);
    await waitFor(() => getCardInput(getProviderCard("Tavily")).placeholder.includes("尾号 1234"));

    expect(getCardInput(getProviderCard("SearXNG")).placeholder).toContain("尾号 .com");
    expect(getCardInput(getProviderCard("Tavily")).placeholder).toContain("尾号 1234");
  });

  it("未配置 key 的测试响应保留 errorKind，不误报网络异常", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/settings/search/primary")) return Promise.resolve(json(primary));
      if (url.endsWith("/settings/search") && !init?.method) {
        return Promise.resolve(json({ providers: configuredProviders }));
      }
      if (url.endsWith("/settings/search/tavily/test")) {
        return Promise.resolve(json({ ok: false, errorKind: "missing_key" }, 400));
      }
      return Promise.resolve(json({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    await renderPanel();

    const tavilyCard = getProviderCard("Tavily");
    const testButton = Array.from(tavilyCard.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "测试");
    if (!testButton) throw new Error("Tavily test button not found");
    expect(testButton.disabled).toBe(false);
    await click(testButton);

    await waitFor(() => fetchMock.mock.calls.some(
      ([input]) => String(input).endsWith("/settings/search/tavily/test"),
    ));
    await waitFor(() =>
      (host?.querySelector(".sm-message")?.textContent ?? "")
        .includes("Tavily 测试失败:尚未配置 key")
    );
    expect(host?.querySelector(".sm-message")?.textContent)
      .toContain("Tavily 测试失败:尚未配置 key");
    expect(host?.textContent).not.toContain("网络异常");
  });
});

const primary = {
  enabled: true,
  keyConfigured: false,
  maskedTail: null,
  source: "none",
};

function provider(id: string, label: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    label,
    kind: id === "tavily" ? "api" : "scrape",
    enabled: false,
    keyConfigured: false,
    maskedTail: null,
    health: { status: "ok", quotaUntil: null },
    freeQuotaNote: "测试",
    keyUrl: null,
    ...overrides,
  };
}

const initialProviders = [
  provider("searxng", "SearXNG"),
  provider("tavily", "Tavily"),
];

const searxngConfiguredProviders = [
  provider("searxng", "SearXNG", { enabled: true, keyConfigured: true, maskedTail: ".com" }),
  provider("tavily", "Tavily"),
];

const configuredProviders = [
  provider("searxng", "SearXNG", { enabled: true, keyConfigured: true, maskedTail: ".com" }),
  provider("tavily", "Tavily", { enabled: true, keyConfigured: true, maskedTail: "1234" }),
];

async function renderPanel(): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<SearchPanel />);
  });
  await waitFor(() => getProviderCard("Tavily") !== null);
}

function getProviderCard(label: string): HTMLElement {
  const heading = Array.from(host?.querySelectorAll("h3") ?? []).find(
    (node) => node.textContent === label,
  );
  const card = heading?.closest<HTMLElement>(".ss-card");
  if (!card) throw new Error(`${label} card not found`);
  return card;
}

function getCardInput(card: HTMLElement): HTMLInputElement {
  const input = card.querySelector<HTMLInputElement>("input");
  if (!input) throw new Error("provider input not found");
  return input;
}

function getCardButton(card: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(card.querySelectorAll<HTMLButtonElement>("button")).find(
    (node) => node.textContent?.trim() === label,
  );
  if (!button) throw new Error(`${label} button not found`);
  return button;
}

function setInput(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() <= deadline) {
    try {
      if (predicate()) return;
    } catch {
      // React 尚未提交下一帧，继续刷新。
    }
    await flush();
  }
  throw new Error("等待界面状态超时");
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
