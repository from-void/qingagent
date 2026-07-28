import { createContext, useCallback, useContext, useRef, useState } from "react";
import type { ReactNode } from "react";
import { FolderPromptDialog } from "./FolderSourceControl";
import { useOverlayDismiss } from "./overlayDismissStack";

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /**
   * danger = 删除类(红色主按钮,默认);affirm = 授予/连接类(金色主按钮)。
   * 授权不是报错,不能用红。
   */
  tone?: "danger" | "affirm";
  /** 标题下的一行主体,如凭证路径;等宽显示。 */
  subject?: string;
  /** 卡底的一行补充说明,如"在设置里随时收回"。 */
  footHint?: string;
}

interface ConfirmRequest extends Required<Pick<ConfirmOptions, "confirmLabel" | "cancelLabel" | "tone">> {
  id: number;
  title: string;
  message: ReactNode;
  subject?: string;
  footHint?: string;
  resolve: (value: boolean) => void;
}

interface ConfirmContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const CONFIRM_CONTEXT_KEY = Symbol.for("qingagent.confirm.context");
const globalConfirmContext = globalThis as typeof globalThis & {
  [CONFIRM_CONTEXT_KEY]?: ReturnType<typeof createContext<ConfirmContextValue | null>>;
};

// Keep one context across duplicated test/HMR module instances.
const ConfirmContext =
  globalConfirmContext[CONFIRM_CONTEXT_KEY] ??
  (globalConfirmContext[CONFIRM_CONTEXT_KEY] = createContext<ConfirmContextValue | null>(null));

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const nextIdRef = useRef(1);
  const requestRef = useRef<ConfirmRequest | null>(null);
  const queueRef = useRef<ConfirmRequest[]>([]);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  const settle = useCallback((value: boolean) => {
    const current = requestRef.current;
    if (!current) return;
    current.resolve(value);
    const next = queueRef.current.shift() ?? null;
    requestRef.current = next;
    setRequest(next);
  }, []);

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      const next: ConfirmRequest = {
        id: nextIdRef.current++,
        title: options.title,
        message: options.message,
        confirmLabel: options.confirmLabel ?? "确认",
        cancelLabel: options.cancelLabel ?? "取消",
        tone: options.tone ?? "danger",
        ...(options.subject ? { subject: options.subject } : {}),
        ...(options.footHint ? { footHint: options.footHint } : {}),
        resolve,
      };
      if (requestRef.current) {
        queueRef.current.push(next);
        return;
      }
      requestRef.current = next;
      setRequest(next);
    });
  }, []);

  // 接进浮层关闭栈:设置面板的 Esc 守卫先问本栈,栈非空就只关最上层浮层。
  // 不接的话,面板守卫的 document 监听先于本弹层注册,Esc 会把确认卡和设置面板一起关掉。
  useOverlayDismiss(request !== null, () => settle(false));

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {request ? (
        <FolderPromptDialog
          key={request.id}
          anchor={getConfirmAnchor()}
          dataWf="GlobalConfirm"
          titleId={`global-confirm-${request.id}`}
          modalClassName={`ws-folder-confirm-modal${request.tone === "affirm" ? " is-affirm" : ""}`}
          onCancel={() => settle(false)}
          closeOnOverlay={false}
          initialFocusRef={cancelRef}
        >
          {({ close }) => (
            <>
              <h3 id={`global-confirm-${request.id}`}>{request.title}</h3>
              {request.subject ? (
                <p className="ws-folder-confirm-subject">{request.subject}</p>
              ) : null}
              <p>{request.message}</p>
              {request.footHint ? (
                <p className="ws-folder-confirm-foot">{request.footHint}</p>
              ) : null}
              <div className="ws-folder-confirm-actions">
                <button
                  type="button"
                  className={
                    request.tone === "affirm"
                      ? "ws-folder-modal-affirm"
                      : "ws-folder-modal-danger"
                  }
                  onClick={() => close(() => settle(true), { force: true })}
                >
                  {request.confirmLabel}
                </button>
                <button
                  type="button"
                  className="ws-folder-modal-secondary"
                  ref={cancelRef}
                  onClick={() => close(() => settle(false), { force: true })}
                >
                  {request.cancelLabel}
                </button>
              </div>
            </>
          )}
        </FolderPromptDialog>
      ) : null}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (ctx) return ctx.confirm;
  return async () => false;
}

function getConfirmAnchor(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return (
    document.querySelector<HTMLElement>("#view-workspace, .ccx-page, #view-home") ??
    document.querySelector<HTMLElement>("[data-view]") ??
    document.getElementById("web-app-shell")
  );
}
