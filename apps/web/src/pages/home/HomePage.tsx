import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { routeToHash, routeToNewWorkspaceHash } from "../../shell";
import "./home.css";
import { makeMockSessions, sessionMetaToHomeSession } from "./data/sessions";
import type { HomeSession } from "./data/sessions";
import { BookCurlShelf } from "./components/BookCurlShelf";
import { QingjianScroll } from "./components/QingjianScroll";
import { useSessionStore } from "../../stores/sessionStore";
import { FolderPromptDialog, type FolderPromptDialogControls } from "../../system/FolderSourceControl";
import { useToast } from "../../system";
import { useBackendConnection } from "../../system/backendConnectionStore";
import { FirstRunGate } from "../../system/onboarding/FirstRunGate";
import { OnboardingLoadingPage, OnboardingPage } from "../onboarding/OnboardingPage";
import { CloseIcon } from "../../system/icons";

const BOOK_SOURCES = [
  {
    id: "feishu-docs",
    title: "飞书文档",
    description: "读取你的飞书文档",
  },
  {
    id: "obsidian",
    title: "Obsidian",
    description: "读取你的本地笔记",
  },
  {
    id: "feishu-wiki",
    title: "飞书文档",
    description: "读取你的飞书文档",
  },
  {
    id: "feishu-space",
    title: "飞书文档",
    description: "读取你的飞书文档",
  },
] as const;

interface ArticleContextMenu {
  session: HomeSession;
  x: number;
  y: number;
  isDeleting: boolean;
}

interface DeleteConfirmState {
  session: HomeSession;
  suppressFor24h: boolean;
  isDeleting: boolean;
}

const DELETE_CONFIRM_SKIP_UNTIL = "home-delete-confirm-skip-until";
const DELETE_CONFIRM_SKIP_MS = 24 * 60 * 60 * 1000;
const GENERATION_POLL_INTERVAL_MS = 2_000;

function shouldSkipDeleteConfirm(): boolean {
  try {
    const raw = localStorage.getItem(DELETE_CONFIRM_SKIP_UNTIL);
    if (!raw) return false;
    const expiresAt = Number(raw);
    return Number.isFinite(expiresAt) && Date.now() < expiresAt;
  } catch {
    return false;
  }
}

function setDeleteConfirmSkipFor24h() {
  try {
    localStorage.setItem(DELETE_CONFIRM_SKIP_UNTIL, String(Date.now() + DELETE_CONFIRM_SKIP_MS));
  } catch {
    /* ignore */
  }
}

export function HomePage() {
  return (
    <FirstRunGate
      onboarding={<OnboardingPage />}
      loading={<OnboardingLoadingPage />}
    >
      <HomeExperience />
    </FirstRunGate>
  );
}

