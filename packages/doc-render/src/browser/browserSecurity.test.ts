import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserContext } from "playwright";
import { installBrowserRequestPolicy } from "./browserSecurity.js";

const requestMocks = vi.hoisted(() => ({
  httpRequest: vi.fn(),
  httpsRequest: vi.fn(),
}));

vi.mock("node:http", () => ({ request: requestMocks.httpRequest }));
vi.mock("node:https", () => ({ request: requestMocks.httpsRequest }));

interface MockIncoming extends PassThrough {
  statusCode: number;
  rawHeaders: string[];
}

function createIncoming(): MockIncoming {
  const incoming = new PassThrough() as MockIncoming;
  incoming.statusCode = 200;
  incoming.rawHeaders = [];
  return incoming;
}

function mockHttpResponses(incomings: MockIncoming[]): void {
  let responseIndex = 0;
  requestMocks.httpRequest.mockImplementation(
    (
      _url: unknown,
      _options: unknown,
      onResponse: (incoming: MockIncoming) => void,
    ) => {
      const request = new EventEmitter() as EventEmitter & {
        end: (postData?: Buffer) => void;
      };
      request.end = () => {
        const incoming = incomings[responseIndex++];
        if (!incoming) throw new Error("缺少 mock HTTP 响应");
        onResponse(incoming);
      };
      return request;
    },
  );
}

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
  beforeEach(() => {
    requestMocks.httpRequest.mockReset();
    requestMocks.httpsRequest.mockReset();
  });

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

  it("同一 context 的并发固定 IP 回填受总内存预算约束，并在请求结束后归零", async () => {
    const mocked = mockContext();
    await installBrowserRequestPolicy(mocked.context, { pinHttpRequests: true });
    const handler = mocked.route.mock.calls[0]?.[1] as (route: unknown) => Promise<void>;
    const fullResponseChunk = Buffer.alloc(32 * 1024 * 1024);

    const runBudgetWave = async () => {
      const incomings = Array.from({ length: 5 }, createIncoming);
      const overflowDestroy = vi.spyOn(incomings[4]!, "destroy");
      mockHttpResponses(incomings);
      const routes = incomings.map(() => {
        const state = { abortReason: undefined as string | undefined, fulfilled: false };
        const completion = handler({
          request: () => ({
            url: () => "http://1.1.1.1/large.bin",
            resourceType: () => "fetch",
            allHeaders: async () => ({}),
            method: () => "GET",
            postDataBuffer: () => null,
          }),
          fulfill: async () => {
            state.fulfilled = true;
          },
          abort: async (reason: string) => {
            state.abortReason = reason;
          },
        });
        return { completion, state };
      });
      await vi.waitFor(() => expect(requestMocks.httpRequest).toHaveBeenCalledTimes(5));

      for (const incoming of incomings.slice(0, 4)) incoming.write(fullResponseChunk);
      incomings[4]!.end(Buffer.from([1]));
      await routes[4]!.completion;

      for (let index = 0; index < 4; index += 1) {
        incomings[index]!.end();
        await routes[index]!.completion;
      }
      return {
        routes: routes.map(({ state }) => state),
        overflowDestroyedWithError: overflowDestroy.mock.calls.some(
          ([error]) => error instanceof Error,
        ),
      };
    };

    const firstWave = await runBudgetWave();
    expect(firstWave.routes.slice(0, 4).every(({ fulfilled }) => fulfilled)).toBe(true);
    expect(firstWave.routes[4]).toEqual({ abortReason: "blockedbyclient", fulfilled: false });
    expect(firstWave.overflowDestroyedWithError).toBe(true);

    // 第二轮仍能完整占满同一预算，证明第一轮无论成功或越界都已释放全部额度。
    const secondWave = await runBudgetWave();
    expect(secondWave.routes.slice(0, 4).every(({ fulfilled }) => fulfilled)).toBe(true);
    expect(secondWave.routes[4]).toEqual({ abortReason: "blockedbyclient", fulfilled: false });
    expect(secondWave.overflowDestroyedWithError).toBe(true);
  });
});
