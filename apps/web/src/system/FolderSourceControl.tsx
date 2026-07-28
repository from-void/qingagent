import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import "./folder-control.css";
import type {
  ClientCapabilities,
  FolderSourceProvider,
  FolderSourceStatus,
} from "@qingagent/contract-ts";

export const FOLDER_INTRO_STORAGE_KEY = "qingagent:folder-source-intro-dismissed";
const FOLDER_PROMPT_EXIT_MS = 240;

/**
 * 引导/确认弹框 portal 到所在页面根容器(#view-workspace / #view-home),而不是留在输入框内部渲染。
 * 输入栏用了 backdrop-filter/transform,会成为 position:fixed 的包含块,导致弹框只在输入栏范围内
 * "居中"、像是浮在按钮上方且没有全屏蒙层。页面根容器没有这类属性,portal 到它之后 fixed 相对视口,
 * 蒙层铺满整屏、弹框真正居中;且 #view-workspace 作用域的样式仍然命中(弹框仍是其后代)。
 * 从按钮节点向上 closest 找容器:测试环境没有页面容器时回退为就地渲染,保证现有按 host 查询的测试不破。
 */
function maybePortalFolderModal(node: ReactNode, anchor: HTMLElement | null): ReactNode {
  const host = anchor?.closest<HTMLElement>("#view-workspace, #view-home") ?? null;
  return host ? createPortal(node, host) : node;
}

interface FolderPromptDialogProps {
  anchor: HTMLElement | null;
  dataWf: string;
  titleId: string;
  modalClassName: string;
  onCancel: () => void;
  children: ReactNode | ((controls: FolderPromptDialogControls) => ReactNode);
  cancelDisabled?: boolean;
  closeOnOverlay?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
}

export interface FolderPromptDialogControls {
  close: (afterClose?: () => void, options?: { force?: boolean }) => void;
}

export function FolderPromptDialog({
  anchor,
  dataWf,
  titleId,
  modalClassName,
  onCancel,
  children,
  cancelDisabled = false,
  closeOnOverlay = true,
  initialFocusRef,
}: FolderPromptDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const closeFrameRef = useRef<number | null>(null);
  const [isExiting, setIsExiting] = useState(false);

  const requestClose = useCallback((afterClose?: () => void, options?: { force?: boolean }) => {
    if ((!options?.force && cancelDisabled) || isExiting) return;
    const finish = () => {
      closeTimerRef.current = null;
      if (afterClose) {
        afterClose();
        return;
      }
      onCancel();
    };
    const exitDuration = getFolderPromptExitDurationMs();
    if (exitDuration <= 0) {
      finish();
      return;
    }
    setIsExiting(true);
    closeFrameRef.current = window.requestAnimationFrame(() => {
      closeFrameRef.current = null;
      closeTimerRef.current = window.setTimeout(finish, exitDuration);
    });
  }, [cancelDisabled, isExiting, onCancel]);

  const handleOverlayClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (closeOnOverlay && event.target === event.currentTarget) requestClose();
  }, [closeOnOverlay, requestClose]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        requestClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = getFocusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || !dialog.contains(active)) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (active === last || !dialog.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [requestClose]);

  useEffect(() => {
    return () => {
      if (closeFrameRef.current !== null) window.cancelAnimationFrame(closeFrameRef.current);
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    };
  }, []);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    return isolateDialogSiblings(dialog);
  }, []);

  useEffect(() => {
    initialFocusRef?.current?.focus();
  }, [initialFocusRef]);

  const renderedChildren = typeof children === "function"
    ? children({ close: requestClose })
    : children;
  const exitDuration = getFolderPromptExitDurationMs();

  return maybePortalFolderModal(
    <div
      ref={dialogRef}
      className={`ws-folder-modal-overlay${isExiting ? " is-exiting" : ""}`}
      data-phase={isExiting ? "exiting" : "open"}
      data-exit-duration-ms={exitDuration}
      data-wf={dataWf}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={handleOverlayClick}
      tabIndex={-1}
    >
      <div className={modalClassName} onClick={(event) => event.stopPropagation()}>
        {renderedChildren}
      </div>
    </div>,
    anchor,
  );
}

export interface FolderCapability {
  enabled: boolean;
  reason: string | null;
}

