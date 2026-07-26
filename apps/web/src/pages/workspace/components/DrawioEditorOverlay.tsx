import { useEffect, useRef, useState } from "react";
import {
  DRAWIO_AUTOSAVE_DEBOUNCE_MS,
  DRAWIO_EMBED_PATH,
  DRAWIO_EXPORT_TIMEOUT_MS,
  DRAWIO_FALLBACK_TIMEOUT_MS,
  createDrawioLoadAction,
  createDrawioSnapshotRequest,
  createDrawioStatusAction,
  encodeDrawioAction,
  finalizeDrawioEdit,
  parseDrawioEmbedMessage,
  type DrawioEditorResult,
  type DrawioSnapshotAction,
} from "./drawioEmbedProtocol";
import { renderDrawio } from "./drawioRender";
import "./DrawioEditorOverlay.css";
import "./diagramEditorChrome.css";

export interface DrawioEditorOverlayProps {
  source: string;
  title?: string;
  onSave?: (result: DrawioEditorResult) => void;
  onClose: (result: DrawioEditorResult | null) => void;
}

export function DrawioEditorOverlay({
  source,
  title = "Drawio 编辑",
  onSave,
  onClose,
}: DrawioEditorOverlayProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const settledRef = useRef(false);
  const pendingSourceRef = useRef<string | null>(null);
  const pendingSaveIdRef = useRef<number | null>(null);
  const queuedSourceRef = useRef<string | null>(null);
  const queuedForceRef = useRef(false);
  const closeRequestedRef = useRef(false);
  const latestResultRef = useRef<DrawioEditorResult | null>(null);
  const latestHighFidelityResultRef = useRef<DrawioEditorResult | null>(null);
  const lastWrittenSourceRef = useRef(source);
  const saveSequenceRef = useRef(0);
  const exportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestCloseRef = useRef<() => void>(() => undefined);
  const [saving, setSaving] = useState(false);
  const [frameReady, setFrameReady] = useState(false);
  const [status, setStatus] = useState("正在启动离线编辑器…");

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    const expectedOrigin = window.location.origin;
    const postAction = (
      action:
        | ReturnType<typeof createDrawioLoadAction>
        | ReturnType<typeof createDrawioStatusAction>
        | DrawioSnapshotAction,
    ) => {
      iframeRef.current?.contentWindow?.postMessage(encodeDrawioAction(action), expectedOrigin);
    };
    const clearExportTimer = () => {
      if (exportTimerRef.current === null) return;
      clearTimeout(exportTimerRef.current);
      exportTimerRef.current = null;
    };
    const clearAutosaveTimer = () => {
      if (autosaveTimerRef.current === null) return;
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    };
    const clearRetryTimer = () => {
      if (retryTimerRef.current === null) return;
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    };
    const finish = (result: DrawioEditorResult | null) => {
      if (settledRef.current) return;
      settledRef.current = true;
      clearExportTimer();
      clearAutosaveTimer();
      clearRetryTimer();
      setSaving(false);
      onClose(result);
    };
    const clearPendingSave = () => {
      pendingSourceRef.current = null;
      pendingSaveIdRef.current = null;
    };

    let startQueuedSave: () => void = () => undefined;
    const scheduleRetry = (retrySource: string) => {
      if (settledRef.current || closeRequestedRef.current) return;
      queuedSourceRef.current = retrySource;
      queuedForceRef.current = true;
      clearRetryTimer();
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        startQueuedSave();
      }, DRAWIO_AUTOSAVE_DEBOUNCE_MS);
    };
    const completeSave = (result: DrawioEditorResult, saveId: number) => {
      if (settledRef.current || pendingSaveIdRef.current !== saveId) return;
      clearExportTimer();
      clearPendingSave();
      latestResultRef.current = result;
      lastWrittenSourceRef.current = result.source;
      try {
        onSave?.(result);
      } catch {
        if (queuedSourceRef.current === null) scheduleRetry(result.source);
      }
      // keepmodified=1 配合写回前显式 status(true)，让 v31 snapshot 能看到脏状态；
      // 落盘后复位，下一次真实编辑仍会由 autosave 事件重新进入写回。
      postAction(createDrawioStatusAction(false));
      setSaving(false);
      setStatus(result.warning ? "已实时写入，正在补全预览缓存…" : "所有更改均已实时写入");
      iframeRef.current?.focus();
      if (
        queuedSourceRef.current !== null &&
        autosaveTimerRef.current === null &&
        retryTimerRef.current === null
      ) {
        startQueuedSave();
        return;
      }
      if (result.warning) scheduleRetry(result.source);
      if (closeRequestedRef.current) finish(result);
    };
    const fallbackToLocalRender = async (
      fallbackSource: string,
      saveId: number,
      reason = "drawio 原生 SVG 导出超时",
    ) => {
      if (
        settledRef.current ||
        pendingSourceRef.current !== fallbackSource ||
        pendingSaveIdRef.current !== saveId
      ) {
        return;
      }
      setStatus("正在实时写入…");
      try {
        const svg = await withTimeout(
          renderDrawio(fallbackSource),
          DRAWIO_FALLBACK_TIMEOUT_MS,
          "maxGraph 本地渲染超时",
        );
        if (
          settledRef.current ||
          pendingSourceRef.current !== fallbackSource ||
          pendingSaveIdRef.current !== saveId
        ) {
          return;
        }
        const highFidelityResult = latestHighFidelityResultRef.current?.source === fallbackSource
          ? latestHighFidelityResultRef.current
          : null;
        if (highFidelityResult) {
          completeSave(highFidelityResult, saveId);
          return;
        }
        completeSave({
          source: fallbackSource,
          svg,
          warning: `${reason}，已改用本地渲染保存`,
        }, saveId);
      } catch (fallbackError) {
        if (
          settledRef.current ||
          pendingSourceRef.current !== fallbackSource ||
          pendingSaveIdRef.current !== saveId
        ) {
          return;
        }
        const highFidelityResult = latestHighFidelityResultRef.current?.source === fallbackSource
          ? latestHighFidelityResultRef.current
          : null;
        if (highFidelityResult) {
          completeSave(highFidelityResult, saveId);
          return;
        }
        completeSave({
          source: fallbackSource,
          svg: null,
          warning: `drawio SVG 缓存生成失败，已保存可继续编辑的源码：${errorMessage(fallbackError)}`,
        }, saveId);
      }
    };

    startQueuedSave = () => {
      if (
        settledRef.current ||
        pendingSaveIdRef.current !== null ||
        queuedSourceRef.current === null
      ) {
        return;
      }
      clearAutosaveTimer();
      clearRetryTimer();
      const rawSource = queuedSourceRef.current;
      const force = queuedForceRef.current;
      queuedSourceRef.current = null;
      queuedForceRef.current = false;
      try {
        const request = createDrawioSnapshotRequest(rawSource);
        if (
          !force &&
          request.source === lastWrittenSourceRef.current &&
          !latestResultRef.current?.warning
        ) {
          if (closeRequestedRef.current) finish(latestResultRef.current);
          return;
        }
        const saveId = ++saveSequenceRef.current;
        pendingSourceRef.current = request.source;
        pendingSaveIdRef.current = saveId;
        if (latestHighFidelityResultRef.current?.source === request.source) {
          completeSave(latestHighFidelityResultRef.current, saveId);
          return;
        }
        setSaving(true);
        setStatus("正在实时写入…");
        iframeRef.current?.blur();
        postAction(createDrawioStatusAction(true));
        postAction(request.action);
        clearExportTimer();
        exportTimerRef.current = setTimeout(() => {
          exportTimerRef.current = null;
          void fallbackToLocalRender(request.source, saveId);
        }, DRAWIO_EXPORT_TIMEOUT_MS);
      } catch {
        queuedSourceRef.current = rawSource;
        queuedForceRef.current = true;
        scheduleRetry(rawSource);
        setStatus("更改将在后台继续同步");
      }
    };
    const queueSave = (rawSource: string, immediate: boolean) => {
      queuedSourceRef.current = rawSource;
      queuedForceRef.current = false;
      clearAutosaveTimer();
      if (immediate) {
        startQueuedSave();
        return;
      }
      autosaveTimerRef.current = setTimeout(() => {
        autosaveTimerRef.current = null;
        startQueuedSave();
      }, DRAWIO_AUTOSAVE_DEBOUNCE_MS);
      setStatus("更改待实时写入…");
    };
    const requestClose = () => {
      if (settledRef.current) return;
      closeRequestedRef.current = true;
      clearAutosaveTimer();
      if (queuedSourceRef.current !== null) {
        setStatus("正在落定最后更改…");
        startQueuedSave();
      } else if (pendingSaveIdRef.current === null) {
        finish(latestResultRef.current);
      } else {
        setStatus("正在落定最后更改…");
      }
    };
    requestCloseRef.current = requestClose;

    const onMessage = (event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow || event.origin !== expectedOrigin) return;
      const message = parseDrawioEmbedMessage(event.data);
      if (!message) return;

      if (message.event === "init") {
        try {
          configureDrawioEmbedButtons(iframeRef.current);
          postAction(createDrawioLoadAction(source, title));
          setStatus("离线编辑器已就绪");
          iframeRef.current?.focus();
        } catch {
          setStatus("编辑器暂未就绪");
          setFrameReady(true);
        }
        return;
      }
      if (message.event === "load") {
        configureDrawioEmbedButtons(iframeRef.current);
        setStatus("图表已加载，所有更改将实时写入");
        setFrameReady(true);
        return;
      }
      if (message.event === "autosave") {
        queueSave(message.xml, false);
        return;
      }
      if (message.event === "save") {
        if (message.exit === true) closeRequestedRef.current = true;
        queueSave(message.xml, true);
        return;
      }
      if (message.event === "export") {
        const pendingSource = pendingSourceRef.current;
        const saveId = pendingSaveIdRef.current;
        // v31 的 snapshot export 不回显 message/nonce，只在可信 iframe 的 pending
        // 窗口内接收；origin 与 event.source 校验仍是第一道边界。
        if (!pendingSource || saveId === null) return;
        try {
          const result = finalizeDrawioEdit(pendingSource, message.data);
          latestHighFidelityResultRef.current = result;
          completeSave(result, saveId);
        } catch (exportError) {
          clearExportTimer();
          void fallbackToLocalRender(
            pendingSource,
            saveId,
            `drawio 原生 SVG 不可用：${errorMessage(exportError)}`,
          );
        }
        return;
      }
      if (message.event === "exit") requestClose();
      // openLink 在 suppressNewWindows + 离线模式下故意不转交系统浏览器。
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      requestClose();
    };

    window.addEventListener("message", onMessage);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      clearExportTimer();
      clearAutosaveTimer();
      clearRetryTimer();
      requestCloseRef.current = () => undefined;
      window.removeEventListener("message", onMessage);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, onSave, source, title]);

  return (
    <div className="drawio-editor-overlay diagram-editor-chrome" role="dialog" aria-modal="true" aria-label="Drawio 编辑">
      <header className="drawio-editor-overlay__topbar diagram-editor-chrome__topbar">
        <div className="drawio-editor-overlay__heading">
          <strong className="diagram-editor-chrome__title">Drawio 编辑</strong>
          <span role="status">{status}</span>
        </div>
        {/* 实时保存语义:✕ = flush 最后一笔后关闭(requestClose),不是丢弃 */}
        <button
          type="button"
          className="drawio-editor-overlay__cancel diagram-editor-chrome__close"
          aria-label="关闭"
          title="关闭"
          onClick={() => requestCloseRef.current()}
        >
          ✕
        </button>
      </header>
      <div className="drawio-editor-overlay__stage">
        <iframe
          ref={iframeRef}
          className={`drawio-editor-overlay__frame${saving ? " is-saving" : ""}`}
          title="drawio 离线图表编辑器"
          src={DRAWIO_EMBED_PATH}
          sandbox="allow-scripts allow-same-origin"
          allow="clipboard-read; clipboard-write"
          referrerPolicy="no-referrer"
          onLoad={(event) => {
            setFrameReady(false);
            configureDrawioEmbedButtons(event.currentTarget);
            setStatus("正在等待编辑器初始化…");
          }}
        />
        {!frameReady && (
          <div className="drawio-editor-overlay__boot" role="status">
            <span className="drawio-editor-overlay__spinner" aria-hidden="true" />
            <span>正在启动离线编辑器…</span>
          </div>
        )}
      </div>
    </div>
  );
}

