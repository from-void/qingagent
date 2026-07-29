// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryPanel } from "./MemoryPanel";

const toast = vi.fn();
const toastApi = { show: toast, dismiss: vi.fn() };
vi.mock("../../system/ToastProvider", () => ({
  useToast: () => toastApi,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function renderPanel(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>) {
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<MemoryPanel />);
  });
}

function editor(): HTMLTextAreaElement {
  return host!.querySelector<HTMLTextAreaElement>('textarea[aria-label="长期记忆原文"]')!;
}

function saveButton(): HTMLButtonElement {
  return [...host!.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent === "保存")!;
}

async function edit(value: string) {
  await act(async () => {
    const input = editor();
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("MemoryPanel", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("加载并展示长期记忆原文、字数与下会话生效说明", async () => {
    await renderPanel(vi.fn<typeof fetch>().mockResolvedValue(response({
      content: "# 用户长期记忆\n- 写作风格: 凝练",
      exists: true,
      maxChars: 6000,
    })));

    expect(editor().value).toContain("写作风格: 凝练");
    expect(host!.textContent).toContain("修改将从下一个会话开始生效");
    expect(host!.textContent).toContain("19 / 6000");
  });

  it("编辑后携带 baseContent 保存，并使用统一成功提示", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({
        content: "# 用户长期记忆",
        exists: true,
        maxChars: 6000,
      }))
      .mockResolvedValueOnce(response({
        content: "# 用户长期记忆\n- 新条目",
        exists: true,
        maxChars: 6000,
      }));
    await renderPanel(fetchMock);
    await edit("# 用户长期记忆\n- 新条目");
    await act(async () => saveButton().click());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      content: "# 用户长期记忆\n- 新条目",
      baseContent: "# 用户长期记忆",
    });
    expect(toast).toHaveBeenCalledWith({ message: "记忆已保存", tone: "success" });
  });

  it("超限时不发保存请求并给出清晰提示", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response({
      content: "",
      exists: false,
      maxChars: 10,
    }));
    await renderPanel(fetchMock);
    await edit("超".repeat(11));
    await act(async () => saveButton().click());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith({
      message: "长期记忆不能超过 10 字，请删减后再保存",
      tone: "error",
    });
  });

  it("服务端返回 409 时提示刷新，不静默覆盖", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({
        content: "# 原记忆",
        exists: true,
        maxChars: 6000,
      }))
      .mockResolvedValueOnce(response({
        error: "记忆已被更新，请刷新后再改。",
      }, 409));
    await renderPanel(fetchMock);
    await edit("# 用户修改");
    await act(async () => saveButton().click());

    expect(toast).toHaveBeenCalledWith({
      message: "记忆已被更新，请刷新后再改",
      tone: "error",
    });
  });
});
