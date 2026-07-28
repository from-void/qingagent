// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeAll, describe, expect, it } from "vitest";
import { shouldShowAiSummary } from "./AssetPreview";
import { AssetPreview } from "./AssetPreview";
import { toAssetSource } from "../data/sources";
import type { AssetSource } from "../data/sources";
import type { Resource } from "@qingagent/contract-ts";
import { afterEach, vi } from "vitest";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  host?.remove();
  host = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// 素材预览"摘要"与"AI 摘要"同源(都是 material.summary)——内容相同时只显示一处。

describe("shouldShowAiSummary 摘要去重", () => {
  it("summary 与顶部摘要相同时不再显示 AI 摘要(修复同一段摘要渲染两遍)", () => {
    expect(shouldShowAiSummary("同一段摘要", "同一段摘要")).toBe(false);
  });

  it("summary 为空不显示", () => {
    expect(shouldShowAiSummary(null, "顶部摘要")).toBe(false);
    expect(shouldShowAiSummary("", "顶部摘要")).toBe(false);
  });

  it("summary 与顶部摘要不同(或顶部无摘要)时正常显示", () => {
    expect(shouldShowAiSummary("接口返回的更详细摘要", "顶部短摘要")).toBe(true);
    expect(shouldShowAiSummary("有摘要", "")).toBe(true);
  });
});

describe("toAssetSource 来源链接映射", () => {
  const baseResource = {
    resourceRef: { id: "mat-1", domain: { kind: "file" } },
    displayName: "甲站文章",
    summary: "摘要",
    mime: "text/html",
    byteLen: 100,
    createdAt: "2026-06-11T00:00:00Z",
  };

  it("metadata.sourceUrl 透传到 AssetSource(抓取类素材可溯源)", () => {
    const source = toAssetSource({
      ...baseResource,
      metadata: { fileId: undefined, sourceUrl: "https://a.example.com/1" },
    } as unknown as Resource);
    expect(source.sourceUrl).toBe("https://a.example.com/1");
  });

  it("上传类素材无 sourceUrl 时为 undefined(不渲染来源区块)", () => {
    const source = toAssetSource({
      ...baseResource,
      metadata: { fileId: "f-1" },
    } as unknown as Resource);
    expect(source.sourceUrl).toBeUndefined();
  });

  it("metadata.updatedAt 透传为正文版本号", () => {
    const source = toAssetSource({
      ...baseResource,
      metadata: {
        fileId: "f-1",
        updatedAt: "2026-07-28T01:02:03.000Z",
      },
    } as unknown as Resource);

    expect(source.updatedAt).toBe("2026-07-28T01:02:03.000Z");
    expect(source.bodyText).toBe("");
  });
});

describe("AssetPreview 摘要编辑", () => {
  it("busy 时禁用摘要输入框", async () => {
    await render(
      <AssetPreview
        source={assetSource({ abstract: "旧摘要" })}
        sessionId={null}
        onClose={() => undefined}
        onEditSummary={() => true}
        summaryEditDisabled
      />,
    );

    expect(getSummaryTextarea().disabled).toBe(true);
  });

  it("父级拒绝保存时不推进本地 savedRef 并回退文本", async () => {
    const onEditSummary = vi.fn(() => false);
    await render(
      <AssetPreview
        source={assetSource({ abstract: "旧摘要" })}
        sessionId={null}
        onClose={() => undefined}
        onEditSummary={onEditSummary}
      />,
    );

    const textarea = getSummaryTextarea();
    await act(async () => {
      setTextareaValue(textarea, "新摘要");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });

    expect(onEditSummary).toHaveBeenCalledWith("mat-1", "新摘要");
    expect(textarea.value).toBe("旧摘要");
  });
});

