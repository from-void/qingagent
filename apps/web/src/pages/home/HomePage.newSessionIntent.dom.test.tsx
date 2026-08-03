// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  fetchSessions: vi.fn(async () => undefined),
  removeSession: vi.fn(async () => undefined),
}));

vi.mock("../../stores/sessionStore", () => ({
  useSessionStore: () => ({
    sessions: [],
    error: null,
    fetchSessions: store.fetchSessions,
    removeSession: store.removeSession,
  }),
}));

vi.mock("./components/QingjianScroll", () => ({
  QingjianScroll: ({ onNewSession }: { onNewSession: () => void }) => (
    <button type="button" data-testid="new-session" onClick={onNewSession}>
      新建文档
    </button>
  ),
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

describe("HomePage 新建会话入口", () => {
  beforeEach(() => {
    vi.stubGlobal("__BUILD_INFO__", "test");
    window.history.replaceState(null, "", "#/");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "#/");
  });

  it("新建卡显式携带 new 意图，而不是复用裸 workspace", async () => {
    await act(async () => root.render(<HomePage />));

    await act(async () => {
      host
        .querySelector<HTMLButtonElement>('[data-testid="new-session"]')
        ?.click();
    });

    expect(window.location.hash).toBe("#/workspace?intent=new");
  });
});