const DRAWIO_EMBED_STYLE_ID = "qingagent-drawio-embed-fixes";

function configureDrawioEmbedButtons(iframe: HTMLIFrameElement | null): void {
  try {
    const frameDocument = iframe?.contentDocument;
    if (!frameDocument?.head) return;
    if (!frameDocument.getElementById(DRAWIO_EMBED_STYLE_ID)) {
      const style = frameDocument.createElement("style");
      style.id = DRAWIO_EMBED_STYLE_ID;
      style.textContent = [
        "/* 实时写回后只保留退出入口；offline=1 的 display:none 由宿主精确覆盖。 */",
        ".geToolbarContainer > .geButtonContainer { display: inline-flex !important; }",
        ".geToolbarContainer > .geButtonContainer > :not(:last-child) { display: none !important; }",
      ].join("\n");
      frameDocument.head.appendChild(style);
    }
    frameDocument
      .querySelectorAll<HTMLElement>(".geToolbarContainer > .geButtonContainer")
      .forEach((container) => {
        container.style.setProperty("display", "inline-flex", "important");
        const buttons = Array.from(container.children) as HTMLElement[];
        buttons.slice(0, -1).forEach((button) => {
          button.style.setProperty("display", "none", "important");
        });
        const completeButton = buttons.at(-1);
        if (completeButton) {
          completeButton.style.removeProperty("display");
          completeButton.textContent = "完成";
          completeButton.setAttribute("aria-label", "完成");
        }
      });
  } catch {
    // iframe 尚未切到同源文档时等待下一次 load/init，不放宽消息来源校验。
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}
