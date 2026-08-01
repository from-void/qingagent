import { useEffect } from "react";
import { useConfirm } from "./ConfirmProvider";

/** 接住 Electron 主进程的语义确认请求，具体卡面始终复用产品 ConfirmProvider。 */
export function DesktopDialogHost() {
  const confirm = useConfirm();

  useEffect(() => {
    const bridge = window.electron;
    if (
      !bridge?.onDesktopDialogRequest ||
      !bridge.markDesktopDialogReady ||
      !bridge.respondToDesktopDialog
    ) {
      return;
    }

    let mounted = true;
    const detach = bridge.onDesktopDialogRequest((request) => {
      if (request.kind !== "quit-during-generation") return;
      void confirm({
        title: "正在生成，退出将中断",
        message: "退出应用会停止当前生成，尚未完成的内容可能无法保留。",
        confirmLabel: "退出应用",
        cancelLabel: "继续生成",
        tone: "danger",
      }).then((confirmed) => {
        if (!mounted) return;
        bridge.respondToDesktopDialog?.(
          request.id,
          confirmed ? "confirm" : "cancel",
        );
      });
    });
    bridge.markDesktopDialogReady(["quit-during-generation"]);

    return () => {
      mounted = false;
      detach();
    };
  }, [confirm]);

  return null;
}
