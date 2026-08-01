// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SessionMeta } from "@qingagent/contract-ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HomeSession } from "./data/sessions";
import { ToastProvider } from "../../system/ToastProvider";

const store = vi.hoisted(() => ({
  sessions: [] as SessionMeta[],
  fetchSessions: vi.fn(),
  removeSession: vi.fn(),
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
  QingjianScroll: ({ sessions }: { sessions: HomeSession[] }) => (
    <div>
      {sessions.map((session) => (
        <div
          key={session.id}
          className="qj-card-slot"
          data-kind="real"
          data-id={session.id}
        >
          {session.title}
        </div>
      ))}
    </div>
  ),
}));

vi.mock("./components/BookCurlShelf", () => ({
  BookCurlShelf: () => null,
}));

vi.mock("../../system/FolderSourceControl", () => ({
  FolderPromptDialog: ({
    children,
  }: {
    children: (controls: { close: (after?: () => void) => void }) => React.ReactNode;
  }) => (
    <div data-wf="MockDeleteDialog">
      {children({ close: (after) => after?.() })}
    </div>
  ),
}));

import { HomePage } from "./HomePage";

const session: SessionMeta = {
  id: "session-1",
  title: "待删除文章",
  summary: "摘要",
  created_at: "2026-07-20T00:00:00.000Z",
  updated_at: "2026-07-21T00:00:00.000Z",
  status: { kind: "Active" },
  generating: false,
};

let host: HTMLDivElement;
let root: Root;

describe("HomePage 删除免提醒偏好", () => {
  beforeEach(async () => {
    window.localStorage.clear();
    vi.stubGlobal("__BUILD_INFO__", "test");
    store.sessions = [session];
    store.fetchSessions.mockReset();
    store.removeSession.mockReset();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(
      <ToastProvider>
        <HomePage />
      </ToastProvider>,
    ));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    window.localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("勾选免提醒但删除失败时不写入期限，下次仍需确认", async () => {
    store.removeSession.mockRejectedValueOnce(new Error("删除失败"));
    await openDeleteConfirm();

    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => checkbox.click());
    expect(checkbox.checked).toBe(true);

    const deleteButton = buttonByText("删除", '[data-wf="MockDeleteDialog"]');
    await act(async () => {
      deleteButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(store.removeSession).toHaveBeenCalledWith(session.id);
    expect(window.localStorage.getItem("home-delete-confirm-skip-until")).toBeNull();
    const toast = document.querySelector<HTMLElement>('[data-toast-key="home-delete-failed"]');
    expect(toast?.className).toContain("error");
    expect(toast?.textContent).toContain("删除失败，请重试");
  });

  it("只有删除成功返回后才写入免提醒期限", async () => {
    let resolveDelete: (() => void) | undefined;
    store.removeSession.mockReturnValueOnce(new Promise<void>((resolve) => {
      resolveDelete = resolve;
    }));
    await openDeleteConfirm();

    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => checkbox.click());
    const deleteButton = buttonByText("删除", '[data-wf="MockDeleteDialog"]');
    await act(async () => deleteButton.click());
    expect(window.localStorage.getItem("home-delete-confirm-skip-until")).toBeNull();

    await act(async () => {
      resolveDelete?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    const expiresAt = Number(
      window.localStorage.getItem("home-delete-confirm-skip-until"),
    );
    expect(expiresAt).toBeGreaterThan(Date.now());
  });
});

async function openDeleteConfirm(): Promise<void> {
  const slot = host.querySelector<HTMLElement>(".qj-card-slot")!;
  await act(async () => {
    slot.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 60,
    }));
  });
  await act(async () => buttonByText("删除", ".home-card-menu").click());
}

function buttonByText(text: string, containerSelector: string): HTMLButtonElement {
  const container = host.querySelector(containerSelector);
  const button = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? [])
    .find((candidate) => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`按钮未找到：${text}`);
  return button;
}
