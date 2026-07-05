import { Button, Input, Modal } from "@qingagent/ui-kit";
import { useEffect, useState } from "react";
import { AUTH_REQUIRED_EVENT, cancelAuth, hasPendingAuth, submitAuthToken } from "./authGate";
import { useToast } from "./ToastProvider";

export function AuthTokenGate({ forceOpen = false }: { forceOpen?: boolean } = {}) {
  const toast = useToast();
  // forceOpen:仅供 #/uikit 规范活页把真组件常开陈列(不派发全局 401 事件,
  // 避免弹开 App 级实例);生产挂载不传,行为不变(事件门控)。forceOpen 下也不读写
  // authGate 的 pending 全局状态,避免 demo 抢真实 401。
  const [open, setOpen] = useState(forceOpen);
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (forceOpen) return;

    const onRequired = () => {
      setError(null);
      setOpen(true);
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, onRequired);
    // 补查:首个 401 早于本组件 mount 时,事件已丢,但 pending 仍挂着——mount 即弹卡。
    if (hasPendingAuth()) onRequired();
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onRequired);
  }, [forceOpen]);

  const close = () => {
    if (forceOpen) {
      setOpen(false);
      setToken("");
      setSubmitting(false);
      setError(null);
      return;
    }

    cancelAuth();
    setOpen(false);
    setToken("");
    setSubmitting(false);
    setError(null);
  };

  const submit = async () => {
    const value = token.trim();
    if (!value || submitting) return;
    setSubmitting(true);
    setError(null);
    if (forceOpen) {
      setSubmitting(false);
      setOpen(false);
      setToken("");
      toast.show("演示已解锁");
      return;
    }

    const ok = await submitAuthToken(value);
    setSubmitting(false);
    if (!ok) {
      setError("token 不正确,请重试");
      return;
    }
    setOpen(false);
    setToken("");
    toast.show("已解锁");
  };

  return (
    <Modal open={open} title="需要访问令牌" onClose={close}>
      {open ? (
        <form
          data-wf="AuthTokenGate"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          style={{ display: "grid", gap: 12 }}
        >
          <p style={{ margin: 0, color: "var(--muted, #6f6a60)", lineHeight: 1.5 }}>
            该实例已启用访问保护,请输入 QINGAGENT_AUTH_TOKEN
          </p>
          <Input>
            <input
              aria-label="访问令牌"
              type="password"
              value={token}
              onChange={(event) => setToken(event.currentTarget.value)}
              autoComplete="current-password"
              autoFocus
              style={{
                width: "100%",
                border: 0,
                outline: 0,
                background: "transparent",
                font: "inherit",
              }}
            />
          </Input>
          {error ? (
            <p role="alert" style={{ margin: 0, color: "var(--danger, #b42318)" }}>
              {error}
            </p>
          ) : null}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button type="button" variant="ghost" onClick={close} disabled={submitting}>
              取消
            </Button>
            <Button type="submit" variant="primary" disabled={submitting || !token.trim()}>
              {submitting ? "解锁中" : "解锁"}
            </Button>
          </div>
        </form>
      ) : null}
    </Modal>
  );
}
