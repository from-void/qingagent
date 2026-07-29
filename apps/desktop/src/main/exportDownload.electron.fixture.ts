import { app, BrowserWindow, ipcMain } from "electron";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ExportDownloadCoordinator,
  EXPORT_DOWNLOAD_CANCEL_CHANNEL,
  EXPORT_DOWNLOAD_REGISTER_CHANNEL,
  EXPORT_DOWNLOAD_REVEAL_CHANNEL,
  type ExportDownloadFormat,
  type ExportDownloadSaveResult,
} from "./exportDownloadCoordinator.js";

interface DownloadCase {
  filename: string;
  format: ExportDownloadFormat;
  mimeType: string;
  bytes: number[];
}

const RESULT_PREFIX = "QINGAGENT_EXPORT_DOWNLOAD_ELECTRON_RESULT=";

app.disableHardwareAcceleration();

void app.whenReady().then(async () => {
  const downloadsDirectory = process.env.QINGAGENT_EXPORT_TEST_DIR;
  const preloadPath = process.env.QINGAGENT_EXPORT_TEST_PRELOAD;
  if (!downloadsDirectory) throw new Error("missing QINGAGENT_EXPORT_TEST_DIR");
  if (!preloadPath) throw new Error("missing QINGAGENT_EXPORT_TEST_PRELOAD");

  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
    },
  });
  const coordinator = new ExportDownloadCoordinator(window.webContents.session, {
    downloadsDirectory,
    unclaimedTimeoutMs: 5_000,
  });
  ipcMain.handle(EXPORT_DOWNLOAD_REGISTER_CHANNEL, (event, input: unknown) => (
    coordinator.register(event.sender, input)
  ));
  ipcMain.handle(EXPORT_DOWNLOAD_CANCEL_CHANNEL, (event, requestId: unknown) => (
    coordinator.cancel(event.sender, requestId)
  ));
  ipcMain.handle(EXPORT_DOWNLOAD_REVEAL_CHANNEL, (event, token: unknown) => (
    coordinator.resolveRevealPath(event.sender, token) !== null
  ));

  try {
    await window.loadURL("data:text/html;charset=utf-8,<main>export download fixture</main>");
    const cases: DownloadCase[] = [
      {
        filename: "测试文档_20260729.md",
        format: "markdown",
        mimeType: "text/markdown;charset=utf-8",
        bytes: [...Buffer.from("# 测试\n", "utf8")],
      },
      {
        filename: "测试文档_20260729.docx",
        format: "docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        bytes: [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00],
      },
      {
        filename: "测试文档_20260729.pdf",
        format: "pdf",
        mimeType: "application/pdf",
        bytes: [...Buffer.from("%PDF-1.7\n%%EOF\n", "ascii")],
      },
      {
        filename: "测试文档_20260729.pdf",
        format: "pdf",
        mimeType: "application/pdf",
        bytes: [...Buffer.from("%PDF-1.7\n%%EOF\n", "ascii")],
      },
    ];
    const savedFilenames: string[] = [];
    for (const downloadCase of cases) {
      const result = await triggerChromiumBlobDownload(window, downloadCase);
      if (!result.saved) {
        throw new Error(`download failed: ${downloadCase.filename}/${result.reason}`);
      }
      savedFilenames.push(result.filename);
    }

    const markdown = readFileSync(path.join(downloadsDirectory, "测试文档_20260729.md"), "utf8");
    const docx = readFileSync(path.join(downloadsDirectory, "测试文档_20260729.docx"));
    const pdf = readFileSync(path.join(downloadsDirectory, "测试文档_20260729.pdf"));
    const secondPdf = readFileSync(path.join(downloadsDirectory, "测试文档_20260729 (2).pdf"));
    if (markdown !== "# 测试\n") throw new Error("markdown content mismatch");
    if (docx.subarray(0, 2).toString("ascii") !== "PK") throw new Error("docx magic mismatch");
    if (pdf.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("pdf magic mismatch");
    if (secondPdf.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new Error("numbered pdf magic mismatch");
    }

    console.log(RESULT_PREFIX + JSON.stringify({ savedFilenames }));
  } finally {
    ipcMain.removeHandler(EXPORT_DOWNLOAD_REGISTER_CHANNEL);
    ipcMain.removeHandler(EXPORT_DOWNLOAD_CANCEL_CHANNEL);
    ipcMain.removeHandler(EXPORT_DOWNLOAD_REVEAL_CHANNEL);
    coordinator.dispose();
    window.destroy();
    app.quit();
  }
}).catch((error) => {
  console.error("[export-download-electron-fixture]", error);
  app.exit(1);
});

function triggerChromiumBlobDownload(
  window: BrowserWindow,
  downloadCase: DownloadCase,
): Promise<ExportDownloadSaveResult> {
  const script = `
    (async () => {
      const bytes = new Uint8Array(${JSON.stringify(downloadCase.bytes)});
      const blobUrl = URL.createObjectURL(new Blob([bytes], {
        type: ${JSON.stringify(downloadCase.mimeType)},
      }));
      try {
        const result = await window.electron.saveExportDownload({
          blobUrl,
          filename: ${JSON.stringify(downloadCase.filename)},
          format: ${JSON.stringify(downloadCase.format)},
        });
        if (result.saved) {
          const revealed = await window.electron.revealExportDownload(result.revealToken);
          if (!revealed) throw new Error("reveal token rejected");
        }
        return result;
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    })()
  `;
  return window.webContents.executeJavaScript(script, true) as Promise<ExportDownloadSaveResult>;
}
