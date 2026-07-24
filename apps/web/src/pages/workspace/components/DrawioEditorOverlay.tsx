import { useEffect, useRef, useState } from "react";
import {
  DRAWIO_EMBED_PATH,
  DRAWIO_EXPORT_TIMEOUT_MS,
  DRAWIO_FALLBACK_TIMEOUT_MS,
  createDrawioExportAction,
  createDrawioLoadAction,
  encodeDrawioAction,
  finalizeDrawioEdit,
  isDrawioExportMessage,
  parseDrawioEmbedMessage,
  type DrawioEditorResult,
} from "./drawioEmbedProtocol";
import { renderDrawio } from "./drawioRender";
import "./DrawioEditorOverlay.css";

export interface DrawioEditorOverlayProps {
  source: string;
  title?: string;
  onClose: (result: DrawioEditorResult | null) => void;
}

export function DrawioEditorOverlay({
  source,
  title = "drawio 可视化编辑",
  onClose,
}: DrawioEditorOverlayProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const settledRef = useRef(false);
  const pendingSourceRef = useRef<string | null>(null);
  const exportNonceRef = useRef<string | null>(null);
  const exportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState("正在启动离线编辑器…");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    const expectedOrigin = window.location.origin;
    const postAction = (action: ReturnType<typeof createDrawioLoadAction> | ReturnType<typeof createDrawioExportAction>) => {
      iframeRef.current?.contentWindow?.postMessage(encodeDrawioAction(action), expectedOrigin);
    };
    const clearExportTimer = () => {
      if (exportTimerRef.current === null) return;
      clearTimeout(exportTimerRef.current);
      exportTimerRef.current = null;
    };
    const finish = (result: DrawioEditorResult | null) => {
      if (settledRef.current) return;
      settledRef.current = true;
      clearExportTimer();
      onClose(result);
    };
    const fallbackToLocalRender = async (
      fallbackSource: string,
      fallbackNonce: string,
      reason = "drawio 原生 SVG 导出超时",
    ) => {
      if (
        settledRef.current ||
        pendingSourceRef.current !== fallbackSource ||
        exportNonceRef.current !== fallbackNonce
      ) {
        return;
      }
      setStatus(`${reason}，正在使用本地渲染…`);
      setError(null);
      try {
        const svg = await withTimeout(
          renderDrawio(fallbackSource),
          DRAWIO_FALLBACK_TIMEOUT_MS,
          "maxGraph 本地渲染超时",
        );
        if (
          settledRef.current ||
          pendingSourceRef.current !== fallbackSource ||
          exportNonceRef.current !== fallbackNonce
        ) {
          return;
        }
        pendingSourceRef.current = null;
        exportNonceRef.current = null;
        finish({
          source: fallbackSource,
          svg,
          warning: `${reason}，已改用本地渲染保存`,
        });
      } catch (fallbackError) {
        if (
          settledRef.current ||
          pendingSourceRef.current !== fallbackSource ||
          exportNonceRef.current !== fallbackNonce
        ) {
          return;
        }
        pendingSourceRef.current = null;
        exportNonceRef.current = null;
        finish({
          source: fallbackSource,
          svg: null,
          warning: `drawio SVG 缓存生成失败，已保存可继续编辑的源码：${errorMessage(fallbackError)}`,
        });
      }
    };
    const onMessage = (event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow || event.origin !== expectedOrigin) return;
      const message = parseDrawioEmbedMessage(event.data);
      if (!message) return;

      if (message.event === "init") {
        try {
          postAction(createDrawioLoadAction(source, title));
          setStatus("离线编辑器已就绪");
          setError(null);
          iframeRef.current?.focus();
        } catch (loadError) {
          setError(errorMessage(loadError));
        }
        return;
      }
      if (message.event === "load") {
        setStatus("图表已加载");
        return;
      }
      if (message.event === "save") {
        try {
          const exportNonce = crypto.randomUUID();
          const exportAction = createDrawioExportAction(message.xml, exportNonce);
          pendingSourceRef.current = exportAction.xml;
          exportNonceRef.current = exportNonce;
          setStatus("正在生成安全 SVG 缓存…");
          setError(null);
          postAction(exportAction);
          clearExportTimer();
          exportTimerRef.current = setTimeout(() => {
            exportTimerRef.current = null;
            void fallbackToLocalRender(exportAction.xml, exportNonce);
          }, DRAWIO_EXPORT_TIMEOUT_MS);
        } catch (saveError) {
          setError(errorMessage(saveError));
        }
        return;
      }
      if (message.event === "export") {
        const pendingSource = pendingSourceRef.current;
        const exportNonce = exportNonceRef.current;
        if (!pendingSource || !exportNonce || !isDrawioExportMessage(message.message, exportNonce)) return;
        try {
          const result = finalizeDrawioEdit(pendingSource, message.data);
          clearExportTimer();
          pendingSourceRef.current = null;
          exportNonceRef.current = null;
          setStatus("保存完成");
          finish(result);
        } catch (exportError) {
          clearExportTimer();
          void fallbackToLocalRender(
            pendingSource,
            exportNonce,
            `drawio 原生 SVG 不可用：${errorMessage(exportError)}`,
          );
        }
        return;
      }
      // saveAndExit 的 save 与 exit 可能相邻到达；已经开始导出时必须等 SVG
      // 加固完成，不能让 exit 抢先把一次有效保存当成取消。
      if (message.event === "exit" && pendingSourceRef.current === null) finish(null);
      // openLink 在 suppressNewWindows + 离线模式下故意不转交系统浏览器。
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      finish(null);
    };

    window.addEventListener("message", onMessage);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      clearExportTimer();
      window.removeEventListener("message", onMessage);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, source, title]);

  const cancel = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    if (exportTimerRef.current !== null) {
      clearTimeout(exportTimerRef.current);
      exportTimerRef.current = null;
    }
    pendingSourceRef.current = null;
    exportNonceRef.current = null;
    onClose(null);
  };

  return (
    <div className="drawio-editor-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <header className="drawio-editor-overlay__topbar">
        <div className="drawio-editor-overlay__heading">
          <strong>{title}</strong>
          <span className={error ? "is-error" : undefined} role={error ? "alert" : "status"}>
            {error ?? status}
          </span>
        </div>
        <button type="button" className="drawio-editor-overlay__cancel" onClick={cancel}>
          取消
        </button>
      </header>
      <iframe
        ref={iframeRef}
        className="drawio-editor-overlay__frame"
        title="drawio 离线图表编辑器"
        src={DRAWIO_EMBED_PATH}
        sandbox="allow-scripts allow-same-origin"
        allow="clipboard-read; clipboard-write"
        referrerPolicy="no-referrer"
        onLoad={() => setStatus("正在等待编辑器初始化…")}
      />
    </div>
  );
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
