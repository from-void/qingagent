import { act, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "../../../../system";
import { registerOverlay, resetOverlayDismissStackForTest } from "../../../../system/overlayDismissStack";
import { DerivTabBar } from "./DerivTabBar";
import { DerivativeGenerateModal, MAX_TRANSLATION_LANGUAGES, TRANSLATION_LANGUAGES } from "./DerivativeGenerateModal";
import { DerivativeView } from "./DerivativeView";
import type { DerivativeItem } from "./types";
import {
  buildTranslationAgentQuery,
  buildTranslationDisplayCard,
  DTYPE_REGISTRY,
} from "./dtypeRegistry";
import { calculatePhoneScale } from "./PhoneShell";
import { calculateDesktopScale, DESKTOP_FRAME, DESKTOP_PAPER_INSET } from "./DesktopShell";

const item: DerivativeItem = {
  docId: "deriv-1", dtype: "gzh",
  templateId: "gzh-opinion", templateName: "深度观点文", privatePrompt: "", sourceVersion: null,
  currentSourceVersion: 1,
  generatedAt: null, stale: false,
};

function StaleDismissHarness({ stream }: { stream: object }) {
  const [activeTab, setActiveTab] = useState<"main" | string>("deriv-1");
  const [currentSourceVersion, setCurrentSourceVersion] = useState(2);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const staleItem = { ...item, sourceVersion: 1, currentSourceVersion, generatedAt: "now", stale: true };
  const staleKey = (next: DerivativeItem) => `${next.docId}:${next.currentSourceVersion}`;
  const isStaleDismissed = useCallback((next: DerivativeItem) => dismissed.has(staleKey(next)), [dismissed]);
  const dismissStale = useCallback((next: DerivativeItem) => {
    setDismissed((keys) => new Set(keys).add(staleKey(next)));
  }, []);

  return <>
    <button onClick={() => setCurrentSourceVersion((version) => version + 1)}>源文档更新</button>
    <DerivTabBar title="主文档" items={[staleItem]} activeTab={activeTab} onActivate={setActiveTab} onCreate={vi.fn()} onRename={vi.fn()} isStaleDismissed={isStaleDismissed} />
    {activeTab === staleItem.docId ? <DerivativeView key={staleItem.docId} sessionId="session-1" item={staleItem} stream={stream as never} streamActive={false} onRefresh={vi.fn(async () => {})} onDeleted={vi.fn()} onToast={vi.fn()} onSendQuery={vi.fn()} isStaleDismissed={isStaleDismissed} onDismissStale={dismissStale} /> : null}
  </>;
}

async function renderDerivativeOverlayHarness(root: Root, withCreateMenu = false): Promise<void> {
  const generatedItem: DerivativeItem = {
    ...item,
    sourceVersion: 1,
    generatedAt: "2026-08-04T09:00:00.000Z",
  };
  const initialDocument = {
    meta: generatedItem,
    docPm: JSON.stringify({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "paragraph",
        attrs: { blockId: "esc-export-copy" },
        content: [{ type: "text", text: "Esc 导出测试正文" }],
      }],
    }),
    docVersion: 1,
    title: "Esc 导出测试",
  };
  const stream = {
    getDerivativeDoc: vi.fn(async () => initialDocument),
  };

  await act(async () => {
    root.render(
      <ConfirmProvider>
        {withCreateMenu ? (
          <DerivTabBar
            title="主文档"
            items={[]}
            activeTab="main"
            onActivate={vi.fn()}
            onCreate={vi.fn()}
            onRename={vi.fn()}
          />
        ) : null}
        <DerivativeView
          sessionId="session-1"
          item={generatedItem}
          initialDocument={initialDocument}
          stream={stream as never}
          streamActive={false}
          onRefresh={vi.fn(async () => {})}
          onDeleted={vi.fn()}
          onToast={vi.fn()}
          onSendQuery={vi.fn()}
        />
      </ConfirmProvider>,
    );
    await Promise.resolve();
  });
}

async function pressEscape(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }));
  });
}

