import { app, BrowserWindow, session, type Session } from "electron";
import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { withExportSlot } from "@qingagent/doc-render/export";
import { isAllowedExportRequest } from "./exportRequestFilter.js";
import { destroyWindowIfAlive, getLiveWebContents } from "./windowLifecycle.js";

/**
 * 桌面端 PDF 渲染器:用 Electron 自带 Chromium 的 webContents.printToPDF 把自包含 HTML
 * 打印成 PDF。复用 Electron 已内置的 Chromium —— 不再依赖随包分发 Playwright Chromium
 * (打包后没有,原路径会硬失败到 500),零增量体积。
 *
 * 字体:默认放行 toHtml 注入的 Google Fonts 外链,联网取「思源黑/宋」;每次导出使用独立
 * 内存 session，避免 file: 目录权限在并发任务间串用。打印前 await
 * document.fonts.ready(带超时上限),避免回退字体抢跑(非 FOIT:要么拿到字体,要么超时回退
 * 系统字体)。安全:导出窗口只放行 Google Fonts 域、data: 及当前私有临时目录内的 file:，
 * 其余请求一律拦截(自包含 HTML 的图片/图表已内联,无需联网)。
 */

const EXPORT_PARTITION_PREFIX = "qingagent-export-";
const EXPORT_TEMP_PREFIX = "qingagent-export-";
const EXPORT_ORPHAN_MAX_AGE_MS = 60 * 60 * 1000;

/** 启动时回收崩溃遗留的超龄导出目录；新目录可能仍在使用，绝不触碰。 */
export function cleanupOrphanedPdfExportDirs(
  tempRoot = app.getPath("temp"),
  nowMs = Date.now(),
): void {
  const cutoffMs = nowMs - EXPORT_ORPHAN_MAX_AGE_MS;
  try {
    for (const entry of readdirSync(tempRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(EXPORT_TEMP_PREFIX)) continue;
      const candidate = path.join(tempRoot, entry.name);
      try {
        const stat = lstatSync(candidate);
        if (!stat.isDirectory() || stat.mtimeMs > cutoffMs) continue;
        rmSync(candidate, { recursive: true, force: true });
      } catch {
        // 目录可能已被并发清理；单项失败不阻断应用启动。
      }
    }
  } catch {
    // 系统 temp 不可读时跳过，本次启动仍可正常导出。
  }
}

function exportSession(exportDirectory: string): Session {
  // 每次导出使用独立的内存 session，使 file: 白名单只能看见本次私有临时目录；不能因
  // 其他并发导出也处于 active 状态而互相读取对方目录。
  const sess = session.fromPartition(`${EXPORT_PARTITION_PREFIX}${randomUUID()}`);
  sess.webRequest.onBeforeRequest((details, callback) => {
    callback(isAllowedExportRequest(details.url, exportDirectory) ? {} : { cancel: true });
  });
  return sess;
}

/** 用 Electron printToPDF 把自包含 HTML 渲染成 PDF 字节。 */
export async function renderPdfViaElectron(html: string): Promise<Buffer> {
  return withExportSlot(async ({ signal }) => {
    // 用临时文件 + loadFile 加载,而非 data: URL —— 内联大量图片的文档其 data: URL 会超
    // 导航长度上限。每次导出独占 0700 私有目录,文件名不可预测且以 0600 独占创建；结束后
    // 清理整个目录,避免共享 temp 下其他本地用户读取或利用可预测文件名抢占/替换文件。
    const tmpDir = mkdtempSync(path.join(app.getPath("temp"), "qingagent-export-"));
    chmodSync(tmpDir, 0o700);
    const tmpFile = path.join(tmpDir, `${randomUUID()}.html`);
    let win: BrowserWindow | null = null;
    const destroyOnAbort = () => destroyWindowIfAlive(win);
    signal.addEventListener("abort", destroyOnAbort, { once: true });

    try {
      signal.throwIfAborted();
      writeFileSync(tmpFile, html, { encoding: "utf8", mode: 0o600, flag: "wx" });
      win = new BrowserWindow({
        show: false,
        width: 794, // A4 @96dpi 约 794×1123
        height: 1123,
        webPreferences: {
          session: exportSession(tmpDir),
          contextIsolation: true,
          nodeIntegration: false,
          spellcheck: false,
          backgroundThrottling: false,
        },
      });
      const contents = win.webContents;
      signal.throwIfAborted();
      await win.loadFile(tmpFile);
      signal.throwIfAborted();
      if (getLiveWebContents(win) !== contents) {
        throw new Error("PDF 渲染窗口已关闭");
      }
      // 等字体就绪(最多 4s),避免首屏用回退字体抢跑导致排版漂移;超时则用已就绪字体直接打印。
      await contents
        .executeJavaScript(
          "(()=>{const r=document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve();" +
            "return Promise.race([r,new Promise(res=>setTimeout(res,4000))]).then(()=>true);})()",
        )
        .catch(() => undefined);
      signal.throwIfAborted();
      if (getLiveWebContents(win) !== contents) {
        throw new Error("PDF 渲染窗口已关闭");
      }
      const data = await contents.printToPDF({
        printBackground: true,
        // 页面尺寸与页边距由 CSS @page 控制(与 Playwright 路径一致);外层 margins 置 0,
        // 完全交给 CSS,避免双重留白。
        preferCSSPageSize: true,
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
      });
      return data;
    } finally {
      signal.removeEventListener("abort", destroyOnAbort);
      destroyWindowIfAlive(win);
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // 临时目录删除失败不覆盖渲染结果；目录仍为 0700、文件仍为 0600，系统稍后会清理 temp。
      }
    }
  });
}
