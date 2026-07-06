import { app, BrowserWindow, session, type Session } from "electron";
import { unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isAllowedExportRequest } from "./exportRequestFilter.js";

/**
 * 桌面端 PDF 渲染器:用 Electron 自带 Chromium 的 webContents.printToPDF 把自包含 HTML
 * 打印成 PDF。复用 Electron 已内置的 Chromium —— 不再依赖随包分发 Playwright Chromium
 * (打包后没有,原路径会硬失败到 500),零增量体积。
 *
 * 字体:默认放行 toHtml 注入的 Google Fonts 外链,联网取「思源黑/宋」;用持久 session 分区,
 * Chromium 自动 HTTP 缓存到 userData,仅第一次导出联网下载,之后复用。打印前 await
 * document.fonts.ready(带超时上限),避免回退字体抢跑(非 FOIT:要么拿到字体,要么超时回退
 * 系统字体)。安全:导出窗口只放行 Google Fonts 域 + file:/data:,其余外部请求一律拦截
 * (自包含 HTML 的图片/图表已内联,无需联网)。
 */

const EXPORT_PARTITION = "persist:qingagent-export";

let filterInstalled = false;
function exportSession(): Session {
  const sess = session.fromPartition(EXPORT_PARTITION);
  if (!filterInstalled) {
    sess.webRequest.onBeforeRequest((details, callback) => {
      callback(isAllowedExportRequest(details.url) ? {} : { cancel: true });
    });
    filterInstalled = true;
  }
  return sess;
}

// 临时 HTML 文件名计数器:避免并发导出互相覆盖(配合 pid 唯一)。
let exportSeq = 0;

/** 用 Electron printToPDF 把自包含 HTML 渲染成 PDF 字节。 */
export async function renderPdfViaElectron(html: string): Promise<Buffer> {
  // 用临时文件 + loadFile 加载,而非 data: URL —— 内联大量图片的文档其 data: URL 会超
  // 导航长度上限。临时文件落 app temp 目录,打印后删除。
  const tmpFile = path.join(
    app.getPath("temp"),
    `qingagent-export-${process.pid}-${(exportSeq += 1)}.html`,
  );
  writeFileSync(tmpFile, html, "utf8");

  const win = new BrowserWindow({
    show: false,
    width: 794, // A4 @96dpi 约 794×1123
    height: 1123,
    webPreferences: {
      session: exportSession(),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  try {
    await win.loadFile(tmpFile);
    // 等字体就绪(最多 4s),避免首屏用回退字体抢跑导致排版漂移;超时则用已就绪字体直接打印。
    await win.webContents
      .executeJavaScript(
        "(()=>{const r=document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve();" +
          "return Promise.race([r,new Promise(res=>setTimeout(res,4000))]).then(()=>true);})()",
      )
      .catch(() => undefined);
    const data = await win.webContents.printToPDF({
      printBackground: true,
      // 页面尺寸与页边距由 CSS @page 控制(与 Playwright 路径一致);外层 margins 置 0,
      // 完全交给 CSS,避免双重留白。
      preferCSSPageSize: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    return data;
  } finally {
    win.destroy();
    try {
      unlinkSync(tmpFile);
    } catch {
      // 临时文件删除失败忽略(系统会清理 temp 目录)。
    }
  }
}
