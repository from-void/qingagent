import { useEffect } from "react";
import { useToast } from "./ToastProvider";

const CROSS_NAMESPACE_DEMOTION_NOTICE = "cross-namespace-library-demoted" as const;

/** 启动事实只在内容页就绪后展示；sticky toast 不参与主进程启动控制流。 */
export function DesktopStartupNotice() {
  const toast = useToast();

  useEffect(() => {
    const bridge = window.electron;
    if (bridge?.getPendingStartupNotice?.() !== CROSS_NAMESPACE_DEMOTION_NOTICE) return;
    toast.show({
      message: "已改用本机文库。原绑定指向 WSL 环境里的文库，本客户端只能连接本机青简引擎；原 WSL 文库数据仍在 WSL 中，未受影响。",
      tone: "warn",
      sticky: true,
      role: "status",
      dedupeKey: CROSS_NAMESPACE_DEMOTION_NOTICE,
      onDismiss: () => {
        void bridge.acknowledgeStartupNotice?.(CROSS_NAMESPACE_DEMOTION_NOTICE);
      },
    });
  }, [toast]);

  return null;
}
