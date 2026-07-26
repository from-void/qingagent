import { useEffect, useRef, useState } from "react";
import {
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

export interface DrawioEditorOverlayProps {
  source: string;
  title?: string;
  onSave?: (result: DrawioEditorResult) => void;
  onClose: (result: DrawioEditorResult | null) => void;
}

export function DrawioEditorOverlay({
  source,
  title = "drawio 可视化编辑",
  onSave,
  onClose,
}: DrawioEditorOverlayProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const settledRef = useRef(false);
  const pendingSourceRef = useRef<string | null>(null);
  const pendingSaveIdRef = useRef<number | null>(null);
  const pendingExitRef = useRef(false);
  const latestResultRef = useRef<DrawioEditorResult | null>(null);
  const latestHighFidelityResultRef = useRef<DrawioEditorResult | null>(null);
  const saveSequenceRef = useRef(0);
  const exportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saving, setSaving] = useState(false);
  const [frameReady, setFrameReady] = useState(false);
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
    const finish = (result: DrawioEditorResult | null) => {
      if (settledRef.current) return;
      settledRef.current = true;
      clearExportTimer();
      setSaving(false);
      onClose(result);
    };
    const clearPendingSave = () => {
      pendingSourceRef.current = null;
      pendingSaveIdRef.current = null;
      pendingExitRef.current = false;
    };
    const completeSave = (result: DrawioEditorResult, saveId: number) => {
      if (settledRef.current || pendingSaveIdRef.current !== saveId) return;
      const shouldExit = pendingExitRef.current;
      clearExportTimer();
      clearPendingSave();
      latestResultRef.current = result;
      onSave?.(result);
      if (shouldExit) {
        finish(result);
        return;
      }
      // keepmodified=1 配合保存前显式 status(true)，让 v31 snapshot 能看到脏状态；
      // 保存落盘后再按原生 status action 复位，下一轮真实编辑会重新置脏。
      postAction(createDrawioStatusAction(false));
      setSaving(false);
      setStatus(result.warning ? "保存完成（已使用降级渲染），可继续编辑" : "保存完成，可继续编辑");
      setError(null);
      iframeRef.current?.focus();
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
    const onMessage = (event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow || event.origin !== expectedOrigin) return;
      const message = parseDrawioEmbedMessage(event.data);
      if (!message) return;

      if (message.event === "init") {
        try {
          restoreDrawioEmbedButtons(iframeRef.current);
          postAction(createDrawioLoadAction(source, title));
          setStatus("离线编辑器已就绪");
          setError(null);
          iframeRef.current?.focus();
        } catch (loadError) {
          setError(errorMessage(loadError));
          setFrameReady(true);
        }
        return;
      }
      if (message.event === "load") {
        restoreDrawioEmbedButtons(iframeRef.current);
        setStatus("图表已加载");
        setFrameReady(true);
        return;
      }
      if (message.event === "save") {
        if (pendingSaveIdRef.current !== null) return;
        try {
          const request = createDrawioSnapshotRequest(message.xml);
          const saveId = ++saveSequenceRef.current;
          pendingSourceRef.current = request.source;
          pendingSaveIdRef.current = saveId;
          pendingExitRef.current = message.exit === true;
          if (latestHighFidelityResultRef.current?.source === request.source) {
            completeSave(latestHighFidelityResultRef.current, saveId);
            return;
          }
          setSaving(true);
          setStatus("正在生成安全 SVG 缓存…");
          setError(null);
          iframeRef.current?.blur();
          // v31 的 snapshot 在 modified=false 时会静默不回；先通过原生 status
          // action 强制置脏，导出完成后 completeSave 再按既有流程复位。
          postAction(createDrawioStatusAction(true));
          postAction(request.action);
          clearExportTimer();
          exportTimerRef.current = setTimeout(() => {
            exportTimerRef.current = null;
            void fallbackToLocalRender(request.source, saveId);
          }, DRAWIO_EXPORT_TIMEOUT_MS);
        } catch (saveError) {
          setError(errorMessage(saveError));
          setFrameReady(true);
        }
        return;
      }
      if (message.event === "export") {
        const pendingSource = pendingSourceRef.current;
        const saveId = pendingSaveIdRef.current;
        // v31 的 snapshot export 不回显 message/nonce，只能在可信 iframe 的 pending
        // 保存窗口内接收；origin 与 event.source 校验仍是第一道边界。
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
      // saveAndExit 的 save 与 exit 可能相邻到达；已经开始导出时必须等 SVG
      // 加固完成，不能让 exit 抢先把一次有效保存当成取消。
      if (message.event === "exit") {
        if (pendingSourceRef.current !== null) {
          pendingExitRef.current = true;
        } else {
          finish(latestResultRef.current);
        }
      }
      // openLink 在 suppressNewWindows + 离线模式下故意不转交系统浏览器。
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      finish(latestResultRef.current);
    };

    window.addEventListener("message", onMessage);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      clearExportTimer();
      window.removeEventListener("message", onMessage);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, onSave, source, title]);

  const cancel = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    if (exportTimerRef.current !== null) {
      clearTimeout(exportTimerRef.current);
      exportTimerRef.current = null;
    }
    pendingSourceRef.current = null;
    pendingSaveIdRef.current = null;
    pendingExitRef.current = false;
    onClose(latestResultRef.current);
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
            restoreDrawioEmbedButtons(event.currentTarget);
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

function restoreDrawioEmbedButtons(iframe: HTMLIFrameElement | null): void {
  try {
    const frameDocument = iframe?.contentDocument;
    if (!frameDocument?.head) return;
    if (!frameDocument.getElementById(DRAWIO_EMBED_STYLE_ID)) {
      const style = frameDocument.createElement("style");
      style.id = DRAWIO_EMBED_STYLE_ID;
      style.textContent = [
        "/* offline=1 会让 v31 误把 embed 当 standalone 并写入 display:none。 */",
        ".geToolbarContainer > .geButtonContainer { display: inline-flex !important; }",
      ].join("\n");
      frameDocument.head.appendChild(style);
    }
    frameDocument
      .querySelectorAll<HTMLElement>(".geToolbarContainer > .geButtonContainer")
      .forEach((container) => container.style.setProperty("display", "inline-flex", "important"));
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