function HomeExperience() {
  const toast = useToast();
  const backendConnection = useBackendConnection();
  const sessionDeletionEnabled = backendConnection?.mode !== "attach"
    || backendConnection.effectiveCapabilities.sessionDeletion === true;
  const [articleMenu, setArticleMenu] = useState<ArticleContextMenu | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState | null>(null);
  const [cleanMode, setCleanMode] = useState(false);
  const [shelfOpen, setShelfOpen] = useState(false);
  // QingjianScroll 写入的「带动画打开」出口,供右键菜单「打开」复用左键的墨水过场。
  const openSessionApiRef = useRef<((sessionId: string) => void) | null>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);

  const {
    sessions: apiSessions,
    error: fetchError,
    fetchSessions,
    removeSession,
  } = useSessionStore();

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  const hasGeneratingSession = apiSessions.some(
    (session) => session.generating && session.status.kind === "Active",
  );
  useEffect(() => {
    if (!hasGeneratingSession) return;
    const timer = window.setInterval(() => {
      void fetchSessions();
    }, GENERATION_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [fetchSessions, hasGeneratingSession]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === "H" || event.key === "h")) {
        event.preventDefault();
        setCleanMode((value) => !value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const sessions = useMemo((): HomeSession[] => {
    // 开发演示:URL 带 ?mock=N(search 或 hash 均可)时,注入 N 条 mock 会话,
    // 让长卷可一直向右滚动浏览装饰草木。无该参数时不触发,走真实数据。
    const mockMatch = window.location.href.match(/[?&]mock=(\d+)/);
    if (mockMatch) {
      // ?long=1 时生成长标题 + 长摘要,用于排查长文撑烂模板
      const long = /[?&]long=1\b/.test(window.location.href);
      return makeMockSessions(Number(mockMatch[1]), { long });
    }
    // 审计修复:后端不可用时原先把 399 行硬编码演示会话(HOME_SESSIONS)当真数据
    // 展示,用户会看到一屏不属于自己的文章。改为空列表 + 可见错误条 + 重试。
    if (fetchError) return [];
    return apiSessions.map(sessionMetaToHomeSession);
  }, [apiSessions, fetchError]);

  const handleOpenSession = useCallback((sessionId: string) => {
    if (sessions.some((session) => session.id === sessionId && session.isDeleting)) return;
    window.location.hash = `${routeToHash("workspace")}?session=${encodeURIComponent(sessionId)}`;
  }, [sessions]);

  const handleCreate = useCallback(() => {
    // 点「新建」显式携带 new 意图；只有 session=<id> 才代表恢复历史会话。
    window.location.hash = routeToNewWorkspaceHash();
  }, []);

  const closeArticleMenu = useCallback(() => {
    setArticleMenu(null);
  }, []);

  const deleteArticle = useCallback(async (
    session: HomeSession,
    suppressFor24h: boolean,
    afterSuccess?: () => void,
  ) => {
    if (!sessionDeletionEnabled) return;
    setDeleteConfirm((state) => (state ? { ...state, isDeleting: true } : state));
    setArticleMenu((menu) => (menu ? { ...menu, isDeleting: true } : menu));
    try {
      await removeSession(session.id);
      if (suppressFor24h) setDeleteConfirmSkipFor24h();
      setArticleMenu(null);
      if (afterSuccess) {
        afterSuccess();
      } else {
        setDeleteConfirm(null);
      }
    } catch {
      setArticleMenu((menu) => (menu ? { ...menu, isDeleting: false } : menu));
      setDeleteConfirm((state) => (state ? { ...state, isDeleting: false } : state));
      toast.show({
        message: "删除失败，请重试",
        tone: "error",
        dedupeKey: "home-delete-failed",
      });
    }
  }, [removeSession, sessionDeletionEnabled, toast]);

  const handleArticleContextMenu = useCallback((event: MouseEvent<HTMLElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    const slot = target?.closest(".qj-card-slot");

    if (!slot) {
      setArticleMenu(null);
      return;
    }

    if (slot.getAttribute("data-kind") === "new") {
      return;
    }

    const articleId = slot.getAttribute("data-id");
    const session = articleId ? sessions.find((item) => item.id === articleId) : undefined;
    if (!session || session.isDeleting) return;

    const rawX = Number.isFinite(event.clientX) ? event.clientX : 24;
    const rawY = Number.isFinite(event.clientY) ? event.clientY : 24;

    event.preventDefault();
    event.stopPropagation();
    setArticleMenu({
      session,
      x: Math.max(12, Math.min(rawX, window.innerWidth - 176)),
      y: Math.max(12, Math.min(rawY, window.innerHeight - 112)),
      isDeleting: false,
    });
  }, [sessions]);

  const handleDeleteArticle = useCallback(async () => {
    if (!articleMenu) return;
    const session = articleMenu.session;
    if (shouldSkipDeleteConfirm()) {
      await deleteArticle(session, false);
      return;
    }
    setArticleMenu(null);
    setDeleteConfirm({
      session,
      suppressFor24h: false,
      isDeleting: false,
    });
  }, [articleMenu, deleteArticle]);

  const handleConfirmDelete = useCallback(async (closeDialog?: FolderPromptDialogControls["close"]) => {
    if (!deleteConfirm) return;
    await deleteArticle(
      deleteConfirm.session,
      deleteConfirm.suppressFor24h,
      closeDialog ? () => closeDialog(() => setDeleteConfirm(null), { force: true }) : undefined,
    );
  }, [deleteArticle, deleteConfirm]);

  const handleOpenArticleFromMenu = useCallback(() => {
    if (!articleMenu) return;
    const sessionId = articleMenu.session.id;
    setArticleMenu(null);
    // 走与左键点击一致的带动画打开;没注册到(理论不会)则回退直接导航。
    const openAnimated = openSessionApiRef.current;
    if (openAnimated) openAnimated(sessionId);
    else handleOpenSession(sessionId);
  }, [articleMenu, handleOpenSession]);

  const handleDeleteConfirmCancel = useCallback(() => {
    if (!deleteConfirm?.isDeleting) {
      setDeleteConfirm(null);
    }
  }, [deleteConfirm?.isDeleting]);

  const toggleDeleteConfirmSkip = useCallback(() => {
    setDeleteConfirm((state) => (
      state ? { ...state, suppressFor24h: !state.suppressFor24h } : state
    ));
  }, []);

  useEffect(() => {
    if (!articleMenu) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".home-card-menu")) return;
      setArticleMenu(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setArticleMenu(null);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", closeArticleMenu);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", closeArticleMenu);
    };
  }, [articleMenu, closeArticleMenu]);

  useEffect(() => {
    if (!shelfOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShelfOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [shelfOpen]);

  return (
    <section
      data-view="home"
      data-wf="HomePage"
      id="view-home"
      className={`home-qingjian${cleanMode ? " is-clean" : ""}`}
      onContextMenu={handleArticleContextMenu}
    >
      {/* 构建版本角标:显示这个包是什么时候打的(build-win.sh 注入,dev 为 "dev"),便于验收区分新旧包。 */}
      <div
        title="构建版本"
        style={{
          position: "fixed",
          right: 8,
          bottom: 6,
          zIndex: 40,
          fontSize: 10,
          lineHeight: 1.2,
          opacity: 0.3,
          color: "#9a8f7a",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          pointerEvents: "none",
          letterSpacing: "0.02em",
        }}
      >
        {__BUILD_INFO__}
      </div>
      {fetchError ? (
        <div className="home-fetch-error" role="alert">
          <span>列表加载失败，请重试</span>
          <button type="button" onClick={() => fetchSessions()}>
            重试
          </button>
        </div>
      ) : null}

      <QingjianScroll
        sessions={sessions}
        onOpenSession={handleOpenSession}
        onNewSession={handleCreate}
        onOpenShelf={() => setShelfOpen(true)}
        cleanMode={cleanMode}
        openApiRef={openSessionApiRef}
      />

      {articleMenu ? (
        <div
          className="home-card-menu"
          role="menu"
          style={{ left: articleMenu.x, top: articleMenu.y }}
        >
          <button
            type="button"
            role="menuitem"
            className="home-card-menu-item"
            onClick={handleOpenArticleFromMenu}
            disabled={articleMenu.isDeleting}
          >
            打开
          </button>
          <button
            type="button"
            role="menuitem"
            className="home-card-menu-item is-danger"
            onClick={handleDeleteArticle}
            disabled={articleMenu.isDeleting || !sessionDeletionEnabled}
            title={sessionDeletionEnabled ? undefined : "当前青简引擎暂不支持删除"}
          >
            {articleMenu.isDeleting ? "删除中..." : "删除"}
          </button>
        </div>
      ) : null}

      {deleteConfirm ? (
        <FolderPromptDialog
          anchor={null}
          dataWf="HomeDeleteConfirmOverlay"
          titleId="home-delete-confirm-title"
          modalClassName="ws-folder-intro-modal home-delete-confirm-modal"
          onCancel={handleDeleteConfirmCancel}
          cancelDisabled={deleteConfirm.isDeleting}
          initialFocusRef={deleteCancelRef}
        >
          {({ close }) => (
            <>
              <div className="ws-folder-modal-icon home-delete-confirm-icon" aria-hidden="true">
                <TrashIcon />
              </div>
              <h3 id="home-delete-confirm-title">删除这篇文章？</h3>
              <p>
                「{deleteConfirm.session.title}」删除后不会再出现在首页，文档与对话记录不可再恢复。
              </p>
              <div className="ws-folder-modal-foot home-delete-confirm-foot">
                <label className="ws-folder-check">
                  <input
                    className="wf-checkbox"
                    type="checkbox"
                    checked={deleteConfirm.suppressFor24h}
                    onChange={toggleDeleteConfirmSkip}
                    disabled={deleteConfirm.isDeleting}
                  />
                  <span>24小时内不再提醒</span>
                </label>
                <div className="home-delete-confirm-actions">
                  <button
                    type="button"
                    className="ws-folder-modal-danger"
                    onClick={() => void handleConfirmDelete(close)}
                    disabled={deleteConfirm.isDeleting || !sessionDeletionEnabled}
                  >
                    {deleteConfirm.isDeleting ? "删除中..." : "删除"}
                  </button>
                  <button
                    type="button"
                    className="ws-folder-modal-secondary"
                    ref={deleteCancelRef}
                    onClick={() => close()}
                    disabled={deleteConfirm.isDeleting}
                  >
                    取消
                  </button>
                </div>
              </div>
            </>
          )}
        </FolderPromptDialog>
      ) : null}

      {shelfOpen ? (
        <div className="qj-shelf-overlay" role="dialog" aria-modal="true" aria-label="书阁">
          <div className="qj-shelf-backdrop" onClick={() => setShelfOpen(false)} />
          <section className="qj-shelf-panel">
            <header className="qj-shelf-head">
              <div>
                <h2>书阁</h2>
                <p>文档源与技能入口</p>
              </div>
              <button type="button" className="qj-shelf-close" aria-label="关闭书阁" onClick={() => setShelfOpen(false)}>
                <CloseIcon size={18} />
              </button>
            </header>
            <BookCurlShelf books={BOOK_SOURCES} />
          </section>
        </div>
      ) : null}
    </section>
  );
}

function TrashIcon() {
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 7h16" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M6 7l1 13h10l1-13" />
      <path d="M9 7V4h6v3" />
    </svg>
  );
}
