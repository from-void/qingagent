import { app, BrowserWindow, ipcMain } from "electron";
import { createConfirmRememberGrantHandler } from "./confirmRememberGrantHandler.js";
import {
  NativeRememberGrantGate,
  TrustedRememberUiGate,
  type RememberGrantKind,
} from "./trustedRememberUi.js";

const RESULT_PREFIX = "QINGAGENT_REMEMBER_GRANT_ELECTRON_RESULT=";

void app.whenReady().then(async () => {
  const preloadPath = process.env.QINGAGENT_REMEMBER_TEST_PRELOAD;
  if (!preloadPath) throw new Error("missing QINGAGENT_REMEMBER_TEST_PRELOAD");

  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath,
    },
  });
  const trustedInputGate = new TrustedRememberUiGate();
  const nativeGrantGate = new NativeRememberGrantGate();
  const generation = nativeGrantGate.reset();
  const registeredKinds: RememberGrantKind[] = [];
  const senderId = window.webContents.id;

  window.webContents.on("before-input-event", (_event, input) => {
    trustedInputGate.record(senderId, input.type);
  });
  const confirmRememberGrantHandler = createConfirmRememberGrantHandler({
    consumeTrustedRememberGesture: (event) => trustedInputGate.consume({
      senderId: event.sender.id,
      mainWindowSenderId: senderId,
      windowFocused: true,
      senderIsDevtools: false,
    }),
    getContext: () => ({
      generation,
      scope: "electron-fixture",
      showPrompt: async () => "remember",
    }),
    gate: nativeGrantGate,
    register: ({ kind }) => {
      registeredKinds.push(kind);
      return `${kind}-nonce`;
    },
    revoke: () => undefined,
  });
  ipcMain.handle("qingagent:confirm-remember-grant", async (event, input: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) {
      throw new Error("untrusted renderer");
    }
    return confirmRememberGrantHandler(event, input);
  });

  try {
    await window.loadURL("data:text/html,<main>remember grant fixture</main>");
    const nonces: Record<string, string | null> = {};
    for (const kind of ["send", "connect"] as const) {
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
      nonces[kind] = await window.webContents.executeJavaScript(
        `window.rememberGrantFixture.request(${JSON.stringify(kind)})`,
        true,
      ) as string | null;
    }
    console.log(RESULT_PREFIX + JSON.stringify({ nonces, registeredKinds }));
  } finally {
    ipcMain.removeHandler("qingagent:confirm-remember-grant");
    window.destroy();
    app.quit();
  }
}).catch((error) => {
  console.error("[remember-grant-electron-fixture]", error);
  app.exit(1);
});
