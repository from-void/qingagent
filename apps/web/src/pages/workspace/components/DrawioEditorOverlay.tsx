import { useEffect, useRef, useState } from "react";
import {
  DRAWIO_AUTOSAVE_DEBOUNCE_MS,
  DRAWIO_CLOSE_WATCHDOG_MS,
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
import { useConfirm } from "../../../system/ConfirmProvider";
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
  const confirm = useConfirm();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const settledRef = useRef(false);
  const pendingSourceRef = useRef<string | null>(null);
  const pendingSaveIdRef = useRef<number | null>(null);
  const queuedSourceRef = useRef<string | null>(null);
  const queuedForceRef = useRef(false);
  const closeRequestedRef = useRef(false);
  const latestResultRef = useRef<DrawioEditorResult | null>(null);
  const latestHighFidelityResultRef = useRef<DrawioEditorResult | null>(null);
  const deferredConfirmResultRef = useRef<{
    result: DrawioEditorResult;
    saveId: number;
  } | null>(null);
  const lastWrittenSourceRef = useRef(source);
  const saveSequenceRef = useRef(0);
  const exportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitConfirmPendingRef = useRef(false);
  const requestCloseRef = useRef<() => void>(() => undefined);
  const requestDiscardExitRef = useRef<() => void>(() => undefined);
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
    let active = true;
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
    const clearCloseWatchdog = () => {
      if (closeWatchdogRef.current === null) return;
      clearTimeout(closeWatchdogRef.current);
      closeWatchdogRef.current = null;
    };
    const finish = (result: DrawioEditorResult | null) => {
      if (settledRef.current) return;
      settledRef.current = true;
      clearExportTimer();
      clearAutosaveTimer();
      clearRetryTimer();
      clearCloseWatchdog();
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
      if (exitConfirmPendingRef.current) {
        clearExportTimer();
        deferredConfirmResultRef.current = { result, saveId };
        return;
      }
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
    /**
     * 关闭永远立即生效：能不能退出与保存状态机彻底解耦。退出前只做一次「尽力而为」的
     * 源码落盘（拿不到原生 SVG 就沿用上一版预览缓存，文档下次打开会自行补渲染），
     * 绝不等待任何 pending 的导出/渲染/写回——等待过的那条路正是 ✕ 点不动的病根。
     */
    const flushSourceBeforeClose = () => {
      const rawSource = queuedSourceRef.current ?? pendingSourceRef.current;
      if (rawSource === null) return;
      queuedSourceRef.current = null;
      pendingSourceRef.current = null;
      try {
        const { source } = createDrawioSnapshotRequest(rawSource);
        if (source === lastWrittenSourceRef.current) return;
        const result: DrawioEditorResult = {
          source,
          svg: latestResultRef.current?.svg ?? null,
          warning: "已保存最新源码，预览缓存将在下次渲染时补全",
        };
        latestResultRef.current = result;
        lastWrittenSourceRef.current = source;
        onSave?.(result);
      } catch {
        // 源码本身非法（或写回抛错）时也不能堵住退出，交由文档保留上一版可用内容。
      }
    };
    const armCloseWatchdog = () => {
      if (closeWatchdogRef.current !== null || settledRef.current) return;
      closeWatchdogRef.current = setTimeout(() => {
        closeWatchdogRef.current = null;
        if (settledRef.current) return;
        flushSourceBeforeClose();
        finish(latestResultRef.current);
      }, DRAWIO_CLOSE_WATCHDOG_MS);
    };
    /**
     * immediate=true 是用户亲手点 ✕ / 按 Esc：任何状态下都必须当场退出，绝不等待。
     * immediate=false 是编辑器自己发的 exit（「完成」按钮）：允许等这一拍原生 SVG 落定，
     * 但由看门狗兜住上限，等不到照样退出。
     */
    const requestClose = (immediate: boolean) => {
      if (settledRef.current) return;
      closeRequestedRef.current = true;
      clearAutosaveTimer();
      if (!immediate && pendingSaveIdRef.current !== null) {
        armCloseWatchdog();
        setStatus("正在落定最后更改…");
        return;
      }
      clearRetryTimer();
      clearExportTimer();
      flushSourceBeforeClose();
      finish(latestResultRef.current);
    };
    const requestDiscardExit = () => {
      if (settledRef.current || exitConfirmPendingRef.current) return;
      // 「完成」已经用 save(exit=true)明确选择保存；其后紧邻的 vendor exit 只是收尾事件。
      if (closeRequestedRef.current) {
        requestClose(false);
        return;
      }
      const hasUnsavedChanges = queuedSourceRef.current !== null || pendingSourceRef.current !== null;
      if (!hasUnsavedChanges) {
        requestClose(false);
        return;
      }
      exitConfirmPendingRef.current = true;
      // 确认卡停留多久都不能让防抖/导出在背后偷偷完成写回。
      clearAutosaveTimer();
      void confirm({
        title: "放弃本次修改？",
        message: "尚未保存的修改将会丢失。",
        confirmLabel: "放弃修改",
        cancelLabel: "继续编辑",
      }).then((discard) => {
        exitConfirmPendingRef.current = false;
        if (!active || settledRef.current) return;
        if (!discard) {
          const deferred = deferredConfirmResultRef.current;
          deferredConfirmResultRef.current = null;
          if (deferred) {
            completeSave(deferred.result, deferred.saveId);
          } else if (pendingSaveIdRef.current === null && queuedSourceRef.current !== null) {
            queueSave(queuedSourceRef.current, false);
          }
          iframeRef.current?.focus();
          return;
        }
        // 纯退出只丢弃尚未完成写回的这一版；已经成功写回的版本不回滚。
        clearAutosaveTimer();
        clearRetryTimer();
        clearExportTimer();
        queuedSourceRef.current = null;
        queuedForceRef.current = false;
        deferredConfirmResultRef.current = null;
        clearPendingSave();
        finish(null);
      });
    };
    requestDiscardExitRef.current = requestDiscardExit;
    requestCloseRef.current = () => requestClose(true);

    const onMessage = (event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow || event.origin !== expectedOrigin) return;
      const message = parseDrawioEmbedMessage(event.data);
      if (!message) return;

      if (message.event === "init") {
        try {
          configureDrawioEmbedButtons(
            iframeRef.current,
            () => requestDiscardExitRef.current(),
          );
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
        configureDrawioEmbedButtons(
          iframeRef.current,
          () => requestDiscardExitRef.current(),
        );
        setStatus("图表已加载，所有更改将实时写入");
        setFrameReady(true);
        return;
      }
      if (message.event === "autosave") {
        queueSave(message.xml, false);
        return;
      }
      if (message.event === "save") {
        // 「完成」走的是带 exit 的 save：优先等这一拍原生 SVG 落定，但绝不无限期等——
        // 看门狗到点就按 ✕ 的同一套语义强制退出。
        if (message.exit === true) {
          closeRequestedRef.current = true;
          armCloseWatchdog();
        }
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
      if (message.event === "exit") requestDiscardExit();
      // openLink 在 suppressNewWindows + 离线模式下故意不转交系统浏览器。
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      requestClose(true);
    };

    window.addEventListener("message", onMessage);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      active = false;
      clearExportTimer();
      clearAutosaveTimer();
      clearRetryTimer();
      clearCloseWatchdog();
      requestCloseRef.current = () => undefined;
      requestDiscardExitRef.current = () => undefined;
      window.removeEventListener("message", onMessage);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [confirm, onClose, onSave, source, title]);

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
            configureDrawioEmbedButtons(
              event.currentTarget,
              () => requestDiscardExitRef.current(),
            );
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
const DRAWIO_EXIT_CAPTURE_ATTRIBUTE = "data-qingagent-drawio-exit-capture";
const drawioExitHandlers = new WeakMap<HTMLElement, () => void>();

function configureDrawioEmbedButtons(
  iframe: HTMLIFrameElement | null,
  onExit?: () => void,
): void {
  try {
    const frameDocument = iframe?.contentDocument;
    if (!frameDocument?.head) return;
    if (!frameDocument.getElementById(DRAWIO_EMBED_STYLE_ID)) {
      const style = frameDocument.createElement("style");
      style.id = DRAWIO_EMBED_STYLE_ID;
      style.textContent = [
        "/* offline=1 会隐藏按钮容器；宿主显式恢复原生的完成 / 退出出口。 */",
        ".geButtonContainer { display: inline-flex !important; }",
      ].join("\n");
      frameDocument.head.appendChild(style);
    }
    frameDocument
      .querySelectorAll<HTMLElement>(".geButtonContainer")
      .forEach((container) => {
        container.style.setProperty("display", "inline-flex", "important");
        const buttons = Array.from(container.children) as HTMLElement[];
        const completeButton = buttons.find((button) =>
          button.textContent?.trim() === "完成" ||
          button.textContent?.trim() === "保存并退出" ||
          button.title.startsWith("保存并退出")
        );
        if (completeButton) {
          completeButton.textContent = "完成";
          completeButton.setAttribute("aria-label", "完成");
        }
        let exitButton = buttons.find((button) =>
          button.textContent?.trim() === "退出" || button.title === "退出"
        );
        if (exitButton && onExit) {
          if (!exitButton.hasAttribute(DRAWIO_EXIT_CAPTURE_ATTRIBUTE)) {
            // clone 会剥掉 vendor 已挂的 click listener，纯退出从此只走宿主确认卡。
            const capturedExitButton = exitButton.cloneNode(true) as HTMLElement;
            exitButton.replaceWith(capturedExitButton);
            exitButton = capturedExitButton;
            exitButton.setAttribute(DRAWIO_EXIT_CAPTURE_ATTRIBUTE, "true");
            exitButton.addEventListener("click", handleDrawioExitClick);
          }
          drawioExitHandlers.set(exitButton, onExit);
        }
      });
  } catch {
    // iframe 尚未切到同源文档时等待下一次 load/init，不放宽消息来源校验。
  }
}

function handleDrawioExitClick(event: MouseEvent): void {
  const button = event.currentTarget as HTMLElement | null;
  if (!button) return;
  const onExit = drawioExitHandlers.get(button);
  if (!onExit) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  // 点击工具栏会先让正在编辑的节点失焦并提交；autosave 通过 postMessage 异步到宿主。
  // 延后一拍判断 dirty，避免同步回调抢在这条 autosave 前面把会话误判为“无改动”。
  const frameWindow = button.ownerDocument.defaultView;
  if (frameWindow) {
    frameWindow.setTimeout(onExit, 0);
  } else {
    onExit();
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
