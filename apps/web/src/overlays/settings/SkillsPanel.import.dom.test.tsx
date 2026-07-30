// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../../system", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  useClientCapabilities: () => ({ skills: { mutationEnabled: true } }),
}));

import { ConfirmProvider } from "../../system";
import { ToastProvider } from "../../system/ToastProvider";
import { SkillsPanel } from "./SkillsPanel";

const skill = {
  name: "custom-research",
  description: "自装研究技能",
  label: "研资料",
  summary: "整理用户资料",
  icon: "star",
  source: "installed" as const,
  userInvocable: true,
  tools: [] as string[],
  enabled: true,
  children: [],
};
const skillDetail = {
  ...skill,
  body: "# 研资料\n\n导入后进入详情。",
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function renderPanel(): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <ToastProvider>
        <ConfirmProvider>
          <SkillsPanel />
        </ConfirmProvider>
      </ToastProvider>,
    );
  });
}

function importInput(): HTMLInputElement {
  const input = host?.querySelector<HTMLInputElement>('[data-wf="SkillImportInput"]');
  if (!input) throw new Error("SkillImportInput not found");
  return input;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function minimalSkillFile(): File {
  const md = [
    "---",
    "name: custom-research",
    "description: 自装研究技能",
    "---",
    "# 研资料",
  ].join("\n");
  const file = new File([md], "custom-research.md", { type: "text/markdown" });
  Object.defineProperty(file, "text", {
    configurable: true,
    value: async () => md,
  });
  return file;
}

async function submitFile(file: File): Promise<void> {
  const input = importInput();
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [file],
  });
  expect(input.files).toHaveLength(1);
  act(() => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function toastByMessage(message: string): HTMLElement | null {
  return Array.from(document.body.querySelectorAll<HTMLElement>('[data-wf="GlobalToast"]'))
    .find((node) => node.textContent?.includes(message)) ?? null;
}

describe("SkillsPanel 导入提交终态", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("真实 File 产生 POST，立即 pending；列表与详情对账后才显示成功回执", async () => {
    let installed = false;
    let resolveInstall!: (response: Response) => void;
    const installResponse = new Promise<Response>((resolve) => {
      resolveInstall = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/skills/install") {
        expect(init?.method).toBe("POST");
        expect(init?.headers).toEqual({ "Content-Type": "application/json" });
        const body = JSON.parse(String(init?.body)) as { skillMd?: string };
        expect(body.skillMd).toContain("name: custom-research");
        const response = await installResponse;
        installed = true;
        return response;
      }
      if (url === "/api/v1/skills/custom-research") return jsonResponse(skillDetail);
      if (url === "/api/v1/skills") {
        return jsonResponse({ skills: installed ? [skill] : [] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await renderPanel();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/skills"));

    await submitFile(minimalSkillFile());
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/v1/skills/install"))
        .toBe(true);
    });
    const importButton = host?.querySelector<HTMLButtonElement>('[data-wf="SkillImportButton"]');
    expect(importButton?.disabled).toBe(true);
    expect(importButton?.textContent).toContain("导入中…");
    expect(toastByMessage("技能已导入")).toBeNull();

    resolveInstall(jsonResponse({ name: "custom-research" }));
    await vi.waitFor(() => {
      expect(host?.textContent).toContain("技能详情");
      expect(host?.textContent).toContain("研资料");
      expect(toastByMessage("技能已导入")).not.toBeNull();
    });
  });

  it("POST 失败显示常驻可读失败与重新选择，不泄漏英文内部错误", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/skills/install") {
        return jsonResponse({ error: "invalid frontmatter stack trace" }, 422);
      }
      if (url === "/api/v1/skills") return jsonResponse({ skills: [] });
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await renderPanel();
    const input = importInput();
    const clickSpy = vi.spyOn(input, "click");

    await submitFile(minimalSkillFile());
    await vi.waitFor(() => {
      expect(toastByMessage("技能导入失败，请重试")).not.toBeNull();
    });
    const toast = toastByMessage("技能导入失败，请重试");
    expect(toast?.classList.contains("sticky")).toBe(true);
    expect(toast?.textContent).not.toContain("frontmatter");
    const retry = toast?.querySelector<HTMLButtonElement>(".qa-toast-act");
    expect(retry?.textContent).toBe("重新选择");
    act(() => retry?.click());
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("POST 成功但首次列表刷新失败时明确部分成功，重新加载只对账、不重复安装", async () => {
    let installed = false;
    let failNextListRefresh = false;
    let installCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/skills/install") {
        installCount += 1;
        installed = true;
        failNextListRefresh = true;
        return jsonResponse({ name: "custom-research" });
      }
      if (url === "/api/v1/skills/custom-research") return jsonResponse(skillDetail);
      if (url === "/api/v1/skills") {
        if (failNextListRefresh) {
          failNextListRefresh = false;
          return jsonResponse({ error: "temporarily unavailable" }, 503);
        }
        return jsonResponse({ skills: installed ? [skill] : [] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await renderPanel();

    await submitFile(minimalSkillFile());
    await vi.waitFor(() => {
      expect(toastByMessage("技能已安装，但列表尚未刷新")).not.toBeNull();
    });
    const partialToast = toastByMessage("技能已安装，但列表尚未刷新");
    expect(partialToast?.classList.contains("sticky")).toBe(true);
    const reload = partialToast?.querySelector<HTMLButtonElement>(".qa-toast-act");
    expect(reload?.textContent).toBe("重新加载");

    act(() => reload?.click());
    await vi.waitFor(() => {
      expect(host?.textContent).toContain("技能详情");
      expect(toastByMessage("技能列表已刷新")).not.toBeNull();
    });
    expect(installCount).toBe(1);
  });
});