export interface FolderSourceControlSource {
  id: string;
  provider: FolderSourceProvider;
  name: string;
  pathLabel: string | null;
  mountPath: string;
  fileCount: number | null;
  fileCountCapped: boolean;
  status: FolderSourceStatus;
  error: string | null;
}

export interface FolderCapabilityEnv {
  isServer?: boolean;
  isDesktop?: boolean;
  hasDesktopPicker?: boolean;
  hasDirectoryPicker?: boolean;
  isSecureContext?: boolean;
  userAgent?: string;
  maxTouchPoints?: number;
  serverDesktopFolderSourcesEnabled?: boolean | null;
  serverBrowserFolderSourcesEnabled?: boolean | null;
}

export type FolderSourceActionKind = "attach" | "detach";
export type FolderSourceDialogKind = "intro" | "disconnectConfirm";

export interface FolderIntroDialogActionProps {
  dismissChecked: boolean;
  onDismissCheckedChange: (checked: boolean) => void;
  onCancel: () => void;
  onConfirm: (closeDialog: FolderPromptDialogControls["close"]) => void;
}

export interface FolderDisconnectDialogActionProps {
  folderName: string;
  detachPending: boolean;
  onCancel: () => void;
  onConfirm: (closeDialog?: FolderPromptDialogControls["close"]) => void;
}

export interface UseFolderSourceActionsOptions {
  folderSource: FolderSourceControlSource | null;
  folderCapability: FolderCapability;
  onAttachFolder: () => Promise<void>;
  onDetachFolder?: (folderId: string) => Promise<void>;
  disabled?: boolean;
  connectedBehavior?: "confirm-detach" | "attach";
  restoreFocusRef?: RefObject<HTMLElement | null>;
  onAttachSuccess?: () => void;
}

export interface UseFolderSourceActionsResult {
  folderDialog: FolderSourceDialogKind | null;
  folderActionPending: FolderSourceActionKind | null;
  folderNeedsBrowserPermission: boolean;
  requestPrimaryAction: () => void;
  requestAttach: () => void;
  requestDetach: () => void;
  confirmDetach: (closeDialog?: FolderPromptDialogControls["close"]) => void;
  cancelDialog: () => void;
  introDialogProps: FolderIntroDialogActionProps;
  disconnectDialogProps: FolderDisconnectDialogActionProps | null;
}

