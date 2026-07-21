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
  const events = new EventEmitter();
  const route = vi.fn<
    (url: string, handler: (route: unknown) => Promise<void>) => Promise<void>
  >(async () => undefined);
  const routeWebSocket = vi.fn<
    (url: string, handler: (route: unknown) => Promise<void>) => Promise<void>
  >(async () => undefined);
  return {
    context: {
      route,
      routeWebSocket,
      on: events.on.bind(events),
      once: events.once.bind(events),
      off: events.off.bind(events),
    } as unknown as BrowserContext,
    route,
    routeWebSocket,
    close: () => events.emit("close"),
  };
}

function createRoute(fulfill: () => Promise<void> = async () => undefined) {
  const state = { abortReason: undefined as string | undefined, fulfilled: false };
  return {
    route: {
      request: () => ({
        url: () => "http://1.1.1.1/large.bin",
        resourceType: () => "fetch",
        allHeaders: async () => ({}),
        method: () => "GET",
        postDataBuffer: () => null,
      }),
      fulfill: async () => {
        state.fulfilled = true;
        await fulfill();
      },
      abort: async (reason: string) => {
        state.abortReason = reason;
      },
    },
    state,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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

  it("固定 IP 回填在 fulfill 完成前持续持有预算租约", async () => {
    const mocked = mockContext();
    await installBrowserRequestPolicy(mocked.context, { pinHttpRequests: true });
    const handler = mocked.route.mock.calls[0]?.[1] as (route: unknown) => Promise<void>;
    const fulfillGate = deferred();
    const incomings = Array.from({ length: 6 }, createIncoming);
    mockHttpResponses(incomings);
    const heldRoutes = Array.from({ length: 4 }, () => createRoute(() => fulfillGate.promise));
    const heldCompletions = heldRoutes.map(({ route }) => handler(route));
    await vi.waitFor(() => expect(requestMocks.httpRequest).toHaveBeenCalledTimes(4));
    for (const incoming of incomings.slice(0, 4)) incoming.end(Buffer.alloc(24 * 1024 * 1024));
    await vi.waitFor(() =>
      expect(heldRoutes.every(({ state }) => state.fulfilled)).toBe(true),
    );

    const rejected = createRoute();
    const rejectedCompletion = handler(rejected.route);
    await vi.waitFor(() => expect(requestMocks.httpRequest).toHaveBeenCalledTimes(5));
    incomings[4]!.end(Buffer.from([1]));
    await rejectedCompletion;
    expect(rejected.state).toEqual({ abortReason: "blockedbyclient", fulfilled: false });

    fulfillGate.resolve();
    await Promise.all(heldCompletions);
    const recovered = createRoute();
    const recoveredCompletion = handler(recovered.route);
    await vi.waitFor(() => expect(requestMocks.httpRequest).toHaveBeenCalledTimes(6));
    incomings[5]!.end(Buffer.from([1]));
    await recoveredCompletion;
    expect(recovered.state).toEqual({ abortReason: undefined, fulfilled: true });
  });

  it("context 总预算按响应体 base64 化后的 4/3 成本计费", async () => {
    const mocked = mockContext();
    await installBrowserRequestPolicy(mocked.context, { pinHttpRequests: true });
    const handler = mocked.route.mock.calls[0]?.[1] as (route: unknown) => Promise<void>;
    const fulfillGate = deferred();
    const incomings = Array.from({ length: 4 }, createIncoming);
    mockHttpResponses(incomings);
    const heldRoutes = Array.from({ length: 3 }, () => createRoute(() => fulfillGate.promise));
    const heldCompletions = heldRoutes.map(({ route }) => handler(route));
    await vi.waitFor(() => expect(requestMocks.httpRequest).toHaveBeenCalledTimes(3));
    for (const incoming of incomings.slice(0, 3)) {
      incoming.end(Buffer.alloc(32 * 1024 * 1024 - 1));
    }
    await vi.waitFor(() =>
      expect(heldRoutes.every(({ state }) => state.fulfilled)).toBe(true),
    );

    const overflow = createRoute();
    const overflowCompletion = handler(overflow.route);
    await vi.waitFor(() => expect(requestMocks.httpRequest).toHaveBeenCalledTimes(4));
    // 前三份按 4/3 计费后只剩 2 字节；2 原始字节会计为 3 字节，必须被拒。
    incomings[3]!.end(Buffer.from([1, 2]));
    await overflowCompletion;
    expect(overflow.state).toEqual({ abortReason: "blockedbyclient", fulfilled: false });
    fulfillGate.resolve();
    await Promise.all(heldCompletions);
  });

  it("context 关闭会中止未结束的固定 IP 请求并销毁响应流", async () => {
    const mocked = mockContext();
    await installBrowserRequestPolicy(mocked.context, { pinHttpRequests: true });
    const handler = mocked.route.mock.calls[0]?.[1] as (route: unknown) => Promise<void>;
    const incoming = createIncoming();
    const destroy = vi.spyOn(incoming, "destroy");
    mockHttpResponses([incoming]);
    const pending = createRoute();
    const completion = handler(pending.route);
    await vi.waitFor(() => expect(requestMocks.httpRequest).toHaveBeenCalledOnce());
    incoming.write(Buffer.alloc(1024));

    mocked.close();

    await completion;
    expect(destroy).toHaveBeenCalled();
    expect(incoming.destroyed).toBe(true);
    expect(pending.state).toEqual({ abortReason: "blockedbyclient", fulfilled: false });

    const fresh = mockContext();
    await installBrowserRequestPolicy(fresh.context, { pinHttpRequests: true });
    const freshHandler = fresh.route.mock.calls[0]?.[1] as (route: unknown) => Promise<void>;
    const freshIncoming = createIncoming();
    mockHttpResponses([freshIncoming]);
    const freshRoute = createRoute();
    const freshCompletion = freshHandler(freshRoute.route);
    freshIncoming.end(Buffer.alloc(32 * 1024 * 1024));
    await freshCompletion;
    expect(freshRoute.state.fulfilled).toBe(true);
  });
});
