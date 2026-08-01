import type { SessionMeta } from "@qingagent/contract-ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "./sessionStore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function session(id: string): SessionMeta {
  return {
    id,
    title: id,
    created_at: "2026-07-19T00:00:00.000Z",
    summary: "",
    status: { kind: "Active" },
    generating: false,
  };
}

function homeResponse(sessions: SessionMeta[]): Response {
  return new Response(JSON.stringify({ recent_sessions: sessions }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("sessionStore", () => {
  beforeEach(() => {
    useSessionStore.setState({
      sessions: [],
      currentSessionId: null,
      currentSessionTitle: null,
      isLoading: false,
      error: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("乱序列表请求只采用最新响应", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    vi.stubGlobal("fetch", fetchMock);

    const firstRequest = useSessionStore.getState().fetchSessions();
    const secondRequest = useSessionStore.getState().fetchSessions();

    second.resolve(homeResponse([session("latest-session")]));
    await secondRequest;
    first.resolve(homeResponse([session("stale-session")]));
    await firstRequest;

    expect(useSessionStore.getState()).toMatchObject({
      sessions: [expect.objectContaining({ id: "latest-session" })],
      isLoading: false,
      error: null,
    });
  });

  it("删除成功会使在途列表失效且旧响应不能复活已删会话", async () => {
    const pendingHome = deferred<Response>();
    const removed = session("removed-session");
    useSessionStore.setState({ sessions: [removed] });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(pendingHome.promise)
      .mockResolvedValueOnce(new Response(JSON.stringify({ deleted: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const listRequest = useSessionStore.getState().fetchSessions();
    await useSessionStore.getState().removeSession(removed.id);
    pendingHome.resolve(homeResponse([removed, session("kept-session")]));
    await listRequest;

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/v1/sessions/${removed.id}`,
      { method: "DELETE" },
    );
    expect(useSessionStore.getState().sessions).toEqual([]);
    expect(useSessionStore.getState().isLoading).toBe(false);
  });

  it("RF1: 202 响应保留会话并标记删除中，完成响应后才移除", async () => {
    vi.useFakeTimers();
    const removing = session("pending-session");
    useSessionStore.setState({ sessions: [removing] });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ deleted: false, status: "pending" }),
        { status: 202, headers: { "content-type": "application/json" } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ deleted: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      ));
    vi.stubGlobal("fetch", fetchMock);

    await useSessionStore.getState().removeSession(removing.id);

    expect(useSessionStore.getState().sessions).toEqual([
      expect.objectContaining({ id: removing.id, status: { kind: "Deleting" } }),
    ]);

    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(useSessionStore.getState().sessions).toEqual([]);
    vi.useRealTimers();
  });
});