export function useFolderSourceActions({
  folderSource,
  folderCapability,
  onAttachFolder,
  onDetachFolder,
  disabled = false,
  connectedBehavior = "confirm-detach",
  restoreFocusRef,
  onAttachSuccess,
}: UseFolderSourceActionsOptions): UseFolderSourceActionsResult {
  const folderActionInFlightRef = useRef<FolderSourceActionKind | null>(null);
  const restoreFolderButtonFocusRef = useRef(false);
  const [folderDialog, setFolderDialog] = useState<FolderSourceDialogKind | null>(null);
  const [folderIntroDismissChecked, setFolderIntroDismissChecked] = useState(false);
  const [folderActionPending, setFolderActionPending] = useState<FolderSourceActionKind | null>(null);
  const folderNeedsBrowserPermission =
    folderSource?.provider === "browser-fs-access" &&
    folderSource.status === "permission_required";

  const closeFolderDialog = useCallback(() => {
    restoreFolderButtonFocusRef.current = true;
    setFolderDialog(null);
  }, []);

  const startAttachFolder = useCallback(async () => {
    if (!folderCapability.enabled || folderActionInFlightRef.current !== null) return;
    folderActionInFlightRef.current = "attach";
    setFolderActionPending("attach");
    try {
      await onAttachFolder();
      onAttachSuccess?.();
      restoreFocusRef?.current?.blur();
    } catch (error) {
      console.error("[FolderSourceControl] attach folder failed", error);
    } finally {
      folderActionInFlightRef.current = null;
      setFolderActionPending(null);
    }
  }, [folderCapability.enabled, onAttachFolder, onAttachSuccess, restoreFocusRef]);

  const canRequestAttach = useCallback(() => {
    return !disabled &&
      folderDialog === null &&
      folderActionInFlightRef.current === null &&
      folderCapability.enabled;
  }, [disabled, folderCapability.enabled, folderDialog]);

  const requestAttachFlow = useCallback(() => {
    if (folderSource && folderNeedsBrowserPermission) {
      void startAttachFolder();
      return;
    }
    if (readFolderIntroDismissed()) {
      void startAttachFolder();
      return;
    }
    setFolderIntroDismissChecked(false);
    setFolderDialog("intro");
  }, [folderNeedsBrowserPermission, folderSource, startAttachFolder]);

  const requestAttach = useCallback(() => {
    if (!canRequestAttach()) return;
    requestAttachFlow();
  }, [canRequestAttach, requestAttachFlow]);

  const requestDetach = useCallback(() => {
    if (!folderSource || folderDialog !== null || folderActionInFlightRef.current !== null) return;
    setFolderDialog("disconnectConfirm");
  }, [folderDialog, folderSource]);

  const requestPrimaryAction = useCallback(() => {
    if (!canRequestAttach()) return;
    if (
      folderSource &&
      !folderNeedsBrowserPermission &&
      connectedBehavior === "confirm-detach"
    ) {
      setFolderDialog("disconnectConfirm");
      return;
    }
    requestAttachFlow();
  }, [
    canRequestAttach,
    connectedBehavior,
    folderNeedsBrowserPermission,
    folderSource,
    requestAttachFlow,
  ]);

  const handleIntroCancel = useCallback(() => {
    closeFolderDialog();
    setFolderIntroDismissChecked(false);
  }, [closeFolderDialog]);

  const handleDisconnectCancel = useCallback(() => {
    if (folderActionInFlightRef.current === "detach") return;
    closeFolderDialog();
  }, [closeFolderDialog]);

  const handleConfirmIntro = useCallback((closeDialog: FolderPromptDialogControls["close"]) => {
    if (folderIntroDismissChecked) writeFolderIntroDismissed();
    closeDialog(() => {
      closeFolderDialog();
      void startAttachFolder();
    });
  }, [closeFolderDialog, folderIntroDismissChecked, startAttachFolder]);

  const confirmDetach = useCallback((closeDialog?: FolderPromptDialogControls["close"]) => {
    if (!folderSource || !onDetachFolder || folderActionInFlightRef.current !== null) return;
    folderActionInFlightRef.current = "detach";
    setFolderActionPending("detach");
    void (async () => {
      try {
        await onDetachFolder(folderSource.id);
        // 断联成功后 folderSource 立即变 null,确认弹窗会被瞬时卸载;若只依赖动画版 close 回调来复位
        // folderDialog,回调常来不及跑 → folderDialog 卡在 "disconnectConfirm",后续点「文件夹」被
        // handleFolderButton 的 `folderDialog !== null` 拦死(表现:断连后重连点按钮没反应)。
        // 这里直接同步复位,保证不卡。closeDialog 参数仅用于动画收尾,卸载已自动清理,可不依赖。
        void closeDialog;
        closeFolderDialog();
      } catch (error) {
        console.error("[FolderSourceControl] detach folder failed", error);
      } finally {
        folderActionInFlightRef.current = null;
        setFolderActionPending(null);
      }
    })();
  }, [closeFolderDialog, folderSource, onDetachFolder]);

  const cancelDialog = useCallback(() => {
    if (folderDialog === "disconnectConfirm") {
      handleDisconnectCancel();
      return;
    }
    handleIntroCancel();
  }, [folderDialog, handleDisconnectCancel, handleIntroCancel]);

  useEffect(() => {
    if (folderDialog !== null || folderActionPending !== null || !restoreFolderButtonFocusRef.current) return;
    restoreFolderButtonFocusRef.current = false;
    restoreFocusRef?.current?.focus();
  }, [folderActionPending, folderDialog, restoreFocusRef]);

  return {
    folderDialog,
    folderActionPending,
    folderNeedsBrowserPermission,
    requestPrimaryAction,
    requestAttach,
    requestDetach,
    confirmDetach,
    cancelDialog,
    introDialogProps: {
      dismissChecked: folderIntroDismissChecked,
      onDismissCheckedChange: setFolderIntroDismissChecked,
      onCancel: handleIntroCancel,
      onConfirm: handleConfirmIntro,
    },
    disconnectDialogProps: folderSource
      ? {
        folderName: folderSource.name,
        detachPending: folderActionPending === "detach",
        onCancel: handleDisconnectCancel,
        onConfirm: confirmDetach,
      }
      : null,
  };
}

