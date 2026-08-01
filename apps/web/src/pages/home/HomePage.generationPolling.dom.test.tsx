// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SessionMeta } from "@qingagent/contract-ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  sessions: [{
    id: "generating-session",
    title: "生成中的文章",
    summary: "正在写作",
    created_at: "2026-08-01T00:00:00.000Z",
    status: { kind: "Active" as const },
    generating: true,
  }] satisfies SessionMeta[],
  fetchSessions: vi.fn(async () => undefined),
  removeSession: vi.fn(async () => undefined),
}));

vi.mock("../../stores/sessionStore", () => ({
  useSessionStore: () => ({
    sessions: store.sessions,
    error: null,
    fetchSessions: store.fetchSessions,
    removeSession: store.removeSession,
  }),
}));

vi.mock("./components/QingjianScroll", () => ({
  QingjianScroll: () => null,
}));

vi.mock("./components/BookCurlShelf", () => ({
  BookCurlShelf: () => null,
}));

vi.mock("../../system/FolderSourceControl", () => ({
  FolderPromptDialog: () => null,
}));

import { HomePage } from "./HomePage";

let host: HTMLDivElement;
let root: Root;

describe("HomePage 生成状态刷新", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("__BUILD_INFO__", "test");
    store.fetchSessions.mockClear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("存在生成中会话时复用首页 fetchSessions 每两秒刷新", async () => {
    await act(async () => root.render(<HomePage />));
    expect(store.fetchSessions).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(store.fetchSessions).toHaveBeenCalledTimes(3);
  });
});