describe("AssetPreview 连接文件夹预览来源", () => {
  it("即使父级传入 onEditSummary 也不渲染素材摘要编辑框", async () => {
    const fileUrl = "/api/v1/sessions/s1/folder-sources/fld/file?path=notes.md&maxBytes=1048576";
    const fetchMock = vi.fn(async () => new Response("# 标题\n真实正文", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await render(
      <AssetPreview
        source={assetSource({
          id: "folder:fld:notes.md",
          tag: "yuque",
          name: "notes.md",
          abstract: "不应作为素材摘要展示",
          mimeType: "text/markdown; charset=utf-8",
          preview: {
            kind: "url",
            url: fileUrl,
            strictTextContentType: true,
          },
        })}
        sessionId="s1"
        onClose={() => undefined}
        onEditSummary={() => true}
      />,
    );
    await flushMicrotasks();

    expect(host?.querySelector(".fd-rp-sum-ta")).toBeNull();
    expect(host?.querySelector(".fd-rp-abs")).toBeNull();
    expect(host?.textContent).not.toContain("不应作为素材摘要展示");
  });

  it("文本文件通过 folder /file URL 拉取真实正文", async () => {
    const fileUrl = "/api/v1/sessions/s1/folder-sources/fld/file?path=notes.md&maxBytes=1048576";
    const fetchMock = vi.fn(async () => new Response("# 标题\n真实正文", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await render(
      <AssetPreview
        source={assetSource({
          id: "folder:fld:notes.md",
          tag: "yuque",
          name: "notes.md",
          mimeType: "text/markdown; charset=utf-8",
          preview: {
            kind: "url",
            url: fileUrl,
            strictTextContentType: true,
          },
        })}
        sessionId="s1"
        onClose={() => undefined}
      />,
    );
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledWith(fileUrl);
    expect(host?.textContent).toContain("真实正文");
  });

  it("图片文件直接用 folder /file URL 作为 img src", async () => {
    const fileUrl = "/api/v1/sessions/s1/folder-sources/fld/file?path=hero.png&maxBytes=20971520";

    await render(
      <AssetPreview
        source={assetSource({
          id: "folder:fld:hero.png",
          tag: "png",
          name: "hero.png",
          mimeType: "image/png",
          preview: { kind: "url", url: fileUrl },
        })}
        sessionId="s1"
        onClose={() => undefined}
      />,
    );

    expect(host?.querySelector("img")?.getAttribute("src")).toBe(fileUrl);
  });

  it("PDF 文件校验响应与签名后使用 Blob URL，并在卸载时释放", async () => {
    const fileUrl = "/api/v1/sessions/s1/folder-sources/fld/file?path=report.pdf&maxBytes=20971520";
    const fetchMock = vi.fn(async () => new Response("%PDF-1.7\n内容", {
      status: 200,
      headers: { "Content-Type": "application/pdf" },
    }));
    const { createObjectURL, revokeObjectURL } = mockObjectUrl();
    vi.stubGlobal("fetch", fetchMock);

    await render(
      <AssetPreview
        source={assetSource({
          id: "folder:fld:report.pdf",
          tag: "pdf",
          name: "report.pdf",
          mimeType: "application/pdf",
          preview: { kind: "url", url: fileUrl },
        })}
        sessionId="s1"
        onClose={() => undefined}
      />,
    );
    await flushMicrotasks(8);

    expect(fetchMock).toHaveBeenCalledWith(fileUrl);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(host?.querySelector("iframe")?.getAttribute("src")).toBe("blob:validated-pdf");

    await act(async () => {
      root?.unmount();
      root = null;
    });
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:validated-pdf");
  });

  it.each([
    ["请求失败", new Response("missing", { status: 404 })],
    ["类型错误", new Response("%PDF-1.7", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    })],
    ["签名错误", new Response("<html>not pdf</html>", {
      status: 200,
      headers: { "Content-Type": "application/pdf" },
    })],
  ])("PDF %s 时显示现有内联不可用状态", async (_caseName, response) => {
    vi.stubGlobal("fetch", vi.fn(async () => response));
    mockObjectUrl();

    await render(
      <AssetPreview
        source={assetSource({
          id: "folder:fld:report.pdf",
          tag: "pdf",
          name: "report.pdf",
          mimeType: "application/pdf",
          preview: {
            kind: "url",
            url: "/api/v1/sessions/s1/folder-sources/fld/file?path=report.pdf&maxBytes=20971520",
          },
        })}
        sessionId="s1"
        onClose={() => undefined}
      />,
    );
    await flushMicrotasks(8);

    expect(host?.querySelector("iframe")).toBeNull();
    expect(host?.querySelector(".fd-rp-body-text")?.textContent).toBe("预览不可用");
  });
});

describe("AssetPreview 内部素材正文", () => {
  it("无 scoped 请求上下文的静态来源仍使用自身完整 bodyText", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await render(
      <AssetPreview
        source={assetSource({ bodyText: "静态来源完整正文" })}
        sessionId={null}
        onClose={() => undefined}
      />,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(host?.querySelector(".fd-rp-body-text")?.textContent).toBe("静态来源完整正文");
  });

  it("正文请求失败时不把摘要伪装成正文", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));

    await render(
      <AssetPreview
        source={assetSource({
          abstract: "仅供列表展示的短摘要",
          bodyText: "仅供列表展示的短摘要",
        })}
        sessionId="s1"
        onClose={() => undefined}
      />,
    );
    await flushMicrotasks();

    const body = host?.querySelector(".fd-rp-body-text");
    expect(body?.textContent).toBe("预览不可用");
    expect(body?.textContent).not.toContain("仅供列表展示的短摘要");
  });

  it("同一素材 updatedAt 推进时清空旧正文并重新拉取", async () => {
    let resolveUpdated: (response: Response) => void = () => undefined;
    const updatedResponse = new Promise<Response>((resolve) => {
      resolveUpdated = resolve;
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ text: "旧正文", summary: null }))
      .mockReturnValueOnce(updatedResponse);
    vi.stubGlobal("fetch", fetchMock);
    const source = assetSource({ updatedAt: "2026-07-28T01:00:00.000Z" });

    await render(
      <AssetPreview source={source} sessionId="s1" onClose={() => undefined} />,
    );
    await flushMicrotasks();
    expect(host?.querySelector(".fd-rp-body-text")?.textContent).toBe("旧正文");

    await act(async () => {
      root?.render(
        <AssetPreview
          source={{ ...source, updatedAt: "2026-07-28T01:00:01.000Z" }}
          sessionId="s1"
          onClose={() => undefined}
        />,
      );
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(host?.querySelector(".fd-rp-body-text")?.textContent).toBe("加载中...");
    expect(host?.textContent).not.toContain("旧正文");

    await act(async () => {
      resolveUpdated(Response.json({ text: "新正文", summary: null }));
      await updatedResponse;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host?.querySelector(".fd-rp-body-text")?.textContent).toBe("新正文");
  });
});

async function render(element: ReactNode): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(element);
  });
}

async function flushMicrotasks(times = 4): Promise<void> {
  await act(async () => {
    for (let i = 0; i < times; i += 1) await Promise.resolve();
  });
}

function getSummaryTextarea(): HTMLTextAreaElement {
  const textarea = host?.querySelector<HTMLTextAreaElement>(".fd-rp-sum-ta");
  if (!textarea) throw new Error("summary textarea not found");
  return textarea;
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(textarea, value);
}

function assetSource(overrides: Partial<AssetSource> = {}): AssetSource {
  return {
    id: "mat-1",
    tag: "yuque",
    name: "材料.txt",
    meta: "文本",
    abstract: "",
    bodyText: "",
    ...overrides,
  };
}

function mockObjectUrl(): {
  createObjectURL: ReturnType<typeof vi.fn>;
  revokeObjectURL: ReturnType<typeof vi.fn>;
} {
  const NativeURL = URL;
  const createObjectURL = vi.fn(() => "blob:validated-pdf");
  const revokeObjectURL = vi.fn();
  class MockURL extends NativeURL {
    static createObjectURL = createObjectURL;
    static revokeObjectURL = revokeObjectURL;
  }
  vi.stubGlobal("URL", MockURL);
  return { createObjectURL, revokeObjectURL };
}
