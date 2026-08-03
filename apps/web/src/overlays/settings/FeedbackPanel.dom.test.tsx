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
    vi.useRealTimers();
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
    vi.useFakeTimers();

    await click(buttonByWf("FeedbackExportButton"));

    expect(exportDiagnostics).toHaveBeenCalledWith({
      privacyLevel: "L1",
      sessionIds: ["s0", "s1", "s2", "s3", "s4"],
    });
    const successToast = toastNode();
    expect(successToast.textContent).toContain("已导出");
    expect(successToast.textContent).toContain("/tmp/qingagent-diag.zip");

    // 完整路径不是一闪而过的短提示：跨过 qa-toast 的全局默认 2.4s 后仍应可见。
    await act(async () => {
      vi.advanceTimersByTime(2_400);
    });
    expect(toastNode().textContent).toContain("报错记录已导出至：/tmp/qingagent-diag.zip");
    expect(buttonByWf("FeedbackExportButton").disabled).toBe(false);
    expect(buttonByWf("FeedbackExportButton").textContent).toBe("导出报错记录");
  });

  it("首拉在途:文档列表不渲染「读取文档列表中」占位(切 tab 闪帧根治)", async () => {
    const pending = new Promise<Response>(() => {});
    vi.stubGlobal("fetch", vi.fn(() => pending));
    await render(<FeedbackPanel />);

    const list = host?.querySelector('[data-wf="FeedbackDocList"]');
    expect(list?.textContent).toBe("");
    expect(host?.textContent).not.toContain("读取文档列表中");
    expect(host?.textContent).not.toContain("暂无文档");
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

  it("文档列表加载失败时显示失败态，并允许按 L1 空 sessionIds 导出", async () => {
    const exportDiagnostics = vi.fn(async () => ({ saved: true, path: "/tmp/diag.zip" }));
    (window as unknown as { electron?: unknown }).electron = {
      isDesktop: true,
      platform: "darwin",
      exportDiagnostics,
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/v1/home")) return json({ error: "unavailable" }, 503);
      return json({});
    }));

    await render(<FeedbackPanel />);

    expect(host?.textContent).toContain("文档列表暂时无法加载");
    expect(host?.textContent).not.toContain("暂无文档");
    expect(buttonByWf("FeedbackExportButton").disabled).toBe(false);

    await click(buttonByWf("FeedbackExportButton"));

    expect(exportDiagnostics).toHaveBeenCalledWith({
      privacyLevel: "L1",
      sessionIds: [],
    });
  });

  it("文档列表成功返回空数组时仍显示真实空态并禁用导出", async () => {
    vi.stubGlobal("fetch", makeFetchMock(0));

    await render(<FeedbackPanel />);

    expect(host?.textContent).toContain("暂无文档");
    expect(host?.textContent).not.toContain("文档列表暂时无法加载");
    expect(buttonByWf("FeedbackExportButton").disabled).toBe(true);
  });

  it("桌面写盘失败时显示中文错误 toast 并恢复导出按钮", async () => {
    const exportDiagnostics = vi.fn(async () => ({
      saved: false as const,
      reason: "write-failed" as const,
    }));
    (window as unknown as { electron?: unknown }).electron = {
      isDesktop: true,
      platform: "win32",
      exportDiagnostics,
    };
    await render(<FeedbackPanel />);

    await click(buttonByWf("FeedbackExportButton"));

    expect(toastNode().textContent).toContain("导出失败，未生成文件，请稍后重试");
    expect(toastNode().textContent).not.toContain("已取消导出");
    expect(buttonByWf("FeedbackExportButton").disabled).toBe(false);
    expect(buttonByWf("FeedbackExportButton").textContent).toBe("导出报错记录");
  });

  it("桌面 IPC 拒绝时显示中文错误 toast 并恢复导出按钮", async () => {
    const exportDiagnostics = vi.fn(async () => {
      throw new Error("raw ipc failure");
    });
    (window as unknown as { electron?: unknown }).electron = {
      isDesktop: true,
      platform: "win32",
      exportDiagnostics,
    };
    await render(<FeedbackPanel />);

    await click(buttonByWf("FeedbackExportButton"));

    expect(toastNode().textContent).toContain("导出失败，未生成文件，请稍后重试");
    expect(toastNode().textContent).not.toContain("raw ipc failure");
    expect(buttonByWf("FeedbackExportButton").disabled).toBe(false);
    expect(buttonByWf("FeedbackExportButton").textContent).toBe("导出报错记录");
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

function toastNode(): HTMLElement {
  const toast = host?.querySelector<HTMLElement>('[data-wf="GlobalToast"]');
  if (!toast) throw new Error("global toast not found");
  return toast;
}
