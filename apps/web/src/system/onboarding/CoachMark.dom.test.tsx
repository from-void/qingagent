// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingSettingsProvider } from "./OnboardingSettingsContext";
import { CoachMark } from "./CoachMark";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

describe("CoachMark", () => {
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.querySelectorAll("[data-coach-mark]").forEach((node) => node.remove());
    vi.unstubAllGlobals();
  });

  it("点知道了按唯一 id 持久化，已读后跨挂载不再出现", async () => {
    const seen = new Set<string>();
    const fetchMock = vi.fn<typeof fetch>(async (request, init) => {
      const url = String(request);
      if (init?.method === "PUT") {
        seen.add(url.split("/").pop()!);
        return Response.json({ ok: true });
      }
      return Response.json({
        state: { status: "done", completedAt: "2026-08-17T00:00:00.000Z" },
        coachSeen: [...seen],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderCoach();
    await vi.waitFor(() => expect(document.querySelector('[data-coach-mark="home-new"]')).not.toBeNull());
    const paperTip = document.querySelector<HTMLElement>('[data-coach-mark="home-new"]');
    expect(paperTip?.classList.contains("paper-tip")).toBe(true);
    expect(paperTip?.querySelector(".paper-tip__title-dot")).not.toBeNull();
    expect(paperTip?.querySelector(".paper-tip__title")?.textContent).toContain("从这里开始");
    expect(paperTip?.querySelector(".paper-tip__body")?.textContent).toContain("点开新建文档");
    const gotIt = Array.from(document.querySelectorAll("button")).find((node) => node.textContent === "知道了") as HTMLButtonElement;
    expect(gotIt.classList.contains("wf-btn")).toBe(true);
    expect(gotIt.classList.contains("small")).toBe(true);
    expect(gotIt.classList.contains("ghost")).toBe(true);
    await act(async () => {
      gotIt.click();
      await Promise.resolve();
    });
    expect(seen.has("home-new")).toBe(true);
    expect(document.querySelector('[data-coach-mark="home-new"]')).toBeNull();

    act(() => root.unmount());
    root = createRoot(host);
    await renderCoach();
    await act(async () => Promise.resolve());
    expect(document.querySelector('[data-coach-mark="home-new"]')).toBeNull();
  });

  it("点击锚定控件也会记为已读", async () => {
    const seen = new Set<string>();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (request, init) => {
      const url = String(request);
      if (init?.method === "PUT") {
        seen.add(url.split("/").pop()!);
        return Response.json({ ok: true });
      }
      return Response.json({
        state: { status: "skipped", completedAt: "2026-08-17T00:00:00.000Z" },
        coachSeen: [...seen],
      });
    }));

    await renderCoach();
    await vi.waitFor(() => expect(document.querySelector('[data-coach-mark="home-new"]')).not.toBeNull());
    const anchor = Array.from(host.querySelectorAll("button")).find((node) => node.textContent === "新建文档");
    expect(anchor).toBeTruthy();
    await act(async () => {
      anchor!.click();
      await Promise.resolve();
    });

    expect(seen.has("home-new")).toBe(true);
    expect(document.querySelector('[data-coach-mark="home-new"]')).toBeNull();
  });
});

function CoachHarness() {
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={anchorRef}>新建文档</button>
      <CoachMark
        id="home-new"
        anchor={() => anchorRef.current}
        visible
        placement="right"
        title="从这里开始"
      >
        点开新建文档，告诉青简你想写什么。
      </CoachMark>
    </>
  );
}

async function renderCoach() {
  await act(async () => {
    root.render(
      <OnboardingSettingsProvider>
        <CoachHarness />
      </OnboardingSettingsProvider>,
    );
    await Promise.resolve();
  });
}
