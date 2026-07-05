// @vitest-environment jsdom
import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedbackPanel } from "./FeedbackPanel";
import { ToastProvider } from "../../system/ToastProvider";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

describe("FeedbackPanel", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", makeFetchMock(7));
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    document.body.innerHTML = "";
    delete (window as unknown as { electron?: unknown }).electron;
    vi.restoreAllMocks();
  });

  it("提需求卡片链接指向反馈站", async () => {
    await render(<FeedbackPanel />);
    const link = host?.querySelector<HTMLAnchorElement>('[data-wf="FeedbackRequestLink"]');
    expect(link?.getAttribute("href")).toBe("https://qingagent.com/feedback");
    expect(link?.getAttribute("target")).toBe("_blank");
  });

  it("列出最近文档并默认勾选最近 5 篇", async () => {
    await render(<FeedbackPanel />);
    const boxes = docCheckboxes();
    expect(boxes.length).toBe(7);
    expect(boxes.filter((b) => b.checked).length).toBe(5);
    // 默认勾选的是最靠前(最近)的 5 篇
    expect(boxes.slice(0, 5).every((b) => b.checked)).toBe(true);
  });

  it("默认 L1 导出勾选的 sessionIds;桌面端走 IPC", async () => {
    const exportDiagnostics = vi.fn(async () => ({ saved: true, path: "/tmp/qingagent-diag.zip" }));
    (window as unknown as { electron?: unknown }).electron = {
      isDesktop: true,
      platform: "darwin",
      exportDiagnostics,
    };
    await render(<FeedbackPanel />);

    await click(buttonByWf("FeedbackExportButton"));

    expect(exportDiagnostics).toHaveBeenCalledWith({
      privacyLevel: "L1",
      sessionIds: ["s0", "s1", "s2", "s3", "s4"],
    });
    expect(host?.textContent).toContain("报错记录已导出");
  });

  it("勾选“一并导出正文与对话”后走 L2", async () => {
    const exportDiagnostics = vi.fn(async () => ({ saved: true, path: "/tmp/x.zip" }));
    (window as unknown as { electron?: unknown }).electron = {
      isDesktop: true,
      platform: "darwin",
      exportDiagnostics,
    };
    await render(<FeedbackPanel />);

    const include = host?.querySelector<HTMLInputElement>('[data-wf="FeedbackIncludeContent"] input');
    if (!include) throw new Error("include-content checkbox not found");
    await clickNative(include);

    await click(buttonByWf("FeedbackExportButton"));

    expect(exportDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ privacyLevel: "L2" }),
    );
  });
});

async function render(element: ReactElement): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    // 包 ToastProvider:FeedbackPanel 的瞬时反馈已改走 qa-toast,需 provider 才真渲染进 DOM。
    root?.render(<ToastProvider>{element}</ToastProvider>);
  });
  await flush();
}

function makeFetchMock(sessionCount: number) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/v1/home")) {
      // /home 返回 recent_sessions(字段 updated_at),FeedbackPanel 映射为 {id,title,updatedAt}。
      const recent_sessions = Array.from({ length: sessionCount }, (_, i) => ({
        id: `s${i}`,
        title: `文档 ${i}`,
        updated_at: new Date(2026, 6, 5, 12, 0, i).toISOString(),
      }));
      return json({ recent_sessions });
    }
    if (url.includes("/api/v1/diagnostics/export") && init?.method === "POST") {
      return new Response(new Blob(["zip"]), {
        status: 200,
        headers: { "Content-Disposition": 'attachment; filename="qingagent-diag-v1.zip"' },
      });
    }
    return json({});
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function docCheckboxes(): HTMLInputElement[] {
  return Array.from(host?.querySelectorAll<HTMLInputElement>('[data-wf="FeedbackDocList"] input[type="checkbox"]') ?? []);
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

async function clickNative(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await flush();
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function buttonByWf(dataWf: string): HTMLButtonElement {
  const button = host?.querySelector<HTMLButtonElement>(`button[data-wf="${dataWf}"]`);
  if (!button) throw new Error(`${dataWf} not found`);
  return button;
}
