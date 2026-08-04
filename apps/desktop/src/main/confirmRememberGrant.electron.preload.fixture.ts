import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("rememberGrantFixture", {
  request: (kind: "send" | "connect") => ipcRenderer.invoke(
    "qingagent:confirm-remember-grant",
    {
      sessionId: `session-${kind}`,
      confirmId: `confirm-${kind}`,
      kind,
      trustedGesture: true,
    },
  ) as Promise<string | null>,
});
