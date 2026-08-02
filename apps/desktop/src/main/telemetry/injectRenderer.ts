import type { BrowserWindow } from "electron";
import { app } from "electron";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RendererTelemetryBootstrap } from "./index.js";
import { getLiveWebContents } from "../windowLifecycle.js";

type BuildInjectBundle = (options: { write: false }) => Promise<{ code: string | null }>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let injectBundleCodePromise: Promise<string | null> | null = null;

export function attachRendererTelemetry(
  window: BrowserWindow,
  bootstrap: RendererTelemetryBootstrap | null,
): void {
  if (!bootstrap) return;

  const contents = getLiveWebContents(window);
  if (!contents) return;
  contents.on("did-finish-load", () => {
    void injectRendererTelemetry(window, contents, bootstrap);
  });
}

async function injectRendererTelemetry(
  window: BrowserWindow,
  contents: BrowserWindow["webContents"],
  bootstrap: RendererTelemetryBootstrap,
): Promise<void> {
  const code = await getInjectBundleCode();
  if (!code || getLiveWebContents(window) !== contents) return;

  const bootstrapCode = `window.__QING_TELEMETRY__=${JSON.stringify(bootstrap)};`;
  try {
    await contents.executeJavaScript(bootstrapCode, true);
    if (getLiveWebContents(window) !== contents) return;
    await contents.executeJavaScript(code, true);
  } catch {
    // 注入失败只禁用渲染端埋点,不能影响开窗或导航。
  }
}

async function getInjectBundleCode(): Promise<string | null> {
  if (!injectBundleCodePromise) {
    injectBundleCodePromise = app.isPackaged ? readPackagedInjectBundle() : buildDevInjectBundle();
  }
  return injectBundleCodePromise;
}

async function readPackagedInjectBundle(): Promise<string | null> {
  try {
    return await readFile(path.join(__dirname, "../renderer-inject/telemetry-inject.js"), "utf8");
  } catch (err) {
    console.warn("[telemetry] renderer inject bundle missing:", err);
    return null;
  }
}

async function buildDevInjectBundle(): Promise<string | null> {
  try {
    const helperUrl = new URL("./buildInjectBundle.mjs", import.meta.url).href;
    const { buildInjectBundle } = (await import(helperUrl)) as { buildInjectBundle: BuildInjectBundle };
    const result = await buildInjectBundle({ write: false });
    return result.code;
  } catch (err) {
    console.warn("[telemetry] renderer inject bundle build skipped:", err);
    return null;
  }
}