describe("公众号稿生成体验", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => { host = document.createElement("div"); host.id = "view-workspace"; document.body.append(host); root = createRoot(host); });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    resetOverlayDismissStackForTest();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("衍生稿导出与更多菜单打开后按 Esc 只关闭当前菜单", async () => {
    const dismissBottomOverlay = vi.fn();
    registerOverlay(dismissBottomOverlay);
    await renderDerivativeOverlayHarness(root);

    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="导出"]')!.click());
    expect(host.querySelector(".ws-deriv-view .ws-export-menu")?.textContent).toBe("复制文案导出图片");
    await pressEscape();
    expect(host.querySelector(".ws-deriv-view .ws-export-menu")).toBeNull();
    expect(dismissBottomOverlay).not.toHaveBeenCalled();

    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="更多操作"]')!.click());
    expect(host.querySelector(".ws-deriv-view .ws-export-menu")?.textContent).toBe("删除稿件");
    await pressEscape();
    expect(host.querySelector(".ws-deriv-view .ws-export-menu")).toBeNull();
    expect(dismissBottomOverlay).not.toHaveBeenCalled();

    await pressEscape();
    expect(dismissBottomOverlay).toHaveBeenCalledTimes(1);
  });

  it("衍生导出与新建菜单快速交替五轮后不残留", async () => {
    vi.useFakeTimers();
    await renderDerivativeOverlayHarness(root, true);

    for (const delay of [90, 120, 95, 110, 100]) {
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="导出"]')!.click());
      expect(host.querySelector(".ws-deriv-view .ws-export-menu")).not.toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(delay));
      await pressEscape();
      expect(host.querySelector(".ws-deriv-view .ws-export-menu")).toBeNull();

      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="新建稿件"]')!.click());
      expect(host.querySelector(".ws-deriv-menu")).not.toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(delay));
      await pressEscape();
      expect(host.querySelector(".ws-deriv-menu")).toBeNull();
    }

    expect(host.querySelectorAll('[role="menu"]')).toHaveLength(0);
  });

  it.each(["gzh", "translate"] as const)("%s 配置弹窗打开后按 Esc 放弃输入并关闭", async (dtype) => {
    const onClose = vi.fn();
    const stream = {
      listStyleTemplates: vi.fn(async () => dtype === "gzh"
        ? [
            { id: "layout-a", dtype, slot: "layout", name: "经典排版", detail: "清晰", prompt: "排版提示", builtin: true },
            { id: "gzh-opinion", dtype, slot: "writing", name: "深度观点文", detail: "深入", prompt: "写作提示", builtin: true },
          ]
        : [{ id: "translate-faithful", dtype, slot: "writing", name: "忠实精准", detail: "准确", prompt: "翻译提示", builtin: true }]),
    };
    await act(async () => root.render(
      <DerivativeGenerateModal
        descriptor={DTYPE_REGISTRY[dtype]}
        sessionId="session-1"
        stream={stream as never}
        open
        initial={{ templateId: dtype === "gzh" ? "gzh-opinion" : "translate-faithful", privatePrompt: "尚未提交的输入" }}
        onClose={onClose}
        onGenerate={vi.fn()}
      />,
    ));
    expect(host.querySelector('[data-wf="DerivativeGenerateModal"]')).not.toBeNull();

    const supplement = host.querySelector<HTMLTextAreaElement>(".ws-launch-supplement textarea")!;
    act(() => supplement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("既有衍生稿用预取正文首帧成画，不先挂空纸等待二次请求", async () => {
    const generated = { ...item, sourceVersion: 1, generatedAt: "now" };
    const initialDocument = {
      meta: generated,
      docPm: JSON.stringify({
        type: "doc",
        attrs: { schemaVersion: 1 },
        content: [
          {
            type: "paragraph",
            attrs: { blockId: "prefetched" },
            content: [{ type: "text", text: "预取正文首帧可见" }],
          },
        ],
      }),
      docVersion: 1,
      title: "预取稿",
    };
    const stream = {
      getDerivativeDoc: vi.fn(
        () => new Promise<typeof initialDocument>(() => undefined),
      ),
    };

    await act(async () => {
      root.render(
        <ConfirmProvider>
          <DerivativeView
            sessionId="session-1"
            item={generated}
            initialDocument={initialDocument}
            stream={stream as never}
            streamActive={false}
            onRefresh={vi.fn(async () => {})}
            onDeleted={vi.fn()}
            onToast={vi.fn()}
            onSendQuery={vi.fn()}
          />
        </ConfirmProvider>,
      );
    });

    expect(host.textContent).toContain("预取正文首帧可见");
  });

  it("首次正文刷新失败时保留已有稿面并给出统一短提示", async () => {
    const generated = {
      ...item,
      sourceVersion: 1,
      generatedAt: "2026-07-28T09:00:00.000Z",
    };
    const initialDocument = {
      meta: generated,
      docPm: JSON.stringify({
        type: "doc",
        attrs: { schemaVersion: 1 },
        content: [
          {
            type: "paragraph",
            attrs: { blockId: "existing" },
            content: [{ type: "text", text: "可用旧稿不能被清空" }],
          },
        ],
      }),
      docVersion: 1,
      title: "已有稿",
    };
    const requestError = new Error("temporary request failure");
    const stream = {
      getDerivativeDoc: vi.fn(async () => {
        throw requestError;
      }),
    };
    const onToast = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await act(async () => {
      root.render(
        <ConfirmProvider>
          <DerivativeView
            sessionId="session-1"
            item={generated}
            initialDocument={initialDocument}
            stream={stream as never}
            streamActive={false}
            onRefresh={vi.fn(async () => {})}
            onDeleted={vi.fn()}
            onToast={onToast}
            onSendQuery={vi.fn()}
          />
        </ConfirmProvider>,
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain("可用旧稿不能被清空");
    expect(onToast).toHaveBeenCalledWith("稿件加载失败，请重试");
    expect(consoleError).toHaveBeenCalledWith(
      "[workspace] load derivative document failed",
      requestError,
    );
    consoleError.mockRestore();
  });

  it("会话重开 dispose 旧流时改用新流静默重试正文加载", async () => {
    const generated = {
      ...item,
      sourceVersion: 1,
      generatedAt: "2026-08-03T09:00:00.000Z",
    };
    const loadedDocument = {
      meta: generated,
      docPm: JSON.stringify({
        type: "doc",
        attrs: { schemaVersion: 1 },
        content: [
          {
            type: "paragraph",
            attrs: { blockId: "reopened" },
            content: [{ type: "text", text: "新流加载成功" }],
          },
        ],
      }),
      docVersion: 1,
      title: "重开稿件",
    };
    let rejectOldRequest!: (error: Error) => void;
    const oldStream = {
      getDerivativeDoc: vi.fn(
        () =>
          new Promise<typeof loadedDocument>((_resolve, reject) => {
            rejectOldRequest = reject;
          }),
      ),
      dispose: () => rejectOldRequest(new Error("ServerStream disposed")),
    };
    const newStream = {
      getDerivativeDoc: vi.fn(async () => loadedDocument),
    };
    const currentStreamRef = { current: oldStream as never };
    const onToast = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await act(async () => {
      root.render(
        <ConfirmProvider>
          <DerivativeView
            sessionId="session-1"
            item={generated}
            stream={oldStream as never}
            streamActive={false}
            onRefresh={vi.fn(async () => {})}
            onDeleted={vi.fn()}
            onToast={onToast}
            onSendQuery={vi.fn()}
            currentStreamRef={currentStreamRef}
          />
        </ConfirmProvider>,
      );
    });
    expect(oldStream.getDerivativeDoc).toHaveBeenCalledTimes(1);

    await act(async () => {
      oldStream.dispose();
      currentStreamRef.current = newStream as never;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(newStream.getDerivativeDoc).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("新流加载成功");
    expect(consoleError).not.toHaveBeenCalled();
    expect(onToast).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("F4: 历史非矩形表格衍生稿可宽容打开", async () => {
    const legacyBrokenTable = JSON.stringify({
      type: "doc", attrs: { schemaVersion: 1 }, content: [{
        type: "table", attrs: { blockId: "legacy-table" }, content: [
          { type: "tableRow", content: [
            { type: "tableCell", attrs: { rowspan: 3, backgroundColor: null }, content: [{ type: "paragraph", attrs: { blockId: "a" }, content: [{ type: "text", text: "旧表格仍可查看" }] }] },
            { type: "tableCell", content: [{ type: "paragraph", attrs: { blockId: "b" } }] },
          ] },
          { type: "tableRow", content: [
            { type: "tableCell", content: [{ type: "paragraph", attrs: { blockId: "c" } }] },
          ] },
        ],
      }],
    });
    const generated = { ...item, generatedAt: "now" };
    const stream = { getDerivativeDoc: vi.fn(async () => ({
      meta: generated, docPm: legacyBrokenTable, docVersion: 1, title: "历史稿",
    })) };

    await act(async () => {
      root.render(<ConfirmProvider><DerivativeView sessionId="session-1" item={generated} stream={stream as never} streamActive={false} onRefresh={vi.fn(async () => {})} onDeleted={vi.fn()} onToast={vi.fn()} onSendQuery={vi.fn()}/></ConfirmProvider>);
    });
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    expect(host.textContent).toContain("旧表格仍可查看");
  });

  it("单篇稿件 JSON 损坏时显示局部占位，不冒泡炸掉工作区", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const damaged = { ...item, sourceVersion: 1, generatedAt: "now" };
    const stream = { getDerivativeDoc: vi.fn(async () => ({
      meta: damaged,
      docPm: '{"type":"doc","content":[',
      docVersion: 1,
      title: "损坏稿件",
    })) };

    await act(async () => {
      root.render(<ConfirmProvider><DerivativeView sessionId="session-1" item={damaged} stream={stream as never} streamActive={false} onRefresh={vi.fn(async () => {})} onDeleted={vi.fn()} onToast={vi.fn()} onSendQuery={vi.fn()}/></ConfirmProvider>);
      await Promise.resolve();
    });

    expect(host.querySelector(".ws-deriv-empty strong")?.textContent).toBe("稿件数据损坏");
    expect(host.querySelector(".ws-deriv-view")).not.toBeNull();
    expect(consoleError).toHaveBeenCalledWith(
      "[workspace] parse derivative document failed",
      expect.any(SyntaxError),
    );
  });

  it("PhoneShell 按 375×812 等比缩放并在 560px 锁档", () => {
    expect(calculatePhoneScale(812)).toBe(1);
    expect(calculatePhoneScale(686)).toBeCloseTo(686 / 812);
    expect(calculatePhoneScale(400)).toBeCloseTo(560 / 812);
  });

  it("常驻 stale 提示右吸附重新生成按钮，并让箭头对准按钮中心", async () => {
    const staleItem: DerivativeItem = { ...item, sourceVersion: 1, generatedAt: "now", stale: true };
    const stream = { getDerivativeDoc: vi.fn(async () => ({
      meta: staleItem,
      docPm: '{"type":"doc","attrs":{"schemaVersion":1},"content":[]}',
      docVersion: 1,
      title: "",
    })) };
    await act(async () => root.render(<ConfirmProvider><DerivativeView sessionId="session-1" item={staleItem} stream={stream as never} streamActive={false} onRefresh={vi.fn(async () => {})} onDeleted={vi.fn()} onToast={vi.fn()} onSendQuery={vi.fn()}/></ConfirmProvider>));
    await act(async () => Promise.resolve());

    const anchor = host.querySelector(".ws-deriv-regen-anchor")!;
    expect(anchor.querySelector(":scope > .ws-deriv-stale-tip")).not.toBeNull();
    expect(anchor.querySelector(':scope > [aria-label="重新生成"]')).not.toBeNull();

    const css = readFileSync(resolve(process.cwd(), "src/pages/workspace/workspace.css"), "utf8");
    expect(css).toMatch(/\.workspace-tooltip\.ws-deriv-stale-tip\{[^}]*right:0;bottom:calc\(100% \+ 8px\);[^}]*max-width:min\(240px,calc\(100vw - 64px\)\)/);
    expect(css).toMatch(/\.workspace-tooltip\.ws-deriv-stale-tip::after\{left:calc\(100% - 13px\)\}/);
  });

  it("关闭 stale 提示后跨 Tab 保持忽略，源版本继续上涨时重新提示", async () => {
    const stream = { getDerivativeDoc: vi.fn(async () => ({
      meta: item,
      docPm: '{"type":"doc","attrs":{"schemaVersion":1},"content":[]}',
      docVersion: 1,
      title: "",
    })) };
    await act(async () => root.render(<ConfirmProvider><StaleDismissHarness stream={stream} /></ConfirmProvider>));
    await act(async () => Promise.resolve());

    expect(host.querySelector('.ws-deriv-stale-tip')).not.toBeNull();
    expect(host.querySelector('.ws-deriv-stale-dot')).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="关闭提示"]')!.click());
    expect(host.querySelector('.ws-deriv-stale-tip')).toBeNull();
    expect(host.querySelector('.ws-deriv-stale-dot')).toBeNull();

    await act(async () => host.querySelector<HTMLElement>('[role="tab"]')!.click());
    await act(async () => host.querySelectorAll<HTMLElement>('[role="tab"]')[1]!.click());
    expect(host.querySelector('.ws-deriv-stale-tip')).toBeNull();
    expect(host.querySelector('.ws-deriv-stale-dot')).toBeNull();

    const updateSource = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "源文档更新");
    await act(async () => updateSource!.click());
    expect(host.querySelector('.ws-deriv-stale-tip')).not.toBeNull();
    expect(host.querySelector('.ws-deriv-stale-dot')).not.toBeNull();
  });

  it("MacBook 先扣除每侧 40px 纸面留白，再保持 1232×740 整机等比缩放", () => {
    const scale = calculateDesktopScale(1312, 820);
    expect(DESKTOP_PAPER_INSET).toEqual({ horizontal: 40, vertical: 80 });
    expect(DESKTOP_FRAME).toMatchObject({ width: 1232, height: 740, viewportWidth: 1100, viewportHeight: 690, baseHeight: 10 });
    expect(scale).toBe(1);
    expect(calculateDesktopScale(1288, 1000)).toBeCloseTo(1208 / 1232);
  });

  it("Tab 使用类型展示名，已有译稿时＋菜单仍可追加未生成语种", async () => {
    const onCreate = vi.fn();
    const renderTabs = async (items: DerivativeItem[]) => act(async () => root.render(
      <DerivTabBar title="主文档" items={items} activeTab="main" onActivate={vi.fn()} onCreate={onCreate} onRename={vi.fn()} />,
    ));

    await renderTabs([item]);
    expect(host.textContent).toContain("公众号文章");
    expect(host.textContent).not.toContain("深度观点文");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="新建稿件"]')!.click());
    const menu = host.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu.textContent).toContain("小红书稿");
    expect(menu.textContent).not.toContain("公众号稿");
    expect(menu.textContent).not.toContain("打开");
    expect(menu.textContent).toContain("翻译");
    expect(menu.textContent).not.toContain("PPT");

    const xhsItem: DerivativeItem = { ...item, docId: "deriv-2", dtype: "xhs", templateName: "种草安利" };
    await renderTabs([item, xhsItem]);
    expect(host.textContent).toContain("小红书笔记");
    expect(host.querySelector('[aria-label="新建稿件"]')).not.toBeNull();

    const translateItem: DerivativeItem = { ...item, docId: "deriv-3", dtype: "translate", targetLang: "英语", templateName: "忠实精准" };
    await renderTabs([item, xhsItem, translateItem]);
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(4);
    expect(host.querySelector('[aria-label="新建稿件"]')).not.toBeNull();
    const translateMenuItem = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent === "翻译")!;
    await act(async () => translateMenuItem.click());
    expect(onCreate).toHaveBeenLastCalledWith("translate");

    const allTranslations = TRANSLATION_LANGUAGES.map((targetLang, index): DerivativeItem => ({
      ...translateItem,
      docId: `translate-${index}`,
      targetLang,
    }));
    await renderTabs([item, xhsItem, ...allTranslations]);
    expect(host.querySelector('[aria-label="新建稿件"]')).toBeNull();

    await renderTabs([xhsItem]);
    expect(host.querySelector('[aria-label="新建稿件"]')).not.toBeNull();
  });

  it("无标题单文档默认淡隐，hover 顶栏淡现并显示未命名文案", async () => {
    await act(async () => root.render(
      <DerivTabBar title="" items={[]} activeTab="main" onActivate={vi.fn()} onCreate={vi.fn()} onRename={vi.fn()} />,
    ));

    const tabs = host.querySelector<HTMLElement>(".ws-deriv-tabs")!;
    expect(tabs.classList.contains("is-single-untitled")).toBe(true);
    expect(tabs.textContent).toContain("未命名文档");

    const css = readFileSync(resolve(process.cwd(), "src/pages/workspace/workspace.css"), "utf8");
    expect(css).toMatch(/\.ws-deriv-tabs\.is-single-untitled \.ws-deriv-tab\.is-main\{opacity:0;transition:opacity 150ms ease\}/);
    expect(css).toMatch(/\.ws-deriv-tabs\.is-single-untitled:hover \.ws-deriv-tab\.is-main[^}]*\{opacity:1\}/);
  });

  it("有标题时主文档 Tab 常显", async () => {
    await act(async () => root.render(
      <DerivTabBar title="项目复盘" items={[]} activeTab="main" onActivate={vi.fn()} onCreate={vi.fn()} onRename={vi.fn()} />,
    ));

    expect(host.querySelector(".ws-deriv-tabs")?.classList.contains("is-single-untitled")).toBe(false);
    expect(host.querySelector(".ws-deriv-tab.is-main")?.textContent).toContain("项目复盘");
  });

  it("新建稿件入口的真实鼠标命中链可达，点击后展开菜单", async () => {
    const style = document.createElement("style");
    style.textContent = readFileSync(resolve(process.cwd(), "src/pages/workspace/workspace.css"), "utf8");
    document.head.append(style);
    try {
      await act(async () => root.render(
        <DerivTabBar title="主文档" items={[]} activeTab="main" onActivate={vi.fn()} onCreate={vi.fn()} onRename={vi.fn()} />,
      ));

      const tabs = host.querySelector<HTMLElement>(".ws-deriv-tabs")!;
      const addWrap = host.querySelector<HTMLElement>(".ws-deriv-add-wrap")!;
      const add = host.querySelector<HTMLButtonElement>('[aria-label="新建稿件"]')!;
      expect(getComputedStyle(addWrap).pointerEvents).toBe("auto");
      expect(getComputedStyle(add).pointerEvents).toBe("auto");
      expect(getComputedStyle(tabs).pointerEvents).toBe("none");

      await act(async () => {
        add.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      expect(host.querySelector('[role="menu"]')).not.toBeNull();
    } finally {
      style.remove();
    }
  });

  it("按 Enter 提交标题后即使继续触发 blur 也只重命名一次", async () => {
    const onRename = vi.fn();
    await act(async () => root.render(
      <DerivTabBar title="旧标题" items={[]} activeTab="main" onActivate={vi.fn()} onCreate={vi.fn()} onRename={onRename} />,
    ));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="修改标题"]')!.click());
    const input = host.querySelector<HTMLInputElement>('[aria-label="修改文档标题"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "新标题");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    });

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith("新标题");
  });

  it("有衍生稿时无标题主文档 Tab 常显，保留多 Tab 导航", async () => {
    await act(async () => root.render(
      <DerivTabBar title="" items={[item]} activeTab="main" onActivate={vi.fn()} onCreate={vi.fn()} onRename={vi.fn()} />,
    ));

    expect(host.querySelector(".ws-deriv-tabs")?.classList.contains("is-single-untitled")).toBe(false);
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(host.querySelector(".ws-deriv-tab.is-main")?.textContent).toContain("未命名文档");
  });

  it("青简编辑中「+」禁用:点了不开菜单、hover 展示原因", async () => {
    await act(async () => root.render(
      <DerivTabBar title="主文档" items={[item]} activeTab="main" onActivate={vi.fn()} onCreate={vi.fn()} onRename={vi.fn()} createDisabledReason="请等待青简完成编辑" />,
    ));
    const add = host.querySelector<HTMLButtonElement>('[aria-label="新建稿件"]')!;
    expect(add.classList.contains("is-disabled")).toBe(true);
    expect(add.title).toBe("请等待青简完成编辑");
    expect(add.getAttribute("aria-disabled")).toBe("true");
    await act(async () => add.click());
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });

  it("翻译 Tab 仅在仍有未忽略的过期译稿时显示红点", async () => {
    const english = { ...item, docId: "translate-en", dtype: "translate", targetLang: "英语", stale: true };
    const japanese = { ...english, docId: "translate-ja", targetLang: "日语" };
    const renderTabs = async (dismissed: (next: DerivativeItem) => boolean) => act(async () => root.render(
      <DerivTabBar title="主文档" items={[english, japanese]} activeTab="main" onActivate={vi.fn()} onCreate={vi.fn()} onRename={vi.fn()} isStaleDismissed={dismissed} />,
    ));

    await renderTabs((next) => next.docId === english.docId);
    expect(host.querySelector('.ws-deriv-stale-dot')).not.toBeNull();
    await renderTabs(() => true);
    expect(host.querySelector('.ws-deriv-stale-dot')).toBeNull();
  });

  it("弹框取消无副作用，生成提交当前模板和补充指令", async () => {
    const close = vi.fn();
    const generate = vi.fn();
    const templates = [
      { id: "layout-a", dtype: "gzh", slot: "layout", name: "经典排版", detail: "清晰", prompt: "排版提示", builtin: true },
      { id: "gzh-opinion", dtype: "gzh", slot: "writing", name: "深度观点文", detail: "深入", prompt: "深度提示", builtin: true },
      { id: "gzh-tutorial", dtype: "gzh", slot: "writing", name: "干货教程文", detail: "", prompt: "教程提示\n第二行不进摘要", builtin: true },
      { id: "gzh-story", dtype: "gzh", slot: "writing", name: "故事叙事文", detail: "叙事", prompt: "故事提示", builtin: true },
    ] as const;
    const stream = {
      listStyleTemplates: vi.fn(async () => templates),
      getStyleTemplate: vi.fn(async (_sessionId: string, id: string) => templates.find((item) => item.id === id)!),
      saveStyleTemplate: vi.fn(async (_sessionId: string, input: { id?: string; dtype: string; slot: "layout" | "writing"; name: string; detail?: string; prompt: string }) => ({
        ...input,
        id: input.id ?? "layout-custom",
        detail: input.detail ?? "",
        builtin: false,
      })),
    };
    await act(async () => root.render(<DerivativeGenerateModal descriptor={DTYPE_REGISTRY.gzh} sessionId="session-1" stream={stream as never} open initial={{ templateId: "gzh-opinion", layoutStyleId: "layout-a", privatePrompt: "克制" }} onClose={close} onGenerate={generate}/>));
    await act(async () => Promise.resolve());
    expect(host.querySelector(".ws-launch-modal")).not.toBeNull();
    expect(host.querySelector(".ws-launch-head")?.textContent).toContain("生成公众号文章");
    expect(host.querySelector(".ws-launch-subtitle")?.textContent).toBe("把主文档改写成适合公众号发布的文章");
    expect(host.querySelector(".ws-launch-head")?.textContent).not.toContain("模板");
    expect(host.querySelector(".ws-launch-close")).not.toBeNull();
    expect(host.textContent).not.toContain("选择生成风格；进入模板可查看和编辑完整提示词");
    expect(Array.from(host.querySelectorAll(".ws-launch-template-group-title")).map((node) => node.textContent)).toEqual(["排版风格", "写作风格"]);
    expect(host.querySelectorAll(".ws-launch-template-grid")[1]?.querySelectorAll(".ws-launch-template-card")).toHaveLength(3);
    expect(host.querySelectorAll(".ws-launch-template-edit")).toHaveLength(4);
    expect(host.querySelectorAll(".ws-launch-template-edit svg")).toHaveLength(4);
    expect(host.textContent).not.toContain("内置");
    const tutorialCard = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find((button) => button.textContent?.includes("干货教程文"))!;
    expect(tutorialCard.querySelector(".ws-launch-template-summary")?.textContent).toBe("教程提示");
    expect(host.querySelectorAll(".ws-launch-template-new")).toHaveLength(2);
    expect(Array.from(host.querySelectorAll(".ws-launch-template-new")).every((node) => node.textContent === "＋ 新建")).toBe(true);
    expect(host.querySelector(".ws-launch-template-grid .ws-launch-template-new")).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>(".ws-launch-template-new")!.click());
    expect(host.querySelector(".ws-launch-subtitle")).toBeNull();
    const editorInputs = host.querySelectorAll<HTMLInputElement>(".ws-launch-editor input");
    const editorPrompt = host.querySelector<HTMLTextAreaElement>(".ws-launch-editor textarea")!;
    expect(editorInputs).toHaveLength(1);
    expect(editorInputs[0]?.value).toBe("");
    expect(editorInputs[0]?.placeholder).toBe("给风格起个名，例如：热点借势评论");
    expect(host.textContent).not.toContain("说明");
    expect(editorPrompt.placeholder).toBe("描述排版规则：小标题、段落长度、加粗和分隔的用法");
    // AI 起草已移到提示词输入框右上角(字段级动作),不再混在快速开始行里
    expect(host.querySelector(".ws-launch-starters")?.textContent).toBe("快速开始：重点高亮卡片式");
    expect(host.querySelector(".ws-launch-field-head .ws-launch-ai-draft")?.textContent).toBe("✦ AI 起草");
    expect(host.querySelector(".ws-launch-actions > .ws-launch-starters")).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>(".ws-launch-starters button")!.click());
    expect(editorInputs[0]?.value).toBe("重点高亮卡片式");
    expect(editorPrompt.value).toBe("排版规则：每个小节开头用一句加粗观点句立骨；核心数据与金句独立成段并前置引用线（>）呈现，形成视觉卡片；段落最长不超过3行，列表优先；小节之间用分隔符（———）留气口；全文加粗不超过8处，只用于观点句，数据不加粗（已在卡片里突出）。");
    expect(Array.from(host.querySelectorAll<HTMLButtonElement>(".ws-launch-actions > .wf-btn")).map((button) => button.textContent)).toEqual(["保存"]);
    await act(async () => host.querySelector<HTMLButtonElement>(".ws-launch-actions > .wf-btn")!.click());
    expect(stream.saveStyleTemplate).toHaveBeenLastCalledWith("session-1", expect.objectContaining({ id: undefined, detail: "" }));
    await act(async () => host.querySelectorAll<HTMLButtonElement>(".ws-launch-template-new")[1]!.click());
    const writingPrompt = host.querySelector<HTMLTextAreaElement>(".ws-launch-editor textarea")!;
    expect(writingPrompt.placeholder).toBe("描述这类稿子怎么写：开头怎么起、正文什么结构、语气什么样、结尾怎么收");
    expect(host.querySelector(".ws-launch-starters")?.textContent).toBe("快速开始：热点借势评论人物访谈问答体");
    expect(host.querySelector(".ws-launch-field-head .ws-launch-ai-draft")?.textContent).toBe("✦ AI 起草");
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>(".ws-launch-starters button")).find((button) => button.textContent === "热点借势评论")!.click());
    expect(host.querySelector<HTMLInputElement>(".ws-launch-editor input")?.value).toBe("热点借势评论");
    expect(writingPrompt.value).toContain("正文用\"现象—本质—主文档的观点/事实\"结构推进");
    await act(async () => host.querySelector<HTMLButtonElement>(".ws-launch-back")!.click());
    const tutorial = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find((button) => button.textContent?.includes("干货教程文"))!;
    const textarea = host.querySelector<HTMLTextAreaElement>(".ws-launch-supplement textarea")!;
    expect(textarea.placeholder).toBe("这篇想怎么写，例如：语气更克制，保留原文案例");
    await act(async () => {
      tutorial.click();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "更短");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => host.querySelector<HTMLFormElement>(".ws-launch-form")!.requestSubmit());
    expect(generate).toHaveBeenCalledWith({ templateId: "gzh-tutorial", writingStyleId: "gzh-tutorial", layoutStyleId: "layout-custom", privatePrompt: "更短" });
    expect(close).not.toHaveBeenCalled();
  });

  it("内置模板可直接编辑，保存后沿原 id 降级为用户模板", async () => {
    const builtin = { id: "gzh-opinion", dtype: "gzh", slot: "writing" as const, name: "深度观点文", detail: "深入", prompt: "旧提示", builtin: true };
    const layout = { id: "layout-a", dtype: "gzh", slot: "layout" as const, name: "经典排版", detail: "清晰", prompt: "排版提示", builtin: true };
    const saved = { ...builtin, prompt: "新提示", builtin: false };
    const generate = vi.fn();
    const stream = {
      listStyleTemplates: vi.fn(async () => [layout, builtin]),
      getStyleTemplate: vi.fn(async () => builtin),
      saveStyleTemplate: vi.fn(async (_sessionId: string, input: { id?: string; detail?: string; prompt: string }) => ({ ...saved, ...input, detail: input.detail ?? builtin.detail })),
    };
    await act(async () => root.render(<DerivativeGenerateModal descriptor={DTYPE_REGISTRY.gzh} sessionId="session-1" stream={stream as never} open initial={{ templateId: builtin.id, layoutStyleId: layout.id, privatePrompt: "" }} onClose={vi.fn()} onGenerate={generate}/>));
    await act(async () => Promise.resolve());
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="编辑深度观点文"]')!.click());
    await act(async () => Promise.resolve());
    const builtinFields = host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(".ws-launch-editor input, .ws-launch-editor textarea");
    expect(builtinFields).toHaveLength(2);
    expect(Array.from(builtinFields).every((field) => !field.readOnly)).toBe(true);
    expect(host.querySelector(".ws-launch-head h2")?.textContent).toBe("编辑模板");
    expect(host.textContent).not.toContain("内置");
    expect(host.textContent).not.toContain("说明");
    const builtinActions = Array.from(host.querySelectorAll<HTMLButtonElement>(".ws-launch-actions button"));
    // 底部动作区只剩表单级动作,删除靠左(margin-right:auto)
    expect(builtinActions.map((button) => button.textContent)).toEqual(["删除", "另存新模板", "保存"]);
    expect(builtinActions[0]?.disabled).toBe(true);
    expect(builtinActions[0]?.title).toBe("内置模板不可删除");
    const prompt = host.querySelector<HTMLTextAreaElement>(".ws-launch-editor textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, "新提示");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => builtinActions[2]!.click());
    expect(stream.saveStyleTemplate).toHaveBeenCalledWith("session-1", expect.objectContaining({ id: builtin.id, detail: "深入", name: "深度观点文", prompt: "新提示" }));
    expect(Array.from(host.querySelectorAll('[aria-checked="true"]')).some((button) => button.textContent?.includes("深度观点文"))).toBe(true);
    await act(async () => host.querySelector<HTMLFormElement>(".ws-launch-form")!.requestSubmit());
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ writingStyleId: builtin.id }));
  });

  it("F1: 切换稿件类型后丢弃旧类型模板详情的迟到回包", async () => {
    const gzhTemplate = {
      id: "gzh-opinion",
      dtype: "gzh",
      slot: "writing" as const,
      name: "旧类型模板",
      detail: "旧详情",
      prompt: "旧提示",
      builtin: true,
    };
    const translateTemplate = {
      id: "translate-faithful",
      dtype: "translate",
      slot: "writing" as const,
      name: "忠实精准",
      detail: "准确",
      prompt: "翻译提示",
      builtin: true,
    };
    let resolveOldTemplate!: (value: typeof gzhTemplate) => void;
    const oldTemplateRequest = new Promise<typeof gzhTemplate>((resolve) => {
      resolveOldTemplate = resolve;
    });
    const stream = {
      listStyleTemplates: vi.fn(async (_sessionId: string, dtype: string) =>
        dtype === "gzh" ? [gzhTemplate] : [translateTemplate]),
      getStyleTemplate: vi.fn(() => oldTemplateRequest),
      saveStyleTemplate: vi.fn(),
    };
    const renderModal = (dtype: "gzh" | "translate") => root.render(
      <DerivativeGenerateModal
        descriptor={DTYPE_REGISTRY[dtype]}
        sessionId="session-1"
        stream={stream as never}
        open
        initial={{
          templateId: dtype === "gzh" ? gzhTemplate.id : translateTemplate.id,
          privatePrompt: "",
        }}
        onClose={vi.fn()}
        onGenerate={vi.fn()}
      />,
    );

    await act(async () => renderModal("gzh"));
    await act(async () => Promise.resolve());
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="编辑旧类型模板"]')!.click());
    expect(stream.getStyleTemplate).toHaveBeenCalledWith("session-1", gzhTemplate.id);

    await act(async () => renderModal("translate"));
    await act(async () => Promise.resolve());
    await act(async () => {
      resolveOldTemplate(gzhTemplate);
      await oldTemplateRequest;
    });

    expect(host.querySelector(".ws-launch-head h2")?.textContent).toBe("翻译文档");
    expect(host.textContent).not.toContain("旧类型模板");
    expect(host.querySelector(".ws-launch-editor")).toBeNull();
    expect(stream.saveStyleTemplate).not.toHaveBeenCalled();
  });

  it("F1: 旧类型模板延迟保存回包不污染切换后的新类型", async () => {
    const gzhTemplate = {
      id: "gzh-opinion",
      dtype: "gzh",
      slot: "writing" as const,
      name: "旧类型模板",
      detail: "旧详情",
      prompt: "旧提示",
      builtin: false,
    };
    const translateTemplate = {
      id: "translate-faithful",
      dtype: "translate",
      slot: "writing" as const,
      name: "忠实精准",
      detail: "准确",
      prompt: "翻译提示",
      builtin: true,
    };
    const savedGzhTemplate = {
      ...gzhTemplate,
      name: "旧类型保存结果",
      prompt: "修改后的旧类型提示",
    };
    let resolveOldSave!: (value: typeof savedGzhTemplate) => void;
    const oldSaveRequest = new Promise<typeof savedGzhTemplate>((resolve) => {
      resolveOldSave = resolve;
    });
    const onGenerate = vi.fn();
    const stream = {
      listStyleTemplates: vi.fn(async (_sessionId: string, dtype: string) =>
        dtype === "gzh" ? [gzhTemplate] : [translateTemplate]),
      getStyleTemplate: vi.fn(async () => gzhTemplate),
      saveStyleTemplate: vi.fn(() => oldSaveRequest),
    };
    const renderModal = (dtype: "gzh" | "translate") => root.render(
      <DerivativeGenerateModal
        descriptor={DTYPE_REGISTRY[dtype]}
        sessionId="session-1"
        stream={stream as never}
        open
        initial={{
          templateId: dtype === "gzh" ? gzhTemplate.id : translateTemplate.id,
          privatePrompt: "",
        }}
        onClose={vi.fn()}
        onGenerate={onGenerate}
      />,
    );

    await act(async () => renderModal("gzh"));
    await act(async () => Promise.resolve());
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="编辑旧类型模板"]')!.click());
    await act(async () => Promise.resolve());
    const prompt = host.querySelector<HTMLTextAreaElement>(".ws-launch-editor textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        prompt,
        savedGzhTemplate.prompt,
      );
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const saveButton = Array.from(host.querySelectorAll<HTMLButtonElement>(".ws-launch-actions button"))
      .find((button) => button.textContent === "保存")!;
    await act(async () => {
      saveButton.click();
      await Promise.resolve();
    });
    expect(stream.saveStyleTemplate).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        id: gzhTemplate.id,
        dtype: "gzh",
        prompt: savedGzhTemplate.prompt,
      }),
    );

    await act(async () => renderModal("translate"));
    await act(async () => Promise.resolve());
    expect(host.querySelector(".ws-launch-head h2")?.textContent).toBe("翻译文档");
    expect(host.querySelector('[aria-checked="true"]')?.textContent).toContain(translateTemplate.name);

    await act(async () => {
      resolveOldSave(savedGzhTemplate);
      await oldSaveRequest;
    });

    expect(host.querySelector(".ws-launch-head h2")?.textContent).toBe("翻译文档");
    expect(host.textContent).not.toContain(savedGzhTemplate.name);
    expect(host.querySelector(".ws-launch-editor")).toBeNull();
    expect(host.querySelectorAll(".ws-launch-template-card")).toHaveLength(1);
    expect(host.querySelector('[aria-checked="true"]')?.textContent).toContain(translateTemplate.name);
    await act(async () => host.querySelector<HTMLFormElement>(".ws-launch-form")!.requestSubmit());
    expect(onGenerate).toHaveBeenCalledWith(expect.objectContaining({
      templateId: translateTemplate.id,
      writingStyleId: translateTemplate.id,
    }));
  });

  it("用户风格模板可删除，删除选中项后回退同组内置模板", async () => {
    const layout = { id: "layout-a", dtype: "gzh", slot: "layout" as const, name: "经典排版", detail: "清晰", prompt: "排版提示", builtin: true };
    const builtin = { id: "gzh-opinion", dtype: "gzh", slot: "writing" as const, name: "深度观点文", detail: "深入", prompt: "深度提示", builtin: true };
    const user = { id: "user-writing", dtype: "gzh", slot: "writing" as const, name: "我的写法", detail: "自定义", prompt: "自定义提示", builtin: false };
    const stream = {
      listStyleTemplates: vi.fn(async () => [layout, builtin, user]),
      getStyleTemplate: vi.fn(async () => user),
      saveStyleTemplate: vi.fn(),
      deleteStyleTemplate: vi.fn(async () => {}),
    };
    await act(async () => root.render(<ConfirmProvider><DerivativeGenerateModal descriptor={DTYPE_REGISTRY.gzh} sessionId="session-1" stream={stream as never} open initial={{ templateId: user.id, writingStyleId: user.id, layoutStyleId: layout.id, privatePrompt: "" }} onClose={vi.fn()} onGenerate={vi.fn()}/></ConfirmProvider>));
    await act(async () => Promise.resolve());
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="编辑我的写法"]')!.click());
    await act(async () => Promise.resolve());
    expect(Array.from(host.querySelectorAll<HTMLButtonElement>(".ws-launch-actions button")).map((button) => button.textContent)).toEqual(["删除", "另存新模板", "保存"]);
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "删除")!.click());
    expect(stream.deleteStyleTemplate).not.toHaveBeenCalled();
    expect(host.querySelector('[data-wf="GlobalConfirm"]')?.textContent).toContain("删除风格模板「我的写法」？");
    await act(async () => host.querySelector<HTMLButtonElement>('[data-wf="GlobalConfirm"] .ws-folder-modal-danger')!.click());
    await act(async () => Promise.resolve());
    expect(stream.deleteStyleTemplate).toHaveBeenCalledWith("session-1", user.id);
    expect(host.textContent).not.toContain("我的写法");
    expect(Array.from(host.querySelectorAll<HTMLButtonElement>('[aria-checked="true"]')).some((button) => button.textContent?.includes("深度观点文"))).toBe(true);
  });

  it("新稿生成流停止且时间戳未变时退出 loading，中止空态可确认删除", async () => {
    vi.useFakeTimers();
    const stream = { getDerivativeDoc: vi.fn(async () => ({ meta: item, docPm: '{"type":"doc","attrs":{"schemaVersion":1},"content":[]}', docVersion: 0, title: "" })), deleteDerivative: vi.fn(async () => {}) };
    const onDeleted = vi.fn();
    await act(async () => root.render(<ConfirmProvider><DerivativeView sessionId="session-1" item={item} stream={stream as never} streamActive={false} generatingInitially onRefresh={vi.fn(async () => {})} onDeleted={onDeleted} onToast={vi.fn()} onSendQuery={vi.fn()}/></ConfirmProvider>));
    expect(host.querySelector(".is-generating")).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(4_100); });
    expect(host.textContent).toContain("生成已中止");
    expect(host.querySelector(".is-generating")).toBeNull();
    expect(Array.from(host.querySelectorAll("button")).some((button) => button.textContent === "删除稿件")).toBe(false);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="更多操作"]')!.click());
    const deleteButton = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "删除稿件")!;
    await act(async () => deleteButton.click());
    expect(host.textContent).toContain("删除这篇公众号稿？");
    const confirmButton = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "删除")!;
    await act(async () => confirmButton.click());
    expect(stream.deleteDerivative).toHaveBeenCalledWith("session-1", "deriv-1");
    expect(onDeleted).toHaveBeenCalledOnce();
  });

  it("重新生成流停止且时间戳未变时退出 loading，并提示保留原稿", async () => {
    vi.useFakeTimers();
    const generatedAt = "2026-07-15T10:00:00.000Z";
    const existingItem: DerivativeItem = { ...item, sourceVersion: 1, generatedAt };
    const stream = { getDerivativeDoc: vi.fn(async () => ({ meta: existingItem, docPm: '{"type":"doc","attrs":{"schemaVersion":1},"content":[]}', docVersion: 1, title: "" })) };
    const onToast = vi.fn();
    const renderView = (streamActive: boolean) => root.render(<ConfirmProvider><DerivativeView sessionId="session-1" item={existingItem} stream={stream as never} streamActive={streamActive} generatingInitially onRefresh={vi.fn(async () => {})} onDeleted={vi.fn()} onToast={onToast} onSendQuery={vi.fn()}/></ConfirmProvider>);
    await act(async () => renderView(true));
    expect(host.querySelector(".is-generating")).not.toBeNull();
    await act(async () => renderView(false));

    await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });

    expect(host.querySelector(".is-generating")).toBeNull();
    expect(onToast).toHaveBeenCalledWith("生成已中止，保留原稿");
    expect(host.textContent).not.toContain("生成已中止");
  });

  it("轮询 fetch 失败不误判中止，item 刷新为已生成后自愈空态", async () => {
    vi.useFakeTimers();
    const generatedItem: DerivativeItem = { ...item, sourceVersion: 1, generatedAt: "done" };
    const generatedDoc = { meta: generatedItem, docPm: '{"type":"doc","attrs":{"schemaVersion":1},"content":[]}', docVersion: 1, title: "" };
    const stream = { getDerivativeDoc: vi.fn().mockResolvedValueOnce(null).mockRejectedValue(new Error("temporary fetch failure")) };
    const renderView = (key: string, nextItem: DerivativeItem, generatingInitially = false) => root.render(<ConfirmProvider><DerivativeView key={key} sessionId="session-1" item={nextItem} stream={stream as never} streamActive={false} generatingInitially={generatingInitially} onRefresh={vi.fn(async () => {})} onDeleted={vi.fn()} onToast={vi.fn()} onSendQuery={vi.fn()}/></ConfirmProvider>);

    await act(async () => renderView("fetch-failure", item, true));
    await act(async () => { await vi.advanceTimersByTimeAsync(4_100); });
    expect(host.querySelector(".is-generating")).not.toBeNull();
    expect(host.textContent).not.toContain("生成已中止");

    stream.getDerivativeDoc.mockResolvedValue(generatedDoc);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(host.querySelector(".is-generating")).toBeNull();

    stream.getDerivativeDoc.mockResolvedValue({ ...generatedDoc, meta: item, docVersion: 0 });
    await act(async () => renderView("self-heal", item, true));
    await act(async () => { await vi.advanceTimersByTimeAsync(4_100); });
    expect(host.textContent).toContain("生成已中止");
    stream.getDerivativeDoc.mockResolvedValue(generatedDoc);
    await act(async () => renderView("self-heal", generatedItem));
    await act(async () => Promise.resolve());
    expect(host.textContent).not.toContain("生成已中止");
    expect(host.textContent).not.toContain("尚未生成");
  });

  it("翻译弹框提供 20 种语言、最多选五种并生成规范 displayCard", async () => {
    const templates = DTYPE_REGISTRY.translate.templates.map((template) => ({ ...template, dtype: "translate", slot: "writing" as const, prompt: `${template.name}提示`, builtin: true }));
    const generate = vi.fn();
    const stream = { listStyleTemplates: vi.fn(async () => templates), getStyleTemplate: vi.fn(async (_sessionId: string, id: string) => templates.find((item) => item.id === id)!) };
    await act(async () => root.render(<DerivativeGenerateModal descriptor={DTYPE_REGISTRY.translate} sessionId="session-1" stream={stream as never} open initial={{ templateId: "translate-faithful", privatePrompt: "" }} onClose={vi.fn()} onGenerate={generate}/>));
    await act(async () => Promise.resolve());
    expect(host.querySelector(".ws-launch-head h2")?.textContent).toBe("翻译文档");
    expect(host.querySelector(".ws-launch-subtitle")?.textContent).toBe("把主文档翻译成其他语言");
    expect(host.querySelector(".ws-launch-template-group-title")?.textContent).toBe("翻译风格");
    const chips = Array.from(host.querySelectorAll<HTMLButtonElement>(".ws-translate-language-chips button"));
    expect(chips).toHaveLength(20);
    expect(chips.map((chip) => chip.textContent)).toEqual([...TRANSLATION_LANGUAGES]);
    for (const language of ["日语", "韩语", "法语", "德语"]) await act(async () => chips.find((chip) => chip.textContent === language)!.click());
    expect(host.querySelectorAll(".ws-translate-language-chips .is-selected")).toHaveLength(MAX_TRANSLATION_LANGUAGES);
    const spanish = chips.find((chip) => chip.textContent === "西班牙语")!;
    expect(spanish.disabled).toBe(true);
    expect(spanish.title).toBe("最多选择 5 种语言");
    await act(async () => host.querySelector<HTMLFormElement>(".ws-launch-form")!.requestSubmit());
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ targetLanguages: ["英语", "日语", "韩语", "法语", "德语"], writingStyleId: "translate-faithful" }));
    expect(buildTranslationDisplayCard(["英语", "日语"], "忠实精准", "保留品牌名")).toEqual({ title: "翻译文档", lines: [{ label: "语言", value: "英语、日语" }, { label: "风格", value: "忠实精准" }, { label: "补充", value: "保留品牌名" }] });
    expect(buildTranslationAgentQuery([
      { docId: "translation-en", targetLang: "英语" },
      { docId: "translation-ja", targetLang: "日语" },
    ])).toBe("把主文档翻译成英语、日语。英语写入衍生稿(doc_id: translation-en)，日语写入衍生稿(doc_id: translation-ja)。按上述顺序逐个处理：对每篇稿件先调 derivative_brief,按返回的 skillGuidance 纪律与模板、补充指令改写源文,再用 generate_derivative 提交。");
  });

  it("已有日语译稿时新建翻译只提供未生成语言，可勾选英语和韩语", async () => {
    const templates = DTYPE_REGISTRY.translate.templates.map((template) => ({
      ...template,
      dtype: "translate",
      slot: "writing" as const,
      prompt: `${template.name}提示`,
      builtin: true,
    }));
    const generate = vi.fn();
    const stream = { listStyleTemplates: vi.fn(async () => templates) };
    await act(async () => root.render(
      <DerivativeGenerateModal
        descriptor={DTYPE_REGISTRY.translate}
        sessionId="session-1"
        stream={stream as never}
        open
        excludedTargetLanguages={["日语"]}
        initial={{ templateId: "translate-faithful", privatePrompt: "" }}
        onClose={vi.fn()}
        onGenerate={generate}
      />,
    ));
    await act(async () => Promise.resolve());

    const chips = Array.from(host.querySelectorAll<HTMLButtonElement>(".ws-translate-language-chips button"));
    expect(chips).toHaveLength(TRANSLATION_LANGUAGES.length - 1);
    expect(chips.some((chip) => chip.textContent === "日语")).toBe(false);
    const english = chips.find((chip) => chip.textContent === "英语")!;
    const korean = chips.find((chip) => chip.textContent === "韩语")!;
    expect(english.disabled).toBe(false);
    expect(korean.disabled).toBe(false);
    expect(english.getAttribute("aria-pressed")).toBe("true");
    await act(async () => korean.click());
    await act(async () => host.querySelector<HTMLFormElement>(".ws-launch-form")!.requestSubmit());

    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      targetLanguages: ["英语", "韩语"],
    }));
  });

  it("F12: 父组件用等值目标语言数组重渲染时保留翻译弹层草稿", async () => {
    const template = {
      id: "translate-faithful",
      dtype: "translate",
      slot: "writing" as const,
      name: "忠实精准",
      detail: "准确",
      prompt: "原始翻译提示",
      builtin: true,
    };
    const stream = {
      listStyleTemplates: vi.fn(async () => [template]),
      getStyleTemplate: vi.fn(async () => template),
    };
    const onClose = vi.fn();
    const onGenerate = vi.fn();
    const renderModal = () => root.render(
      <DerivativeGenerateModal
        descriptor={DTYPE_REGISTRY.translate}
        sessionId="session-1"
        stream={stream as never}
        open
        initial={{
          templateId: template.id,
          targetLanguages: ["英语"],
          privatePrompt: "",
        }}
        onClose={onClose}
        onGenerate={onGenerate}
      />,
    );

    await act(async () => renderModal());
    await act(async () => Promise.resolve());
    const supplement = host.querySelector<HTMLTextAreaElement>(".ws-launch-supplement textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(supplement, "保留产品英文名");
      supplement.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="编辑忠实精准"]')!.click());
    await act(async () => Promise.resolve());
    const prompt = host.querySelector<HTMLTextAreaElement>(".ws-launch-editor textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, "用户尚未保存的模板草稿");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => renderModal());

    expect(host.querySelector<HTMLTextAreaElement>(".ws-launch-editor textarea")?.value).toBe("用户尚未保存的模板草稿");
    await act(async () => host.querySelector<HTMLButtonElement>(".ws-launch-back")!.click());
    expect(host.querySelector<HTMLTextAreaElement>(".ws-launch-supplement textarea")?.value).toBe("保留产品英文名");
    expect(stream.listStyleTemplates).toHaveBeenCalledTimes(1);
  });

  it("F2: 翻译弹窗生成提交在请求完成前保持单次在途", async () => {
    const template = {
      id: "translate-faithful",
      dtype: "translate",
      slot: "writing" as const,
      name: "忠实精准",
      detail: "准确",
      prompt: "翻译提示",
      builtin: true,
    };
    let resolveCreate!: () => void;
    const createRequest = new Promise<void>((resolve) => {
      resolveCreate = resolve;
    });
    const onGenerate = vi.fn(() => createRequest);
    const modalStream = {
      listStyleTemplates: vi.fn(async () => [template]),
    };
    await act(async () => root.render(
      <DerivativeGenerateModal
        descriptor={DTYPE_REGISTRY.translate}
        sessionId="session-1"
        stream={modalStream as never}
        open
        initial={{
          templateId: template.id,
          targetLanguages: ["英语"],
          privatePrompt: "",
        }}
        onClose={vi.fn()}
        onGenerate={onGenerate}
      />,
    ));
    await act(async () => Promise.resolve());
    const form = host.querySelector<HTMLFormElement>(".ws-launch-form")!;
    await act(async () => {
      form.requestSubmit();
      form.requestSubmit();
      await Promise.resolve();
    });
    expect(onGenerate).toHaveBeenCalledTimes(1);
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    await act(async () => {
      resolveCreate();
      await createRequest;
    });

  });

  it("单语种重新生成通过可见 agent query 提交，不调用独立翻译通道", async () => {
    const translation: DerivativeItem = {
      ...item,
      docId: "translate-agent-regenerate",
      dtype: "translate",
      targetLang: "日语",
      templateId: "translate-native",
      templateName: "母语化改写",
      sourceVersion: 1,
      generatedAt: "old-generated-at",
    };
    const template = {
      id: "translate-native",
      dtype: "translate",
      slot: "writing" as const,
      name: "母语化改写",
      detail: "自然",
      prompt: "母语化翻译",
      builtin: true,
    };
    const docPm = JSON.stringify({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "paragraph",
        attrs: { blockId: "ja-old" },
        content: [{ type: "text", text: "既有译文" }],
      }],
    });
    const stream = {
      getDerivativeDoc: vi.fn(async () => ({ meta: translation, docPm, docVersion: 1, title: "" })),
      listStyleTemplates: vi.fn(async () => [template]),
      createDerivative: vi.fn(async () => translation),
    };
    const onSendQuery = vi.fn();
    await act(async () => root.render(
      <ConfirmProvider><DerivativeView
        sessionId="session-1"
        item={translation}
        stream={stream as never}
        streamActive={false}
        onRefresh={vi.fn(async () => {})}
        onDeleted={vi.fn()}
        onToast={vi.fn()}
        onSendQuery={onSendQuery}
      /></ConfirmProvider>,
    ));
    await act(async () => Promise.resolve());
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="重新生成"]')!.click());
    await act(async () => Promise.resolve());
    await act(async () => host.querySelector<HTMLFormElement>(".ws-launch-form")!.requestSubmit());
    await act(async () => Promise.resolve());

    expect(onSendQuery).toHaveBeenCalledOnce();
    expect(stream.createDerivative).toHaveBeenCalledWith(
      "session-1",
      "translate",
      "translate-native",
      "",
      "translate-native",
      null,
      "日语",
    );
    expect(onSendQuery).toHaveBeenCalledWith(
      expect.stringMatching(/重新生成日语翻译.*衍生稿\(doc_id: translate-agent-regenerate\).*derivative_brief.*generate_derivative/),
      expect.objectContaining({ title: "重新翻译文档" }),
    );
  });

  it("翻译稿聚合为语言 segmented，切换后显示对应译文且删除只在更多菜单", async () => {
    const english: DerivativeItem = { ...item, docId: "translate-en", dtype: "translate", targetLang: "英语", templateId: "translate-faithful", templateName: "忠实精准", sourceVersion: 1, generatedAt: "en" };
    const japanese: DerivativeItem = { ...english, docId: "translate-ja", targetLang: "日语", generatedAt: "ja" };
    const docs: Record<string, string> = {
      "translate-en": JSON.stringify({ type: "doc", attrs: { schemaVersion: 1 }, content: [{ type: "paragraph", attrs: { blockId: "en" }, content: [{ type: "text", text: "English copy" }] }] }),
      "translate-ja": JSON.stringify({ type: "doc", attrs: { schemaVersion: 1 }, content: [{ type: "paragraph", attrs: { blockId: "ja" }, content: [{ type: "text", text: "日本語訳" }] }] }),
    };
    const onActiveDocIdChange = vi.fn();
    const stream = { getDerivativeDoc: vi.fn(async (_sessionId: string, docId: string) => ({ meta: docId === english.docId ? english : japanese, docPm: docs[docId], docVersion: 1, title: "" })) };
    await act(async () => root.render(<ConfirmProvider><DerivativeView sessionId="session-1" item={english} items={[english, japanese]} stream={stream as never} streamActive={false} onRefresh={vi.fn(async () => {})} onDeleted={vi.fn()} onToast={vi.fn()} onSendQuery={vi.fn()} onActiveDocIdChange={onActiveDocIdChange}/></ConfirmProvider>));
    await act(async () => Promise.resolve());
    expect(onActiveDocIdChange).toHaveBeenLastCalledWith(english.docId);
    expect(Array.from(host.querySelectorAll<HTMLButtonElement>(".ws-translate-segmented button")).map((button) => button.textContent)).toEqual(["英语", "日语"]);
    expect(host.textContent).toContain("English copy");
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>(".ws-translate-segmented button")).find((button) => button.textContent === "日语")!.click());
    await act(async () => Promise.resolve());
    expect(onActiveDocIdChange).toHaveBeenLastCalledWith(japanese.docId);
    expect(host.textContent).toContain("日本語訳");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="导出"]')!.click());
    expect(host.querySelector('[role="menu"]')?.textContent).toBe("复制文案");
    expect(host.querySelector('[role="menu"]')?.textContent).not.toContain("导出图片");
    expect(Array.from(host.querySelectorAll("button")).some((button) => button.textContent === "删除稿件")).toBe(false);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="更多操作"]')!.click());
    expect(host.querySelector('[role="menu"]')?.textContent).toBe("删除稿件");
  });

  it("空译稿使用未生成语义，不冒充翻译失败或重新生成", async () => {
    const emptyTranslation: DerivativeItem = {
      ...item,
      docId: "translate-empty-copy",
      dtype: "translate",
      targetLang: "英语",
      templateId: "translate-faithful",
      templateName: "忠实精准",
    };
    const stream = { getDerivativeDoc: vi.fn(async () => null) };

    await act(async () => root.render(
      <ConfirmProvider>
        <DerivativeView
          sessionId="session-1"
          item={emptyTranslation}
          stream={stream as never}
          streamActive={false}
          onRefresh={vi.fn(async () => {})}
          onDeleted={vi.fn()}
          onToast={vi.fn()}
          onSendQuery={vi.fn()}
        />
      </ConfirmProvider>,
    ));
    await act(async () => Promise.resolve());

    expect(host.querySelector(".ws-deriv-empty strong")?.textContent)
      .toBe("该语言还没有译文");
    expect(host.querySelector(".ws-deriv-empty button")?.textContent)
      .toBe("生成该语言");
    expect(host.textContent).not.toContain("翻译未完成");
    expect(host.textContent).not.toContain("重新生成");
  });

  it("翻译稿复用文章阅读排版，表格网格与列表缩进有计算样式", async () => {
    const style = document.createElement("style");
    style.textContent = [
      readFileSync(resolve(process.cwd(), "../../packages/ui-kit/src/tokens.css"), "utf8"),
      readFileSync(resolve(process.cwd(), "../../packages/ui-kit/src/components.css"), "utf8"),
      readFileSync(resolve(process.cwd(), "src/pages/workspace/workspace.css"), "utf8"),
    ].join("\n");
    document.head.append(style);

    const translation: DerivativeItem = {
      ...item,
      docId: "translate-typography",
      dtype: "translate",
      targetLang: "英语",
      sourceVersion: 1,
      generatedAt: "now",
    };
    const docPm = JSON.stringify({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "heading",
          attrs: { blockId: "heading", level: 2 },
          content: [{ type: "text", text: "Typography" }],
        },
        {
          type: "table",
          attrs: { blockId: "table" },
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableHeader",
                  attrs: { colspan: 1, rowspan: 1, colwidth: null, backgroundColor: null },
                  content: [{ type: "paragraph", attrs: { blockId: "head-a" }, content: [{ type: "text", text: "Name" }] }],
                },
                {
                  type: "tableHeader",
                  attrs: { colspan: 1, rowspan: 1, colwidth: null, backgroundColor: null },
                  content: [{ type: "paragraph", attrs: { blockId: "head-b" }, content: [{ type: "text", text: "Value" }] }],
                },
              ],
            },
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  attrs: { colspan: 1, rowspan: 1, colwidth: null, backgroundColor: null },
                  content: [{ type: "paragraph", attrs: { blockId: "cell-a" }, content: [{ type: "text", text: "Alpha" }] }],
                },
                {
                  type: "tableCell",
                  attrs: { colspan: 1, rowspan: 1, colwidth: null, backgroundColor: null },
                  content: [{ type: "paragraph", attrs: { blockId: "cell-b" }, content: [{ type: "text", text: "1" }] }],
                },
              ],
            },
          ],
        },
        {
          type: "bulletList",
          attrs: { blockId: "list" },
          content: [{
            type: "listItem",
            attrs: { blockId: "list-item" },
            content: [{ type: "paragraph", attrs: { blockId: "list-text" }, content: [{ type: "text", text: "Indented" }] }],
          }],
        },
        {
          type: "blockquote",
          attrs: { blockId: "quote" },
          content: [{ type: "paragraph", attrs: { blockId: "quote-text" }, content: [{ type: "text", text: "Quoted" }] }],
        },
        {
          type: "codeBlock",
          attrs: { blockId: "code", language: "ts" },
          content: [{ type: "text", text: "const answer = 42;" }],
        },
        {
          type: "paragraph",
          attrs: { blockId: "footnote" },
          content: [
            { type: "text", text: "Source" },
            { type: "footnoteReference", attrs: { id: "source", note: "Reference" } },
          ],
        },
      ],
    });
    const initialDocument = { meta: translation, docPm, docVersion: 1, title: "" };
    const stream = {
      getDerivativeDoc: vi.fn(() => new Promise<typeof initialDocument>(() => undefined)),
    };

    try {
      await act(async () => root.render(
        <ConfirmProvider>
          <DerivativeView
            sessionId="session-1"
            item={translation}
            initialDocument={initialDocument}
            stream={stream as never}
            streamActive={false}
            onRefresh={vi.fn(async () => {})}
            onDeleted={vi.fn()}
            onToast={vi.fn()}
            onSendQuery={vi.fn()}
          />
        </ConfirmProvider>,
      ));

      const article = host.querySelector<HTMLElement>(".ws-translate-article.doc-typography");
      const firstHeader = article?.querySelector<HTMLElement>("th");
      const list = article?.querySelector<HTMLElement>("ul");
      expect(article).not.toBeNull();
      expect(article?.classList.contains("wf-doc")).toBe(false);
      expect(firstHeader).not.toBeNull();
      expect(getComputedStyle(firstHeader!).borderTopStyle).not.toBe("none");
      expect(getComputedStyle(firstHeader!).borderRightStyle).not.toBe("none");
      expect(parseFloat(getComputedStyle(list!).paddingLeft)).toBeGreaterThan(0);
      expect(getComputedStyle(article!.querySelector("blockquote")!).borderLeftStyle).not.toBe("none");
      expect(article?.querySelector("pre.md-code-block")).not.toBeNull();
      expect(article?.querySelector(".pm-footnote-reference")).not.toBeNull();
      expect(article?.querySelector(".selectedCell, .column-resize-handle, .code-block-language-select")).toBeNull();
    } finally {
      style.remove();
    }
  });

  it("快速切换子 Tab 时丢弃与当前 docId 不符的乱序响应", async () => {
    const english: DerivativeItem = { ...item, docId: "translate-guard-en", dtype: "translate", targetLang: "英语", generatedAt: "en" };
    const japanese: DerivativeItem = { ...english, docId: "translate-guard-ja", targetLang: "日语", generatedAt: "ja" };
    const englishDoc = JSON.stringify({ type: "doc", attrs: { schemaVersion: 1 }, content: [{ type: "paragraph", attrs: { blockId: "en" }, content: [{ type: "text", text: "English copy" }] }] });
    const stream = {
      getDerivativeDoc: vi.fn(async (_sessionId: string, docId: string) => ({
        meta: english,
        docPm: englishDoc,
        docVersion: 1,
        title: docId,
      })),
    };
    await act(async () => root.render(<ConfirmProvider><DerivativeView sessionId="session-1" item={english} items={[english, japanese]} stream={stream as never} streamActive={false} onRefresh={vi.fn(async () => {})} onDeleted={vi.fn()} onToast={vi.fn()} onSendQuery={vi.fn()}/></ConfirmProvider>));
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>(".ws-translate-segmented button")).find((button) => button.textContent === "日语")!.click());
    await act(async () => Promise.resolve());
    expect(stream.getDerivativeDoc).toHaveBeenLastCalledWith("session-1", "translate-guard-ja");
    expect(host.textContent).not.toContain("English copy");
  });

  it("翻译与其他衍生稿共用 Agent 等待态，停止后无专属残留状态", async () => {
    vi.useFakeTimers();
    const english: DerivativeItem = {
      ...item,
      docId: "translate-agent-stop",
      dtype: "translate",
      targetLang: "英语",
      templateId: "translate-faithful",
      templateName: "忠实精准",
    };
    const stream = {
      getDerivativeDoc: vi.fn(async () => ({
        meta: english,
        docPm: "{}",
        docVersion: 0,
        title: "",
      })),
    };
    const onRefresh = vi.fn(async () => {});
    const renderView = (streamActive: boolean) => root.render(
      <ConfirmProvider><DerivativeView
        sessionId="session-1"
        item={english}
        stream={stream as never}
        streamActive={streamActive}
        generatingInitially
        onRefresh={onRefresh}
        onDeleted={vi.fn()}
        onToast={vi.fn()}
        onSendQuery={vi.fn()}
      /></ConfirmProvider>,
    );

    await act(async () => renderView(true));
    expect(host.querySelector('.ws-deriv-view.is-generating [data-wf="QingLoading"]'))
      .not.toBeNull();

    await act(async () => renderView(false));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
    expect(host.querySelector(".is-generating")).toBeNull();
    expect(host.textContent).toContain("翻译已中止");
    expect(onRefresh).toHaveBeenCalled();
  });

  it("发光、亮红和小红书双壳修复均有 CSS/DOM 回归锚点", async () => {
    const workspaceCss = readFileSync(resolve(process.cwd(), "src/pages/workspace/workspace.css"), "utf8");
    const skinCss = readFileSync(resolve(process.cwd(), "src/pages/workspace/workspace-ink-skin.css"), "utf8");
    const xhsCss = readFileSync(resolve(process.cwd(), "src/pages/workspace/components/derivatives/xhsPreview.css"), "utf8");
    const xhsOverrides = readFileSync(resolve(process.cwd(), "src/pages/workspace/components/derivatives/xhsOverrides.css"), "utf8");
    expect(workspaceCss).toContain(".ws-deriv-view.is-generating{display:grid;min-height:var(--ws-paper-min-height");
    expect(workspaceCss).toContain(".ws-deriv-view>.ws-editor-glow{position:absolute;inset:0;width:auto;height:auto;box-sizing:border-box;z-index:4");
    expect(workspaceCss).not.toContain(".ws-deriv-view.is-generating>.qing-loading");
    expect(skinCss).toContain(".ws-deriv-view.is-generating > .doc-empty {\n  top: 0 !important;\n  box-shadow: none;");
    expect(skinCss).toContain(".ws-export-menu .ws-export-item.is-danger {\n  color: var(--ws-red-lite);");
    expect(xhsCss).toContain(".xhs-phone-content .xhs-article{padding-top:0}.xhs-phone-content .xhs-cover{width:calc(100% + 32px);margin:0 -16px 12px}");
    expect(xhsCss).toContain(".xhs-desktop-content .xhs-article>h1{margin-top:0}");
    expect(xhsOverrides).toContain(".xhs-desktop-media .xhs-cover{display:grid!important;width:100%;height:100%");
    await act(async () => root.render(<ConfirmProvider><DerivativeView sessionId="session-1" item={item} stream={{ getDerivativeDoc: vi.fn(async () => ({ meta: item, docPm: '{}', docVersion: 0, title: "" })) } as never} streamActive generatingInitially onRefresh={vi.fn(async () => {})} onDeleted={vi.fn()} onToast={vi.fn()} onSendQuery={vi.fn()}/></ConfirmProvider>));
    const glow = host.querySelector('[data-glow-surface="derivative-paper"] > [data-wf="DerivativeEditorGlow"]');
    const empty = host.querySelector('[data-glow-surface="derivative-paper"] > .doc-empty');
    expect(glow).not.toBeNull();
    expect(empty).not.toBeNull();
    expect(glow?.parentElement).toBe(empty?.parentElement);
  });

  it("注册表驱动小红书弹框与手机预览", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const xhsItem: DerivativeItem = { ...item, dtype: "xhs", templateId: "xhs-recommend", templateName: "种草安利", sourceVersion: 1, generatedAt: "now" };
    const docPm = JSON.stringify({ type: "doc", attrs: { schemaVersion: 1 }, content: [{ type: "heading", attrs: { level: 1, blockId: "h1" }, content: [{ type: "text", text: "通勤效率的 5 个要点⚡" }] }, { type: "paragraph", attrs: { blockId: "p1" }, content: [{ type: "text", text: "第一段体验✨" }] }, { type: "paragraph", attrs: { blockId: "p2" }, content: [{ type: "text", text: "#通勤 #效率 #干货 #收藏" }] }] });
    const xhsTemplates = DTYPE_REGISTRY.xhs.templates.map((template) => ({ ...template, dtype: "xhs", slot: "writing" as const, prompt: `${template.name}提示`, builtin: true }));
    const stream = { getDerivativeDoc: vi.fn(async () => ({ meta: xhsItem, docPm, docVersion: 1, title: "" })), updateDerivativeCoverTemplate: vi.fn(async () => ({ ...xhsItem, coverTemplate: "magazine" as const })), listStyleTemplates: vi.fn(async () => xhsTemplates), getStyleTemplate: vi.fn(async (_sessionId: string, id: string) => xhsTemplates.find((template) => template.id === id)!) };
    await act(async () => root.render(<ConfirmProvider><DerivativeView sessionId="session-1" item={xhsItem} stream={stream as never} streamActive={false} onRefresh={vi.fn(async () => {})} onDeleted={vi.fn()} onToast={vi.fn()} onSendQuery={vi.fn()}/></ConfirmProvider>));
    await act(async () => Promise.resolve());
    expect(host.querySelector(".xhs-navbar")?.textContent).toContain("青简");
    expect(host.querySelector(".xhs-navbar button")?.textContent).toBe("关注");
    expect(host.querySelector(".xhs-cover")?.textContent).toContain("通勤效率");
    expect(host.querySelector(".xhs-cover")?.getAttribute("data-title-size")).toBe("default");
    expect(host.querySelectorAll(".xhs-cover-dots button")).toHaveLength(5);
    expect(host.querySelector('[aria-label="上一款封面"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="下一款封面"]')).not.toBeNull();
    await act(async () => (host.querySelector('[aria-label="下一款封面"]') as HTMLButtonElement).click());
    expect(stream.updateDerivativeCoverTemplate).toHaveBeenCalledWith("session-1", xhsItem.docId, "magazine");
    expect(host.querySelector(".xhs-cover")?.getAttribute("data-cover-template")).toBe("magazine");
    expect(host.querySelector(".xhs-interaction")?.textContent).toContain("128");
    expect(host.querySelectorAll(".xhs-topic")).toHaveLength(4);
    expect(host.querySelector(".xhs-back .preview-chevron")).not.toBeNull();
    const topShareIcon = host.querySelector(".xhs-share-icon");
    const bottomShareIcon = host.querySelector('.xhs-interaction [aria-label="分享"] .xhs-action-icon');
    for (const icon of [topShareIcon, bottomShareIcon]) {
      expect(icon?.getAttribute("fill")).toBe("none");
      expect(Array.from(icon?.querySelectorAll("path") ?? [], (path) => path.getAttribute("d"))).toEqual([
        "m14 4 6 5-6 5",
        "M20 9h-5.5C8.7 9 5 12.1 4 19",
      ]);
    }
    await act(async () => (host.querySelector('[aria-label="导出"]') as HTMLButtonElement).click());
    expect(host.querySelector('[role="menu"]')?.textContent).toBe("复制文案导出图片");
    await act(async () => (host.querySelector('[aria-label="更多操作"]') as HTMLButtonElement).click());
    expect(host.querySelector('[role="menu"]')?.textContent).toBe("删除稿件");
    await act(async () => (host.querySelector('[aria-label="导出"]') as HTMLButtonElement).click());
    const copyButton = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "复制文案")!;
    await act(async () => copyButton.click());
    expect(writeText).toHaveBeenCalledWith("通勤效率的 5 个要点⚡\n\n第一段体验✨\n\n#通勤 #效率 #干货 #收藏");
    await act(async () => (host.querySelector('[aria-label="重新生成"]') as HTMLButtonElement).click());
    await act(async () => Promise.resolve());
    expect(host.textContent).toContain("生成小红书笔记");
    expect(host.textContent).toContain("种草安利");
    expect(host.textContent).toContain("干货清单");
    expect(host.querySelector(".ws-launch-subtitle")?.textContent).toBe("把主文档改写成小红书风格的笔记");
    expect(host.querySelector(".ws-launch-head")?.textContent).not.toContain("3 模板");
    expect(host.querySelector(".ws-launch-template-group-title")?.textContent).toBe("写作风格");
    expect(host.querySelectorAll(".ws-launch-template-group")).toHaveLength(1);
    expect(host.querySelector<HTMLTextAreaElement>(".ws-launch-supplement textarea")?.placeholder).toBe("这篇想怎么写，例如：语气再活泼一点，多用短句");
  });

  it("小红书话题随稳定 blockId 声明式更新且不会重复嵌套", async () => {
    const Preview = DTYPE_REGISTRY.xhs.PhonePreview!;
    const makeDoc = (text: string) => ({
      type: "doc" as const,
      attrs: { schemaVersion: 1 as const },
      content: [{
        type: "paragraph" as const,
        attrs: { blockId: "stable-paragraph" },
        content: [{ type: "text" as const, text }],
      }],
    });

    await act(async () => root.render(
      <Preview doc={makeDoc("旧正文 #旧话题")} title="测试" articleRef={() => undefined} />,
    ));
    expect(host.querySelector(".xhs-body")?.textContent).toBe("旧正文 #旧话题");
    expect(host.querySelector(".xhs-topic")?.textContent).toBe("#旧话题");

    await act(async () => root.render(
      <Preview doc={makeDoc("新正文 #新话题 #第二个")} title="测试" articleRef={() => undefined} />,
    ));
    expect(host.querySelector(".xhs-body")?.textContent).toBe("新正文 #新话题 #第二个");
    expect(host.textContent).not.toContain("旧正文");
    expect(Array.from(host.querySelectorAll(".xhs-topic")).map((node) => node.textContent)).toEqual(["#新话题", "#第二个"]);
    expect(host.querySelector(".xhs-topic .xhs-topic")).toBeNull();
  });

  it("快速切换封面时旧请求迟到失败不能覆盖后一次成功选择", async () => {
    const xhsItem: DerivativeItem = {
      ...item,
      dtype: "xhs",
      templateId: "xhs-recommend",
      templateName: "种草安利",
      sourceVersion: 1,
      generatedAt: "now",
      coverTemplate: "poster",
    };
    const docPm = JSON.stringify({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "heading",
          attrs: { level: 1, blockId: "h1" },
          content: [{ type: "text", text: "封面竞态测试" }],
        },
      ],
    });
    let rejectOldSave!: (error: Error) => void;
    const oldSave = new Promise<never>((_resolve, reject) => {
      rejectOldSave = reject;
    });
    const stream = {
      getDerivativeDoc: vi.fn(async () => ({
        meta: xhsItem,
        docPm,
        docVersion: 1,
        title: "",
      })),
      updateDerivativeCoverTemplate: vi.fn(
        async (_sessionId: string, _docId: string, template: string) => {
          if (template === "magazine") return oldSave;
          return { ...xhsItem, coverTemplate: template };
        },
      ),
    };
    const onToast = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await act(async () => {
      root.render(
        <ConfirmProvider>
          <DerivativeView
            sessionId="session-1"
            item={xhsItem}
            stream={stream as never}
            streamActive={false}
            onRefresh={vi.fn(async () => {})}
            onDeleted={vi.fn()}
            onToast={onToast}
            onSendQuery={vi.fn()}
          />
        </ConfirmProvider>,
      );
      await Promise.resolve();
    });

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="下一款封面"]')!.click();
    });
    expect(host.querySelector(".xhs-cover")?.getAttribute("data-cover-template")).toBe("magazine");

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="下一款封面"]')!.click();
      await Promise.resolve();
    });
    expect(host.querySelector(".xhs-cover")?.getAttribute("data-cover-template")).toBe("wenkai");

    await act(async () => {
      rejectOldSave(new Error("old save failed"));
      await oldSave.catch(() => undefined);
    });

    expect(host.querySelector(".xhs-cover")?.getAttribute("data-cover-template")).toBe("wenkai");
    expect(onToast).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("小红书清单复制文案与预览一致且每项只出现一次", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const xhsItem: DerivativeItem = {
      ...item,
      dtype: "xhs",
      templateId: "xhs-checklist",
      templateName: "干货清单",
      sourceVersion: 1,
      generatedAt: "now",
    };
    const listItems = ["提前查路线", "带一把折叠伞", "错峰十分钟", "到站再收耳机"];
    const docPm = JSON.stringify({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "heading",
          attrs: { level: 1, blockId: "title" },
          content: [{ type: "text", text: "通勤避坑清单" }],
        },
        {
          type: "bulletList",
          attrs: { blockId: "checklist" },
          content: listItems.map((text, index) => ({
            type: "listItem",
            attrs: { blockId: `item-${index}` },
            content: [{
              type: "paragraph",
              attrs: { blockId: `item-${index}-paragraph` },
              content: [{ type: "text", text }],
            }],
          })),
        },
      ],
    });
    const stream = {
      getDerivativeDoc: vi.fn(async () => ({
        meta: xhsItem,
        docPm,
        docVersion: 1,
        title: "",
      })),
    };

    await act(async () => {
      root.render(
        <ConfirmProvider>
          <DerivativeView
            sessionId="session-1"
            item={xhsItem}
            stream={stream as never}
            streamActive={false}
            onRefresh={vi.fn(async () => {})}
            onDeleted={vi.fn()}
            onToast={vi.fn()}
            onSendQuery={vi.fn()}
          />
        </ConfirmProvider>,
      );
      await Promise.resolve();
    });

    expect(Array.from(host.querySelectorAll(".xhs-body li"), (node) => node.textContent))
      .toEqual(listItems);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="导出"]')!.click());
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "复制文案")!.click());

    expect(writeText).toHaveBeenCalledWith(`通勤避坑清单\n\n${listItems.join("\n\n")}`);
  });

  it("公众号清单复制 HTML 与预览保持同一组列表项且不重复", async () => {
    class MockClipboardItem {
      constructor(readonly data: Record<string, Blob>) {}
      get types() { return Object.keys(this.data); }
      async getType(type: string) { return this.data[type]!; }
    }
    const write = vi.fn(async (_items: ClipboardItem[]) => {});
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("ClipboardItem", MockClipboardItem);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write, writeText },
    });
    const gzhItem: DerivativeItem = {
      ...item,
      sourceVersion: 1,
      generatedAt: "now",
    };
    const listItems = ["先确认目标", "再拆分步骤", "最后检查结果"];
    const docPm = JSON.stringify({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "heading",
          attrs: { level: 1, blockId: "title" },
          content: [{ type: "text", text: "行动清单" }],
        },
        {
          type: "orderedList",
          attrs: { blockId: "checklist", start: 1 },
          content: listItems.map((text, index) => ({
            type: "listItem",
            attrs: { blockId: `item-${index}` },
            content: [{
              type: "paragraph",
              attrs: { blockId: `item-${index}-paragraph` },
              content: [{ type: "text", text }],
            }],
          })),
        },
      ],
    });
    const stream = {
      getDerivativeDoc: vi.fn(async () => ({
        meta: gzhItem,
        docPm,
        docVersion: 1,
        title: "",
      })),
    };

    await act(async () => {
      root.render(
        <ConfirmProvider>
          <DerivativeView
            sessionId="session-1"
            item={gzhItem}
            stream={stream as never}
            streamActive={false}
            onRefresh={vi.fn(async () => {})}
            onDeleted={vi.fn()}
            onToast={vi.fn()}
            onSendQuery={vi.fn()}
          />
        </ConfirmProvider>,
      );
      await Promise.resolve();
    });

    const previewItems = Array.from(
      host.querySelectorAll(".wx-article #js_content li"),
      (node) => node.textContent,
    );
    expect(previewItems).toEqual(listItems);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="导出"]')!.click());
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "复制文案")!.click());

    expect(writeText).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
    const clipboardItem = write.mock.calls[0]?.[0]?.[0];
    expect(clipboardItem?.types).toEqual(["text/plain", "text/html"]);
    const blobText = (blob: Blob) => new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
    const copiedText = await blobText(await clipboardItem!.getType("text/plain"));
    const copiedHtml = await blobText(await clipboardItem!.getType("text/html"));
    expect(copiedText).toContain("行动清单");
    expect(copiedText).not.toContain("<ol");
    const copiedDocument = new DOMParser().parseFromString(copiedHtml, "text/html");
    expect(Array.from(copiedDocument.querySelectorAll("#js_content li"), (node) => node.textContent))
      .toEqual(previewItems);
    for (const listItem of listItems) {
      expect(copiedHtml.split(listItem)).toHaveLength(2);
    }
  });

  it("微信手机预览包含真实 meta 形态和四组底栏操作", async () => {
    const doc = { type: "doc", attrs: { schemaVersion: 1 }, content: [{ type: "paragraph", attrs: { blockId: "p1" }, content: [{ type: "text", text: "正文" }] }] } as never;
    await act(async () => root.render(<DTYPE_REGISTRY.gzh.PhonePreview doc={doc} title="标题" articleRef={vi.fn()}/>));
    expect(Array.from(host.querySelectorAll(".wx-meta > span")).map((node) => node.textContent)).toEqual(["青简", "刚刚", "广东"]);
    expect(Array.from(host.querySelectorAll(".wx-toolbar-actions small")).map((node) => node.textContent)).toEqual(["赞", "分享", "推荐", "写留言"]);
    expect(host.querySelectorAll(".wx-toolbar-actions svg")).toHaveLength(4);
    const sharePaths = Array.from(
      host.querySelectorAll(".wx-toolbar-actions > span:nth-child(2) svg path"),
      (path) => path.getAttribute("d"),
    );
    expect(sharePaths).toEqual(["m14 4 6 5-6 5", "M20 9h-5.5C8.7 9 5 12.1 4 19"]);
    expect(sharePaths.every((path) => !path?.includes("v1"))).toBe(true);
    expect(host.querySelector(".ps-cellular rect:nth-child(4)")?.getAttribute("height")).toBe("12");
    expect(host.querySelectorAll(".ps-wifi path")).toHaveLength(3);
    expect(host.querySelector(".ps-battery-fill")?.getAttribute("width")).toBe("16.2");
    expect(host.querySelector(".wx-back .preview-chevron path")?.getAttribute("d")).toBe("m15 3-9 9 9 9");
    expect(host.querySelectorAll(".wx-more-icon circle")).toHaveLength(3);
  });

  it("公众号预览正文层级使用下调后的字号与等比字距", () => {
    const css = readFileSync(resolve(process.cwd(), "src/pages/workspace/components/derivatives/wechatPreview.css"), "utf8");
    expect(css).toContain(".wx-article .rich_media_title{margin:0 0 14px;color:#191919;font-size:20px;");
    expect(css).toContain(".wx-meta>span{display:inline-block;margin:0 10px 10px 0;font-size:14px;");
    expect(css).toContain(".wx-article #js_content{color:rgba(0,0,0,.9);font-size:16px;line-height:1.75;letter-spacing:.032em;");
    expect(css).toContain(".wx-article #js_content h2{font-size:18px}.wx-article #js_content h3{font-size:17px}");
  });

  it("小红书电脑预览为左图右文且不伪造评论", async () => {
    const doc = { type: "doc", attrs: { schemaVersion: 1 }, content: [{ type: "paragraph", attrs: { blockId: "p1" }, content: [{ type: "text", text: "#真实体验" }] }] } as never;
    await act(async () => root.render(<DTYPE_REGISTRY.xhs.DesktopPreview doc={doc} title="桌面笔记" articleRef={vi.fn()}/>));
    expect(host.querySelector(".xhs-desktop-card")?.children).toHaveLength(2);
    expect(host.querySelector(".xhs-desktop-media .xhs-cover")?.textContent).toContain("桌面笔记");
    expect(host.querySelector(".xhs-comments")?.textContent).toBe("共 0 条评论暂无评论");
    expect(host.querySelector(".xhs-desktop-content .xhs-interaction")?.textContent).toContain("说点什么");
    expect(host.querySelectorAll(".xhs-action-icon")).toHaveLength(4);
    expect(host.querySelector(".ws-macbook-camera")).not.toBeNull();
    expect(host.querySelector(".ws-macbook-viewport > .xhs-desktop")).not.toBeNull();
    expect(host.querySelector(".xhs-desktop-card")?.children).toHaveLength(2);
    expect(host.querySelector(".xhs-desktop-card")?.getAttribute("data-design-size")).toBe("1040x642");
  });

  it("公众号电脑预览位于可滚动屏内视窗并放宽为 760px 内容栏", async () => {
    const doc = { type: "doc", attrs: { schemaVersion: 1 }, content: [{ type: "paragraph", attrs: { blockId: "p1" }, content: [{ type: "text", text: "长文正文" }] }] } as never;
    await act(async () => root.render(<DTYPE_REGISTRY.gzh.DesktopPreview doc={doc} title="桌面长文" articleRef={vi.fn()}/>));
    expect(host.querySelector(".ws-macbook-lid .ws-macbook-bezel .ws-macbook-viewport")).not.toBeNull();
    expect(host.querySelector(".ws-macbook-viewport > .wx-desktop > .wx-article")?.textContent).toContain("长文正文");
    expect(host.querySelector(".ws-macbook-base .ws-macbook-notch")).not.toBeNull();
    expect(host.querySelector(".ws-macbook-viewport")?.getAttribute("data-design-size")).toBe("1100x690");
    expect(host.querySelector(".ws-macbook-viewport")?.getAttribute("data-scroll")).toBe("vertical");
    expect(host.querySelector(".wx-desktop")?.getAttribute("data-content-width")).toBe("760");
  });
});
