import { Router, useRoute } from "./shell";
import type { RouteName } from "./shell";
import { AppUpdateWatcher } from "./system/AppUpdateWatcher";
import { AuthTokenGate } from "./system/AuthTokenGate";
import { ConfirmProvider, ToastProvider, useToast } from "./system";
import { lazy, Suspense, useEffect, useState } from "react";
import type { ReactNode } from "react";
// 路由页面懒加载:首页只下载 home chunk,workspace 的 tiptap 编辑器等不再进首屏 bundle。
// 各页都抽成命名工厂,既给 lazy 用,也给「空闲预热」用 —— 同一个 import 工厂只会拉一次 chunk。
const loadHome = () => import("./pages/home/HomePage");
const HomePage = lazy(() => loadHome().then((m) => ({ default: m.HomePage })));
const loadNewSession = () => import("./pages/new-session/NewSessionPage");
const NewSessionPage = lazy(() => loadNewSession().then((m) => ({ default: m.NewSessionPage })));
// 编辑页最重(tiptap 编辑器等),也抽命名工厂供预热,消除「新建页→编辑页」首切白屏。
const loadWorkspace = () => import("./pages/workspace/WorkspacePage");
const WorkspacePage = lazy(() => loadWorkspace().then((m) => ({ default: m.WorkspacePage })));
const devPages = import.meta.env.DEV
  ? {
      DebugPage: lazy(() =>
        import("./pages/debug/DebugPage").then((m) => ({ default: m.DebugPage })),
      ),
      GalleryPage: lazy(() =>
        import("./pages/gallery/GalleryPage").then((m) => ({ default: m.GalleryPage })),
      ),
      SpecDemoPage: lazy(() =>
        import("./pages/gallery/SpecDemoPage").then((m) => ({ default: m.SpecDemoPage })),
      ),
      UIKitPage: lazy(() =>
        import("./pages/uikit/UIKitPage").then((m) => ({ default: m.UIKitPage })),
      ),
    }
  : null;
import "./app.css";

export default function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <AppShell />
        <AppUpdateWatcher />
        <AuthTokenGate />
      </ConfirmProvider>
    </ToastProvider>
  );
}

// 桌面版站点地址:构建期注入(官方构建设 VITE_DESKTOP_SITE_URL)。未注入时移动端提示不点名域名,
// 开源 fork 直接构建即得干净默认(复用遥测端点 opt-in 范式:源码零默认)。
const DESKTOP_SITE_URL = (import.meta.env.VITE_DESKTOP_SITE_URL ?? "").trim();
const MOBILE_VIEWPORT_QUERY = "(max-width: 767px)";
const ROUTE_PRESENTATION: Partial<
  Record<RouteName, { pageFrameModifier?: string; suspenseBackground: string }>
> = {
  // 这些纯色来自各懒加载页面 CSS 的最底层；CSS chunk 未到时由主包先铺同色，避免切页露底。
  home: { pageFrameModifier: "web-page-frame--qingjian-home", suspenseBackground: "#1c1915" },
  "new-session": { suspenseBackground: "#16212c" },
  workspace: { pageFrameModifier: "web-page-frame--workspace", suspenseBackground: "#16212c" },
};