export interface FolderIntroDialogProps extends FolderIntroDialogActionProps {
  anchor: HTMLElement | null;
  dataWf: string;
  titleId: string;
  initialFocusRef?: RefObject<HTMLButtonElement>;
}

export function FolderIntroDialog({
  anchor,
  dataWf,
  titleId,
  initialFocusRef,
  dismissChecked,
  onDismissCheckedChange,
  onCancel,
  onConfirm,
}: FolderIntroDialogProps) {
  return (
    <FolderPromptDialog
      anchor={anchor}
      dataWf={dataWf}
      titleId={titleId}
      modalClassName="ws-folder-intro-modal"
      onCancel={onCancel}
      initialFocusRef={initialFocusRef}
    >
      {({ close }) => (
        <>
          <div className="ws-folder-modal-icon" aria-hidden="true">
            <FolderSvg width={22} height={22} />
          </div>
          <h3 id={titleId}>连接本地文件夹作为资料库</h3>
          <p>连接后，青简能浏览、检索、读取这个文件夹里的文件，作为写作的依据。</p>
          <div className="ws-folder-intro-point"><span>·</span><p>文件<b>始终留在你的电脑上</b>，不会被上传或保存副本。</p></div>
          <div className="ws-folder-intro-point"><span>·</span><p>只有青简实际读到的文件才会被即时解析。</p></div>
          <div className="ws-folder-intro-point"><span>·</span><p>文件夹里的增删改，青简下次都能读到最新。</p></div>
          <div className="ws-folder-modal-foot">
            <label className="ws-folder-check">
              <input
                className="wf-checkbox"
                type="checkbox"
                checked={dismissChecked}
                onChange={(event) => onDismissCheckedChange(event.target.checked)}
              />
              <span>不再显示此提示</span>
            </label>
            <button
              ref={initialFocusRef}
              type="button"
              className="ws-folder-modal-primary"
              onClick={() => onConfirm(close)}
            >
              我知道了，选择文件夹
            </button>
            <button type="button" className="ws-folder-modal-secondary" onClick={() => close()}>
              取消
            </button>
          </div>
        </>
      )}
    </FolderPromptDialog>
  );
}

export interface FolderDisconnectDialogProps extends FolderDisconnectDialogActionProps {
  anchor: HTMLElement | null;
  dataWf: string;
  titleId: string;
  initialFocusRef?: RefObject<HTMLButtonElement>;
}

export function FolderDisconnectDialog({
  anchor,
  dataWf,
  titleId,
  initialFocusRef,
  folderName,
  detachPending,
  onCancel,
  onConfirm,
}: FolderDisconnectDialogProps) {
  return (
    <FolderPromptDialog
      anchor={anchor}
      dataWf={dataWf}
      titleId={titleId}
      modalClassName="ws-folder-confirm-modal"
      onCancel={onCancel}
      cancelDisabled={detachPending}
      closeOnOverlay={false}
      initialFocusRef={initialFocusRef}
    >
      {({ close }) => (
        <>
          <h3 id={titleId}>断开「{folderName}」连接？</h3>
          <p>断开后青简将无法再读取这个文件夹里的文件。</p>
          <p><b>文件不会被删除</b>，仍在你的电脑上，随时可重新连接。</p>
          <div className="ws-folder-confirm-actions">
            <button
              type="button"
              className="ws-folder-modal-danger"
              onClick={() => onConfirm(close)}
              disabled={detachPending}
            >
              断开连接
            </button>
            <button
              type="button"
              className="ws-folder-modal-secondary"
              ref={initialFocusRef}
              onClick={() => close()}
              disabled={detachPending}
            >
              取消
            </button>
          </div>
        </>
      )}
    </FolderPromptDialog>
  );
}

export function deriveFolderCapability(capabilities: ClientCapabilities | null = null): FolderCapability {
  if (typeof window === "undefined") {
    return deriveFolderCapabilityFromEnv({ isServer: true });
  }
  return deriveFolderCapabilityFromEnv({
    isDesktop: window.electron?.isDesktop === true,
    hasDesktopPicker: typeof window.electron?.selectFolderSource === "function",
    hasDirectoryPicker: typeof window.showDirectoryPicker === "function",
    isSecureContext: window.isSecureContext === true,
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    serverDesktopFolderSourcesEnabled: capabilities?.folderSources.desktopLocal.enabled ?? null,
    serverBrowserFolderSourcesEnabled: capabilities?.folderSources.browserFsAccess.enabled ?? null,
  });
}

