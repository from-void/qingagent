import { Router, routeToHash, useRoute } from "./shell";
import type { RouteName } from "./shell";
import { AppUpdateWatcher } from "./system/AppUpdateWatcher";
import { DesktopDialogHost } from "./system/DesktopDialogHost";
import { AuthTokenGate } from "./system/AuthTokenGate";
import { EditContextMenu } from "./system/EditContextMenu";
import { ConfirmProvider, ToastProvider, useToast } from "./system";
import { awaitPendingStylesheets } from "./system/awaitStyles";
import { onceAsync } from "./system/onceAsync";
import { WORKSPACE_PAPER_CSS_VARIABLES } from "./system/workspacePaperGeometry";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
// 路由页面懒加载:首页只下载 home chunk,workspace 的 tiptap 编辑器等不再进首屏 bundle。
// 各页都抽成命名工厂,既给 lazy 用,也给「空闲预热」用 —— 同一个 import 工厂只会拉一次 chunk。
//
// ⚠️ 每个工厂都必须用 onceAsync 记忆化 —— 这是「组件早于样式挂载 → 无样式裸 DOM」的主防线。
// Vite 把 import("./x") 编译成 __vitePreload(() => import("./x-hash.js"), deps),**每次调用工厂
// 都会走一遍 __vitePreload**,而它用模块级 seen 表去重:只有第一次碰到某个 CSS 才返回「等 link
// load」的 promise。若下面的空闲预热调一次(等待被 void 掉)、用户切页时 lazy 再调一次,第二次就
// seen 命中直接短路,不等 CSS 就把 chunk 交出去 → 组件先挂载、样式后到,那几百毫秒是完全无样式
// 的裸 DOM(布局/字色/玻璃感全丢)。记忆化后 __vitePreload 只被调用一次(预热那次,它老实等 CSS),
// lazy 复用同一个 promise,resolve 时样式必然已生效。
// 于是 CSS 仍可按页分割:首屏只下首页那份,其余后台预载 —— 不必把全站 CSS 压进首屏。
// 用户在预载完成前就切页时,等的是同一个 promise:期间 startTransition 保留旧页面的到达态静止帧
// (或 Suspense 纯色兜底),都是干净的一屏。
//
// styled 是**第二道**(零成本:没有 pending 样式表就立即 resolve),兜「别处已先 import 过、seen
// 已被污染」这类边缘情况。注意它的等待必须带超时(网络异常不能卡死导航),故单靠它治不了根。
const PAGE_STYLE_TIMEOUT_MS = 3000;
const styled = <T,>(mod: T): Promise<T> =>
  awaitPendingStylesheets(PAGE_STYLE_TIMEOUT_MS).then(() => mod);
const loadHome = onceAsync(() => import("./pages/home/HomePage").then(styled));
const HomePage = lazy(() => loadHome().then((m) => ({ default: m.HomePage })));
// 编辑页最重(tiptap 编辑器等),也抽命名工厂供预热,消除「首页→编辑页」首切白屏。
const loadWorkspace = onceAsync(() =>
  import("./pages/workspace/WorkspacePage").then(styled),
);
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
        <DesktopDialogHost />
        <AuthTokenGate />
        {/* 可编辑区域的自绘右键菜单(宋体、水墨皮肤);非编辑区域不接管。 */}
        <EditContextMenu />
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
  workspace: { pageFrameModifier: "web-page-frame--workspace", suspenseBackground: "#16212c" },
};

function AppShell() {
  const toast = useToast();
  const isMobileViewport = useIsMobileViewport();
  const qingjianOpenRequestRef = useRef(0);

  useEffect(() => {
    const subscribe = window.electron?.onQingjianOpenSession;
    if (!subscribe) return;
    return subscribe(({ engineSessionId }) => {
      const requestId = ++qingjianOpenRequestRef.current;
      void fetch(
        `/api/v1/external/sessions/${encodeURIComponent(engineSessionId)}/doc?format=pm`,
        { method: "HEAD", cache: "no-store" },
      ).then((response) => {
        if (requestId !== qingjianOpenRequestRef.current) return;
        if (response.ok) {
          window.location.hash = `${routeToHash("workspace")}?session=${encodeURIComponent(engineSessionId)}`;
          return;
        }
        toast.show({
          message: response.status === 404 ? "未找到对应文稿" : "暂时无法打开文稿",
          tone: "warn",
          dedupeKey: "qingjian-deep-link-open-failed",
        });
      }).catch(() => {
        if (requestId !== qingjianOpenRequestRef.current) return;
        toast.show({
          message: "暂时无法打开文稿",
          tone: "warn",
          dedupeKey: "qingjian-deep-link-open-failed",
        });
      });
    });
  }, [toast]);

  useEffect(() => {
    const handleSseRateLimited = () => {
      toast.show({
        message: "实时连接数过多，正在退避重连；请稍候或关闭不用的页面。",
        tone: "warn",
        dedupeKey: "sse-rate-limited",
      });
    };
    window.addEventListener("qa-sse-rate-limited", handleSseRateLimited);
    return () => window.removeEventListener("qa-sse-rate-limited", handleSseRateLimited);
  }, [toast]);

  // 预热路由 chunk:首屏空闲时把后续页面的 JS/CSS/编辑器模块拉好,切路由时 chunk 已在内存,
  // 页面即时挂出「到达态」,不再因 Suspense fallback(空白)露白闪一下。先热首页→编辑页要用的
  // 墨水过场,再热编辑页(最重,含 tiptap);home 兜底「用户先直达文章/编辑页、再返回首页」。
  // 同一工厂只拉一次,重复 void 无害。
  useEffect(() => {
    const warm = () => {
      void import("./system/transition/inkWipe").then(({ prewarmInkWipe }) => prewarmInkWipe());
      void loadWorkspace();
      void loadHome();
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
    return (
      <MobileOpenOnDesktopNotice
        onCopied={() => action("复制成功")}
        onCopyFailed={() => toast.show({
          message: "自动复制失败，请长按上方网址手动复制",
          tone: "warn",
          dedupeKey: "desktop-url-copy-failed",
        })}
      />
    );
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
      <main
        className={pageFrameClass}
        style={WORKSPACE_PAPER_CSS_VARIABLES as CSSProperties}
      >
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

export function MobileOpenOnDesktopNotice({
  onCopied,
  onCopyFailed,
  url = DESKTOP_SITE_URL,
}: {
  onCopied: () => void;
  onCopyFailed: () => void;
  url?: string;
}) {
  const copyUrl = async () => {
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        copied = true;
      }
    } catch {
      // 移动端非安全上下文可能拒绝 Clipboard API，继续走兼容回退。
    }
    if (!copied) {
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      try {
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        copied = document.execCommand("copy");
      } catch {
        copied = false;
      } finally {
        ta.remove();
      }
    }
    if (copied) onCopied();
    else onCopyFailed();
  };

  const hasUrl = url.length > 0;
  return (
    <main className="mobile-desktop-notice" aria-labelledby="mobile-desktop-notice-title">
      <section className="mobile-desktop-notice__content">
        <p id="mobile-desktop-notice-title" className="mobile-desktop-notice__title">
          {hasUrl ? "暂不支持手机使用，请复制链接到电脑打开" : "暂不支持手机使用，请在电脑浏览器打开本站"}
        </p>
        {hasUrl && (
          <>
            <p className="mobile-desktop-notice__url">{url}</p>
            <button type="button" className="mobile-desktop-notice__button" onClick={copyUrl}>
              复制网址
            </button>
          </>
        )}
      </section>
    </main>
  );
}
