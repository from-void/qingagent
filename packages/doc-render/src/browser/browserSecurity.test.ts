import { describe, expect, it, vi } from "vitest";
import type { BrowserContext } from "playwright";
import { installBrowserRequestPolicy } from "./browserSecurity.js";

function mockContext() {
  const route = vi.fn<
    (url: string, handler: (route: unknown) => Promise<void>) => Promise<void>
  >(async () => undefined);
  const routeWebSocket = vi.fn<
    (url: string, handler: (route: unknown) => Promise<void>) => Promise<void>
  >(async () => undefined);
  return {
    context: { route, routeWebSocket } as unknown as BrowserContext,
    route,
    routeWebSocket,
  };
}

describe("浏览器请求安全策略", () => {
  it.each(["eventsource", "media"])("抓取模式直接阻断 %s 请求", async (resourceType) => {
    const mocked = mockContext();
    await installBrowserRequestPolicy(mocked.context, { blockStreamingResources: true });
    const handler = mocked.route.mock.calls[0]?.[1] as (route: unknown) => Promise<void>;
    const continueRequest = vi.fn(async () => undefined);
    const abort = vi.fn(async () => undefined);

    await handler({
      request: () => ({
        url: () => "https://1.1.1.1/stream",
        resourceType: () => resourceType,
      }),
      continue: continueRequest,
      abort,
    });

    expect(abort).toHaveBeenCalledWith("blockedbyclient");
    expect(continueRequest).not.toHaveBeenCalled();
  });

  it("抓取模式直接关闭 WebSocket，不连接服务端", async () => {
    const mocked = mockContext();
    await installBrowserRequestPolicy(mocked.context, { blockStreamingResources: true });
    const handler = mocked.routeWebSocket.mock.calls[0]?.[1] as (
      route: unknown,
    ) => Promise<void>;
    const websocketRoute = {
      url: () => "wss://1.1.1.1/socket",
      connectToServer: vi.fn(),
      close: vi.fn(async () => undefined),
    };

    await handler(websocketRoute);

    expect(websocketRoute.connectToServer).not.toHaveBeenCalled();
    expect(websocketRoute.close).toHaveBeenCalledWith(expect.objectContaining({ code: 1008 }));
  });

  it("交互式模式保持 EventSource、媒体与 WebSocket 的原有放行行为", async () => {
    const mocked = mockContext();
    await installBrowserRequestPolicy(mocked.context);
    const httpHandler = mocked.route.mock.calls[0]?.[1] as (route: unknown) => Promise<void>;
    const websocketHandler = mocked.routeWebSocket.mock.calls[0]?.[1] as (
      route: unknown,
    ) => Promise<void>;

    for (const resourceType of ["eventsource", "media"]) {
      const continueRequest = vi.fn(async () => undefined);
      const abort = vi.fn(async () => undefined);
      await httpHandler({
        request: () => ({
          url: () => "https://1.1.1.1/stream",
          resourceType: () => resourceType,
        }),
        continue: continueRequest,
        abort,
      });
      expect(continueRequest).toHaveBeenCalledOnce();
      expect(abort).not.toHaveBeenCalled();
    }

    const websocketRoute = {
      url: () => "wss://1.1.1.1/socket",
      connectToServer: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    await websocketHandler(websocketRoute);
    expect(websocketRoute.connectToServer).toHaveBeenCalledOnce();
    expect(websocketRoute.close).not.toHaveBeenCalled();
  });
});
