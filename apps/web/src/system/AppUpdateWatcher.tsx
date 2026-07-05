import { Button, Modal } from "@qingagent/ui-kit";
import { useEffect, useState } from "react";
import { useToast } from "./ToastProvider";

type UpdateStatus = {
  kind: "soft-ready" | "soft-available" | "force" | "mac-manual" | "none";
  version?: string;
  notesUrl?: string;
};

const UPDATE_TOAST_KEY = "desktop-update";

export function AppUpdateWatcher() {
  const toast = useToast();
  const [forceOpen, setForceOpen] = useState(false);

  useEffect(() => {
    const electron = window.electron;
    if (!electron?.isDesktop || !electron.onUpdateStatus) return;

    return electron.onUpdateStatus((payload: UpdateStatus) => {
      if (payload.kind === "force") {
        setForceOpen(true);
        return;
      }

      if (payload.kind === "soft-ready") {
        toast.show({
          message: "新版本已就绪",
          tone: "info",
          sticky: true,
          dedupeKey: UPDATE_TOAST_KEY,
          action: {
            label: "重启更新",
            onClick: () => {
              void window.electron?.quitAndInstall?.();
            },
          },
        });
        return;
      }

      if (payload.kind === "soft-available" || payload.kind === "mac-manual") {
        toast.show({
          message: "新版本可用",
          tone: "info",
          sticky: true,
          dedupeKey: UPDATE_TOAST_KEY,
          action: {
            label: "前往下载页",
            onClick: () => {
              void window.electron?.openDownloadPage?.();
            },
          },
        });
      }
    });
  }, [toast]);

  return (
    <Modal open={forceOpen} title="需要更新">
      {forceOpen ? (
        <section data-wf="AppUpdateForceGate" style={{ display: "grid", gap: 14 }}>
          <p style={{ margin: 0, color: "var(--muted, #6f6a60)", lineHeight: 1.5 }}>
            当前版本已停止支持,请更新后继续使用
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button
              type="button"
              variant="primary"
              onClick={() => {
                void window.electron?.openDownloadPage?.();
              }}
            >
              前往下载页
            </Button>
          </div>
        </section>
      ) : null}
    </Modal>
  );
}