export function deriveFolderCapabilityFromEnv(env: FolderCapabilityEnv): FolderCapability {
  if (env.isServer) {
    return { enabled: false, reason: "当前环境暂不支持连接文件夹" };
  }
  if (env.isDesktop) {
    if (env.serverDesktopFolderSourcesEnabled !== true) {
      return { enabled: false, reason: "当前服务端未启用本地文件夹访问" };
    }
    return env.hasDesktopPicker
      ? { enabled: true, reason: null }
      : { enabled: false, reason: "当前桌面端暂不支持连接文件夹，请更新应用" };
  }

  if (env.serverBrowserFolderSourcesEnabled !== true) {
    return { enabled: false, reason: "当前服务端未启用浏览器文件夹访问" };
  }
  const webCapable =
    env.hasDirectoryPicker === true &&
    env.isSecureContext === true &&
    !isLikelyMobileDevice(env.userAgent ?? "", env.maxTouchPoints ?? 0);
  if (webCapable) return { enabled: true, reason: null };
  return { enabled: false, reason: "当前浏览器不支持本地文件夹访问" };
}

export function readFolderIntroDismissed(): boolean {
  try {
    return window.localStorage.getItem(FOLDER_INTRO_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeFolderIntroDismissed(): void {
  try {
    window.localStorage.setItem(FOLDER_INTRO_STORAGE_KEY, "1");
  } catch {
    // localStorage 在隐私模式下可能不可写；失败时只影响下次是否显示提示。
  }
}

function getFolderPromptExitDurationMs(): number {
  try {
    if (typeof navigator !== "undefined" && navigator.userAgent.toLowerCase().includes("jsdom")) return 0;
    return FOLDER_PROMPT_EXIT_MS;
  } catch {
    return FOLDER_PROMPT_EXIT_MS;
  }
}

function getFocusableElements(root: HTMLElement): HTMLElement[] {
  const selector = [
    "button:not([disabled])",
    "input:not([disabled]):not([type='hidden'])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "a[href]",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((element) => {
    if (element.closest("[inert]")) return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

function isolateDialogSiblings(dialog: HTMLElement): () => void {
  const changed: Array<{
    element: HTMLElement;
    inert: boolean;
    inertAttribute: string | null;
    ariaHidden: string | null;
  }> = [];
  let branch: HTMLElement | null = dialog;
  let parent = dialog.parentElement;

  while (branch && parent) {
    for (const sibling of Array.from(parent.children)) {
      if (sibling === branch || !(sibling instanceof HTMLElement)) continue;
      changed.push({
        element: sibling,
        inert: sibling.inert,
        inertAttribute: sibling.getAttribute("inert"),
        ariaHidden: sibling.getAttribute("aria-hidden"),
      });
      sibling.inert = true;
      sibling.setAttribute("inert", "");
      sibling.setAttribute("aria-hidden", "true");
    }
    branch = parent;
    parent = parent.parentElement;
  }

  return () => {
    for (const item of changed.reverse()) {
      item.element.inert = item.inert;
      if (item.inertAttribute === null) {
        item.element.removeAttribute("inert");
      } else {
        item.element.setAttribute("inert", item.inertAttribute);
      }
      if (item.ariaHidden === null) {
        item.element.removeAttribute("aria-hidden");
      } else {
        item.element.setAttribute("aria-hidden", item.ariaHidden);
      }
    }
  };
}

function isLikelyMobileDevice(userAgent: string, touchPoints: number): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent) ||
    (userAgent.includes("Macintosh") && touchPoints > 1);
}

function FolderSvg({
  className,
  width = 14,
  height = 14,
}: {
  className?: string;
  width?: number;
  height?: number;
}) {
  return (
    <svg
      className={className}
      width={width}
      height={height}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.2H19.5A1.5 1.5 0 0 1 21 8.7V17a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17z" />
    </svg>
  );
}