function AppShell() {
  const toast = useToast();
  const isMobileViewport = useIsMobileViewport();

  // 预热路由 chunk:首屏空闲时把后续页面的 JS/CSS/编辑器模块拉好,任意切路由时 chunk 已在内存,
  // 页面即时挂出「到达态」,不再因 Suspense fallback(空白)露白闪一下。顺序:先热新建页(首页的
  // 下一步),就绪后接着热编辑页(最重,含 tiptap)——消除「首页→新建页」「新建页→编辑页」两次
  // 首切白屏;home 兜底「用户先直达文章/编辑页、再返回首页」。同一工厂只拉一次,重复 void 无害。
  useEffect(() => {
    const warm = () => {
      void loadNewSession().finally(() => {
        void import("./pages/new-session/transition/inkWipe").then(({ prewarmInkWipe }) => prewarmInkWipe());
        void loadWorkspace();
        void loadHome();
      });
    };
    const ric = (window as typeof window & {
      requestIdleCallback?: (cb: () => void) => number;
    }).requestIdleCallback;
    if (ric) {
      ric(warm);
    } else {
      const t = window.setTimeout(warm, 200);
      return () => window.clearTimeout(t);
    }
  }, []);
  const action = (msg: string) => toast.show(msg);
  // 首页/编辑页都要全宽:按当前路由同步给 .web-page-frame 拼 class(首帧 paint 前就生效),
  // 避免懒加载/Suspense 期间外层先以 max-width:1440px 居中 + 浅纸底渲染一帧再撑全宽深底的闪烁。
  // 编辑页尤甚:首页跑完深色到达帧切来后,若 --workspace 靠 paint 后的 useEffect 才加,会先闪一帧
  // 浅色窄框(见 workspace 从 useEffect 迁到此处的修复)。
  const route = useRoute();
  const routePresentation = ROUTE_PRESENTATION[route];
  const pageFrameClass = `web-page-frame${
    routePresentation?.pageFrameModifier ? ` ${routePresentation.pageFrameModifier}` : ""
  }`;
  const suspenseBackground = routePresentation?.suspenseBackground ?? "var(--app-boot-bg, #ece4d3)";
  if (isMobileViewport) {
    return <MobileOpenOnDesktopNotice onCopied={() => action("复制成功")} />;
  }
  const devRoutes: Partial<Record<RouteName, ReactNode>> = devPages
    ? {
        debug: <devPages.DebugPage />,
        gallery: <devPages.GalleryPage />,
        spec: <devPages.SpecDemoPage />,
        uikit: <devPages.UIKitPage />,
      }
    : {};

  return (
    <div data-wf="AppShell" id="web-app-shell" className="web-app-shell">
      <main className={pageFrameClass}>
        <Suspense
          fallback={
            <div
              style={{ height: "100vh", background: suspenseBackground }}
              aria-hidden
            />
          }
        >
          <Router
            routes={{
              home: <HomePage />,
              "new-session": <NewSessionPage />,
              workspace: <WorkspacePage />,
              ...devRoutes,
            }}
          />
        </Suspense>
      </main>
    </div>
  );
}

function useIsMobileViewport() {
  const getIsMobile = () =>
    typeof window !== "undefined" ? window.matchMedia(MOBILE_VIEWPORT_QUERY).matches : false;
  const [isMobileViewport, setIsMobileViewport] = useState(getIsMobile);

  useEffect(() => {
    const query = window.matchMedia(MOBILE_VIEWPORT_QUERY);
    const update = () => setIsMobileViewport(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return isMobileViewport;
}

function MobileOpenOnDesktopNotice({ onCopied }: { onCopied: () => void }) {
  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(DESKTOP_SITE_URL);
    } catch {
      // 移动端非安全上下文 / 不支持 Clipboard API 时,回退到 execCommand 复制
      const ta = document.createElement("textarea");
      ta.value = DESKTOP_SITE_URL;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* 忽略:即便复制失败也提示用户网址已显示在页面上 */
      }
      document.body.removeChild(ta);
    }
    onCopied();
  };

  const hasUrl = DESKTOP_SITE_URL.length > 0;
  return (
    <main className="mobile-desktop-notice" aria-labelledby="mobile-desktop-notice-title">
      <section className="mobile-desktop-notice__content">
        <p id="mobile-desktop-notice-title" className="mobile-desktop-notice__title">
          {hasUrl ? "暂不支持手机使用，请复制链接到电脑打开" : "暂不支持手机使用，请在电脑浏览器打开本站"}
        </p>
        {hasUrl && (
          <>
            <p className="mobile-desktop-notice__url">{DESKTOP_SITE_URL}</p>
            <button type="button" className="mobile-desktop-notice__button" onClick={copyUrl}>
              复制网址
            </button>
          </>
        )}
      </section>
    </main>
  );
}
