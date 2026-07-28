// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FolderSource, Resource } from "@qingagent/contract-ts";
import type { MaterialParseRow } from "../data/useMaterialParseTracker";
import { buildFolderHoverInfo, LinkedFilesPanel } from "./LinkedFilesPanel";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ entries: [], truncated: false })));
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
  vi.useRealTimers();
});

describe("LinkedFilesPanel", () => {
  it("无素材行且无文件夹时不渲染", async () => {
    await render(panel({ materialRows: [], folderSource: null }));
    expect(host?.querySelector('[data-wf="LinkedFilesBar"]')).toBeNull();
    expect(host?.querySelector('[data-wf="LinkedFilesPanel"]')).toBeNull();
  });

  it("收起态摘要展示文件数量、解析中和文件夹状态", async () => {
    await render(panel({
      materialRows: [readyRow("res-a", "a.pdf"), readyRow("res-b", "b.docx")],
      folderSource: mockFolderSource,
    }));
    expect(getBar().textContent).toContain("2 个素材 · 文件夹「客户资料」 · 14 个文件");

    await rerender(panel({
      materialRows: [errorRow("res-d", "file-d", "d.xlsx", "加密文件无法解析")],
      folderSource: { ...mockFolderSource, status: "missing" },
    }));
    expect(getBar().textContent).toContain("1 个素材(1 个失败) · 文件夹已失效");

    await rerender(panel({
      materialRows: [parsingRow("file-c", "c.pptx")],
      folderSource: null,
    }));
    expect(getBar().textContent).toContain("1 个素材 · 解析中");
    expect(getBar().querySelector(".lf-spin")).not.toBeNull();
  });

  it("细条摘要复用服务端 folder fileCount，统计缺失时不显示统计占位", async () => {
    await render(panel({
      materialRows: [readyRow("res-a", "a.pdf"), readyRow("res-b", "b.docx")],
      folderSource: { ...mockFolderSource, fileCount: 131, fileCountCapped: false },
    }));
    expect(getBar().textContent).toContain("2 个素材 · 文件夹「客户资料」 · 131 个文件");

    await rerender(panel({
      materialRows: [],
      folderSource: { ...mockFolderSource, fileCount: null },
    }));
    expect(getBar().textContent).toContain("文件夹「客户资料」");
    expect(getBar().textContent).not.toContain("统计中…");

    click(getBar());
    expect(getInfo().textContent).toBe("文件夹「客户资料」");
    expect(getInfo().textContent).not.toContain("统计中…");
  });

  it("展开态顶部只保留标题和收起箭头，不重复摘要", async () => {
    await render(panel({
      materialRows: [readyRow("res-a", "a.pdf")],
      folderSource: { ...mockFolderSource, fileCount: 14 },
    }));

    click(getBar());

    const header = getHeader();
    expect(header.textContent).toContain("已关联素材");
    expect(header.textContent).not.toContain("文件夹「客户资料」");
    expect(header.textContent).not.toContain("14 个文件");
    expect(header.querySelector(".lf-summary")).toBeNull();
    expect(getInfo().textContent).toContain("1 个素材 · 文件夹「客户资料」 · 14 个文件");
  });

  it("展开后渲染 ready/parsing/error 行状态，错误行可重试", async () => {
    const onRetry = vi.fn();
    await render(panel({
      materialRows: [
        readyRow("res-ready", "ready.pdf"),
        parsingRow("file-parsing", "parsing.md"),
        errorRow("res-error", "file-error", "broken.pptx", "旧版格式暂不支持"),
      ],
      onRetryMaterialParse: onRetry,
    }));

    click(getBar());

    expect(host?.querySelector('[data-wf="LinkedFilesPanel"]')).not.toBeNull();
    expect(rowByText("ready.pdf").querySelector(".lf-badge")).toBeNull();
    expect(rowByText("parsing.md").querySelector(".lf-spin")).not.toBeNull();
    const error = rowByText("broken.pptx");
    expect(error.textContent).toContain("解析失败");
    click(buttonByText(error, "重试"));
    expect(onRetry).toHaveBeenCalledWith("file-error");
  });

  it("展开态不再提供面板内第二个选择文件入口", async () => {
    await render(panel({
      materialRows: [readyRow("res-ready", "ready.pdf")],
    }));

    click(getBar());

    expect(host?.textContent).not.toContain("选择文件");
    expect(host?.querySelector('[data-wf="LinkedFilesChooseFile"]')).toBeNull();
  });

  it("上传素材收进默认展开的虚拟上传文件夹，折叠后隐藏素材行", async () => {
    await render(panel({
      materialRows: [
        readyRow("res-ready", "ready.pdf"),
        parsingRow("file-parsing", "parsing.md"),
      ],
    }));

    click(getBar());

    const uploadRoot = getUploadsRoot();
    expect(uploadRoot.textContent).toContain("上传文件");
    expect(uploadRoot.textContent).toContain("2 项");
    expect(rowByText("ready.pdf").classList.contains("lvl1")).toBe(true);
    expect(rowByText("parsing.md").classList.contains("lvl1")).toBe(true);

    click(uploadRoot);

    expect(queryRowByText("ready.pdf")).toBeNull();
    expect(queryRowByText("parsing.md")).toBeNull();
  });

  it("点击 ready 素材行会触发素材预览并传出 AssetSource", async () => {
    const onPreviewMaterial = vi.fn();
    await render(panel({
      materialRows: [readyRow("res-ready", "ready.pdf")],
      onPreviewMaterial,
    }));

    click(getBar());
    click(rowByText("ready.pdf"));

    expect(onPreviewMaterial).toHaveBeenCalledTimes(1);
    expect(onPreviewMaterial).toHaveBeenCalledWith(expect.objectContaining({
      id: "res-ready",
      name: "ready.pdf",
      fileId: "file-res-ready",
    }));
  });

  it("懒加载文件夹 entries，并支持截断续载与文件引用", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        entries: [
          { name: "用户访谈", kind: "dir", childCount: 12, byteLen: null },
          { name: "问卷汇总.xlsx", kind: "file", childCount: null, byteLen: 2048 },
        ],
        truncated: true,
      }))
      .mockResolvedValueOnce(jsonResponse({
        entries: [
          { name: "用户访谈", kind: "dir", childCount: 12, byteLen: null },
          { name: "问卷汇总.xlsx", kind: "file", childCount: null, byteLen: 2048 },
          { name: "行业综述.md", kind: "file", childCount: null, byteLen: 88 },
        ],
        truncated: false,
      }));
    vi.stubGlobal("fetch", fetchMock);
    const onReference = vi.fn();

    await render(panel({ folderSource: mockFolderSource, onReference }));
    click(getBar());
    await clickAsync(getFolderRoot());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("limit=200");
    expect(host?.textContent).toContain("用户访谈");
    expect(host?.textContent).toContain("问卷汇总.xlsx");
    expect(host?.textContent).toContain("还有更多项");

    click(buttonByText(host!, "引用"));
    expect(onReference).toHaveBeenCalledWith("问卷汇总.xlsx");

    await clickAsync(getMoreRow());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("limit=400");
    expect(host?.textContent).toContain("行业综述.md");
    expect(host?.textContent).not.toContain("还有更多项");
  });

  it("连接文件夹文件行不渲染预览按钮，可预览类型点行回调，不支持类型点行 toast", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      entries: [
        { name: "纪要.md", kind: "file", childCount: null, byteLen: 88 },
        { name: "hero.png", kind: "file", childCount: null, byteLen: 128 },
        { name: "脚本.ps1", kind: "file", childCount: null, byteLen: 2048 },
      ],
      truncated: false,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const onPreviewFolderFile = vi.fn();
    const onToast = vi.fn();

    await render(panel({ folderSource: mockFolderSource, onPreviewFolderFile, onToast }));
    click(getBar());
    await clickAsync(getFolderRoot());

    const mdRow = rowByText("纪要.md");
    const imageRow = rowByText("hero.png");
    const ps1Row = rowByText("脚本.ps1");
    expect(queryButtonByText(mdRow, "预览")).toBeNull();
    expect(queryButtonByText(imageRow, "预览")).toBeNull();
    expect(queryButtonByText(ps1Row, "预览")).toBeNull();
    expect(buttonByText(ps1Row, "引用")).not.toBeNull();

    click(mdRow);
    expect(onPreviewFolderFile).toHaveBeenCalledWith(expect.objectContaining({
      name: "纪要.md",
      mimeType: "text/markdown; charset=utf-8",
      preview: expect.objectContaining({
        kind: "url",
        url: expect.stringContaining("/api/v1/sessions/s1/folder-sources/fld_test/file?"),
        strictTextContentType: true,
      }),
    }));
    const source = onPreviewFolderFile.mock.calls[0]?.[0];
    expect(source.preview.url).toContain("path=%E7%BA%AA%E8%A6%81.md");
    expect(source.preview.url).toContain("maxBytes=1048576");

    click(ps1Row);
    expect(onPreviewFolderFile).toHaveBeenCalledTimes(1);
    expect(onToast).toHaveBeenCalledWith("该文件不支持预览");
  });

  it("展开子目录会请求对应 childRelPath 并收敛 loading", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("path=images")) {
        return Promise.resolve(jsonResponse({
          entries: [
            { name: "hero.png", kind: "file", childCount: null, byteLen: 128 },
          ],
          truncated: false,
        }));
      }
      return Promise.resolve(jsonResponse({
        entries: [
          { name: "images", kind: "dir", childCount: 1, byteLen: null },
        ],
        truncated: false,
      }));
    });
    vi.stubGlobal("fetch", fetchMock);

    await render(panel({ folderSource: mockFolderSource }));
    click(getBar());
    await clickAsync(getFolderRoot());
    await clickAsync(rowByText("images"));

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("path=images"))).toBe(true);
    expect(host?.textContent).toContain("hero.png");
    expect(host?.querySelector('[data-wf="LinkedFolderLoading"]')).toBeNull();
  });

  it("entries 请求超时后显示可重试错误，避免无限 loading", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchMock);

    await render(panel({ folderSource: mockFolderSource }));
    click(getBar());
    await clickAsync(getFolderRoot());
    expect(host?.textContent).toContain("读取中…");

    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host?.textContent).toContain("读取失败：读取超时，请点击重试");
    click(buttonByText(host!, "重试"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("entries 返回桥不可用错误时展示可操作提示", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ message: "browser bridge 未连接" }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    await render(panel({ folderSource: mockFolderSource }));
    click(getBar());
    await clickAsync(getFolderRoot());

    expect(host?.textContent).toContain("此浏览器会话未连接到该文件夹，请断开后重新连接");
  });

  it("文件夹失效态提供重新连接和断开入口", async () => {
    const onAttachFolder = vi.fn();
    const onDetachFolder = vi.fn();
    await render(panel({
      folderSource: { ...mockFolderSource, status: "missing", error: "找不到原路径" },
      onAttachFolder,
      onDetachFolder,
    }));

    click(getBar());
    const row = getFolderRoot();
    expect(row.textContent).toContain("路径失效");
    click(buttonByText(row, "重新连接"));
    click(buttonByText(row, "断开"));

    expect(onAttachFolder).toHaveBeenCalledTimes(1);
    expect(onDetachFolder).toHaveBeenCalledTimes(1);
  });

  it("文件夹根行状态区只展示状态点和文案，不重复 pathLabel", async () => {
    const source: FolderSource = {
      ...mockFolderSource,
      name: "alipay-site",
      pathLabel: "alipay-site-ai",
      fileCount: 131,
    };
    await render(panel({ folderSource: source }));

    click(getBar());

    const connectedStatus = folderStatusIn(getFolderRoot());
    expect(connectedStatus.textContent).toContain("已连接");
    expect(connectedStatus.querySelector(".lf-folder-dot")?.classList.contains("is-off")).toBe(false);
    expect(connectedStatus.classList.contains("lf-meta")).toBe(false);
    expect(getFolderRoot().querySelector(".lf-folder-label")?.textContent).toContain("alipay-site已连接");
    expect(getFolderRoot().textContent).not.toContain("alipay-site-ai");

    await rerender(panel({
      folderSource: { ...source, status: "missing", error: null },
    }));

    const missingStatus = folderStatusIn(getFolderRoot());
    expect(missingStatus.textContent).toContain("路径失效");
    expect(missingStatus.querySelector(".lf-folder-dot")?.classList.contains("is-off")).toBe(true);
    expect(getFolderRoot().textContent).not.toContain("alipay-site-ai");
  });

  it("底部信息栏无 hover 显示摘要，hover 行后离开会回到摘要", async () => {
    await render(panel({
      materialRows: [errorRow("res-error", "file-error", "broken.pptx", "旧版格式暂不支持")],
    }));

    click(getBar());
    expect(getInfo().textContent).toBe("1 个素材(1 个失败)");
    mouseEnter(rowByText("broken.pptx"));
    expect(getInfo().textContent).toContain("旧版格式暂不支持");
    mouseLeave(rowByText("broken.pptx"));
    expect(getInfo().textContent).toBe("1 个素材(1 个失败)");
  });

  it("文件夹 hover 文案只展示状态信息，不重复路径和计数", () => {
    const info = buildFolderHoverInfo({
      ...mockFolderSource,
      name: "alipay-site-ai",
      pathLabel: "alipay-site-ai",
      mountPath: "alipay-site-ai",
      fileCount: 7,
    });

    expect(info).toBe("已连接");
  });

  it("hover 操作区不参与行高且按钮盒高被固定", () => {
    const css = workspaceCss();

    expect(css).toMatch(/#view-workspace \.lf-row\{[\s\S]*min-height:30px/);
    expect(css).toMatch(/#view-workspace \.lf-row\.has-one-action\{[\s\S]*padding-right:70px/);
    expect(css).toMatch(/#view-workspace \.lf-rowacts\{[\s\S]*position:absolute;[\s\S]*top:50%;[\s\S]*transform:translateY\(-50%\)/);
    expect(css).toMatch(/#view-workspace \.lf-ract\{[\s\S]*height:22px;[\s\S]*line-height:1/);
  });

  it("文件夹名称和状态作为同一段 flex 内容，长名称只省略名称不裁切状态", async () => {
    const css = workspaceCss();
    await render(panel({
      folderSource: {
        ...mockFolderSource,
        name: `${"超长文件夹名".repeat(12)}客户资料`,
      },
    }));

    click(getBar());

    const root = getFolderRoot();
    const label = root.querySelector<HTMLElement>(".lf-folder-label");
    const name = root.querySelector<HTMLElement>(".lf-folder-name");
    const status = folderStatusIn(root);
    expect(label).not.toBeNull();
    expect(label?.contains(name)).toBe(true);
    expect(label?.contains(status)).toBe(true);
    expect(status.textContent).toBe("已连接");
    expect(status.classList.contains("lf-meta")).toBe(false);
    expect(css).toMatch(/#view-workspace \.lf-folder-label\{[\s\S]*display:flex;[\s\S]*gap:7px/);
    expect(css).toMatch(/#view-workspace \.lf-folder-label \.lf-folder-name\{[\s\S]*flex:0 1 auto;[\s\S]*min-width:0/);
    expect(css).toMatch(/#view-workspace \.lf-folder-status\{[\s\S]*flex:0 0 auto;[\s\S]*min-width:max-content/);
    expect(css).toMatch(/#view-workspace \.lf-row:hover \.lf-meta\{display:none\}/);
  });

  it("长文件名链路有横向溢出钳制", async () => {
    const css = workspaceCss();
    const longName = `${"very-long-name-".repeat(18)}.pdf`;

    await render(panel({
      materialRows: [readyRow("res-long", longName)],
    }));
    click(getBar());

    expect(rowByText(longName).textContent).toContain(longName);
    expect(css).toMatch(/#view-workspace \.lf-panel\{[\s\S]*min-width:0;[\s\S]*overflow:hidden/);
    expect(css).toMatch(/#view-workspace \.lf-tree\{[\s\S]*min-width:0;[\s\S]*overflow-x:hidden/);
    expect(css).toMatch(/#view-workspace \.lf-name\{[\s\S]*flex:1 1 auto;[\s\S]*min-width:0;[\s\S]*text-overflow:ellipsis/);
    expect(css).toMatch(/#view-workspace \.lf-info\{[\s\S]*min-width:0;[\s\S]*max-width:100%/);
  });

  it("文件名和信息条 title 只在文本截断时挂载", async () => {
    await render(panel({
      materialRows: [readyRow("res-ready", "ready.pdf")],
    }));

    click(getBar());

    const filename = rowByText("ready.pdf").querySelector<HTMLElement>(".lf-name");
    if (!filename) throw new Error("filename node not found");
    expect(filename.hasAttribute("title")).toBe(false);
    mouseEnter(filename);
    expect(filename.hasAttribute("title")).toBe(false);

    mockOverflow(filename, { scrollWidth: 120, clientWidth: 20 });
    mouseEnter(filename);
    expect(filename.getAttribute("title")).toBe("ready.pdf");
    mouseLeave(rowByText("ready.pdf"));

    const info = getInfo();
    expect(info.textContent).toBe("1 个素材");
    expect(info.hasAttribute("title")).toBe(false);
    mockOverflow(info, { scrollWidth: 160, clientWidth: 30 });
    mouseEnter(info);
    expect(info.getAttribute("title")).toBe("1 个素材");
  });

  it("素材行点击引用后保持面板展开", async () => {
    const onReference = vi.fn();
    await render(panel({
      materialRows: [readyRow("res-ready", "ready.pdf")],
      onReference,
    }));

    click(getBar());
    click(buttonByText(rowByText("ready.pdf"), "引用"));

    expect(onReference).toHaveBeenCalledWith("ready.pdf");
    expect(host?.querySelector('[data-wf="LinkedFilesPanel"]')).not.toBeNull();
    expect(rowByText("ready.pdf")).not.toBeNull();
  });

  it("真实文件夹里的文件点击引用后保持面板展开", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      entries: [
        { name: "问卷汇总.xlsx", kind: "file", childCount: null, byteLen: 2048 },
      ],
      truncated: false,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const onReference = vi.fn();

    await render(panel({ folderSource: mockFolderSource, onReference }));
    click(getBar());
    await clickAsync(getFolderRoot());
    click(buttonByText(rowByText("问卷汇总.xlsx"), "引用"));

    expect(onReference).toHaveBeenCalledWith("问卷汇总.xlsx");
    expect(host?.querySelector('[data-wf="LinkedFilesPanel"]')).not.toBeNull();
    expect(rowByText("问卷汇总.xlsx")).not.toBeNull();
  });

  it("进入已关联文件夹的会话(无关联动作)时 folderSource 到达不自动展开", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ entries: [], truncated: false }));
    vi.stubGlobal("fetch", fetchMock);

    await render(panel({ folderSource: null }));
    expect(host?.querySelector('[data-wf="LinkedFilesPanel"]')).toBeNull();

    await rerender(panel({ folderSource: mockFolderSource }));

    // 只出现收起态细条，不展开面板、不预取目录。
    expect(host?.querySelector('[data-wf="LinkedFilesPanel"]')).toBeNull();
    expect(getBar().textContent).toContain("文件夹「客户资料」");
    expect(fetchMock).not.toHaveBeenCalled();

    // 用户自己点开时也不该有定位闪烁高亮。
    click(getBar());
    expect(getFolderRoot().classList.contains("is-located")).toBe(false);
  });

  it("本会话关联动作后 folderSource 到达会自动展开并高亮文件夹根，且只生效一次", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ entries: [], truncated: false }));
    vi.stubGlobal("fetch", fetchMock);

    await render(panel({ folderSource: null }));
    // 用户点了"连接本地文件夹"并成功返回：信号 +1，此时 folderSource 还没到。
    await rerender(panel({ folderSource: null, folderAttachSignal: 1 }));
    expect(host?.querySelector('[data-wf="LinkedFilesPanel"]')).toBeNull();

    await rerender(panel({ folderSource: mockFolderSource, folderAttachSignal: 1 }));

    expect(host?.querySelector('[data-wf="LinkedFilesPanel"]')).not.toBeNull();
    expect(getFolderRoot().classList.contains("is-located")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 断开后再有 folderSource 到达(没有新的关联动作)不再自动展开。
    await rerender(panel({ folderSource: null, folderAttachSignal: 1 }));
    await rerender(panel({ folderSource: mockFolderSource, folderAttachSignal: 1 }));
    expect(host?.querySelector('[data-wf="LinkedFilesPanel"]')).toBeNull();
  });

  it("切换文件夹来源会取消旧请求且迟到响应不覆盖新来源", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    vi.stubGlobal("fetch", fetchMock);

    await render(panel({ folderSource: mockFolderSource }));
    click(getBar());
    await clickAsync(getFolderRoot());
    const firstSignal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(firstSignal?.aborted).toBe(false);

    const nextSource = {
      ...mockFolderSource,
      sessionId: "s2",
      name: "新会话资料",
    };
    await rerender(panel({ folderSource: nextSource }));
    expect(firstSignal?.aborted).toBe(true);

    await clickAsync(getFolderRoot());
    await act(async () => {
      second.resolve(jsonResponse({
        entries: [{ name: "new.txt", kind: "file", childCount: null, byteLen: 12 }],
        truncated: false,
      }));
      await second.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host?.textContent).toContain("new.txt");

    await act(async () => {
      first.resolve(jsonResponse({
        entries: [{ name: "stale.txt", kind: "file", childCount: null, byteLen: 8 }],
        truncated: false,
      }));
      await first.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host?.textContent).toContain("new.txt");
    expect(host?.textContent).not.toContain("stale.txt");
  });
});

function panel(overrides: Partial<Parameters<typeof LinkedFilesPanel>[0]> = {}): ReactElement {
  return (
    <LinkedFilesPanel
      materialRows={[]}
      folderSource={null}
      onReference={vi.fn()}
      onAttachFolder={vi.fn()}
      onDetachFolder={vi.fn()}
      {...overrides}
    />
  );
}

async function render(element: ReactElement): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await rerender(element);
}

async function rerender(element: ReactElement): Promise<void> {
  await act(async () => {
    root?.render(element);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function getBar(): HTMLElement {
  const bar = host?.querySelector<HTMLElement>('[data-wf="LinkedFilesBar"]');
  if (!bar) throw new Error("LinkedFilesBar not found");
  return bar;
}

function getFolderRoot(): HTMLElement {
  const row = host?.querySelector<HTMLElement>('[data-wf="LinkedFolderRootRow"]');
  if (!row) throw new Error("LinkedFolderRootRow not found");
  return row;
}

function getHeader(): HTMLElement {
  const header = host?.querySelector<HTMLElement>('[data-wf="LinkedFilesPanelHeader"]');
  if (!header) throw new Error("LinkedFilesPanelHeader not found");
  return header;
}

function getUploadsRoot(): HTMLElement {
  const row = host?.querySelector<HTMLElement>('[data-wf="LinkedUploadsRootRow"]');
  if (!row) throw new Error("LinkedUploadsRootRow not found");
  return row;
}

function getMoreRow(): HTMLElement {
  const row = host?.querySelector<HTMLElement>('[data-wf="LinkedFolderMore"]');
  if (!row) throw new Error("LinkedFolderMore not found");
  return row;
}

function getInfo(): HTMLElement {
  const info = host?.querySelector<HTMLElement>('[data-wf="LinkedFilesInfo"]');
  if (!info) throw new Error("LinkedFilesInfo not found");
  return info;
}

function folderStatusIn(rootEl: ParentNode): HTMLElement {
  const status = rootEl.querySelector<HTMLElement>(".lf-folder-status");
  if (!status) throw new Error("folder status not found");
  return status;
}

function rowByText(text: string): HTMLElement {
  const row = queryRowByText(text);
  if (!row) throw new Error(`row not found: ${text}`);
  return row;
}

function queryRowByText(text: string): HTMLElement | null {
  return Array.from(host?.querySelectorAll<HTMLElement>(".lf-row") ?? []).find((item) =>
    item.textContent?.includes(text),
  ) ?? null;
}

function buttonByText(rootEl: ParentNode, text: string): HTMLButtonElement {
  const button = Array.from(rootEl.querySelectorAll<HTMLButtonElement>("button")).find((item) =>
    item.textContent?.includes(text),
  );
  if (!button) throw new Error(`button not found: ${text}`);
  return button;
}

function queryButtonByText(rootEl: ParentNode, text: string): HTMLButtonElement | null {
  return Array.from(rootEl.querySelectorAll<HTMLButtonElement>("button")).find((item) =>
    item.textContent?.includes(text),
  ) ?? null;
}

function click(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function clickAsync(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

function mouseEnter(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
}

function mouseLeave(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
  });
}

function mockOverflow(el: HTMLElement, size: { scrollWidth: number; clientWidth: number }): void {
  Object.defineProperty(el, "scrollWidth", {
    configurable: true,
    value: size.scrollWidth,
  });
  Object.defineProperty(el, "clientWidth", {
    configurable: true,
    value: size.clientWidth,
  });
}

function workspaceCss(): string {
  return readFileSync(`${process.cwd()}/src/pages/workspace/workspace.css`, "utf8");
}

function readyRow(id: string, filename: string): MaterialParseRow {
  const resource = resourceFor(id, filename, { fileId: `file-${id}` });
  return {
    id,
    fileId: `file-${id}`,
    filename,
    mime: "application/pdf",
    state: "ready",
    parseError: null,
    resource,
    source: "resource",
  };
}

function parsingRow(fileId: string, filename: string): MaterialParseRow {
  return {
    id: `local:${fileId}`,
    fileId,
    filename,
    mime: "text/markdown",
    state: "parsing",
    parseError: null,
    resource: null,
    source: "local",
  };
}

function errorRow(id: string, fileId: string, filename: string, reason: string): MaterialParseRow {
  const resource = resourceFor(id, filename, {
    fileId,
    parseState: "error",
    parseError: reason,
  });
  return {
    id,
    fileId,
    filename,
    mime: "application/vnd.ms-powerpoint",
    state: "error",
    parseError: reason,
    resource,
    source: "resource",
  };
}

function resourceFor(id: string, displayName: string, metadata: unknown): Resource {
  return {
    resourceRef: { id, domain: { kind: "file" } },
    displayName,
    summary: "",
    mime: "application/pdf",
    byteLen: 8200,
    createdAt: "2026-07-04T00:00:00.000Z",
    metadata,
  };
}

const mockFolderSource: FolderSource = {
  id: "fld_test",
  sessionId: "s1",
  provider: "desktop-local",
  name: "客户资料",
  pathLabel: "~/Documents/客户资料",
  mountName: "source_test",
  mountPath: "/sources/source_test",
  readOnly: true,
  fileCount: 14,
  fileCountCapped: false,
  status: "connected",
  error: null,
  createdAt: "2026-06-18T00:00:00.000Z",
  updatedAt: "2026-06-18T00:00:00.000Z",
};
