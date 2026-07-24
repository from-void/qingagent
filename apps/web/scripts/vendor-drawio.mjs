#!/usr/bin/env node

import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DRAWIO_TAG = "v31.0.2";
const DRAWIO_ARCHIVE_URL = `https://github.com/jgraph/drawio/archive/refs/tags/${DRAWIO_TAG}.tar.gz`;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptDir, "..");
const outputDir = path.join(webRoot, "public", "drawio");

const runtimeFiles = [
  "favicon.ico",
  "index.html",
  "images/github-logo.svg",
  "images/spin.gif",
  "js/PostConfig.js",
  "js/PreConfig.js",
  "js/app.min.js",
  "js/bootstrap.js",
  "js/extensions.min.js",
  "js/main.js",
  "js/shapes-14-6-5.min.js",
  "js/stencils.min.js",
  "math4/es5/core.js",
  "math4/es5/fonts/mathjax-tex-font/svg.js",
  "math4/es5/input/asciimath.js",
  "math4/es5/input/tex.js",
  "math4/es5/output/svg.js",
  "math4/es5/startup.js",
  "math4/es5/ui/safe.js",
  "mxgraph/css/common.css",
  "resources/dia.txt",
  "resources/dia_zh.txt",
  "styles/grapheditor.css",
  "styles/high-contrast.css",
];

const preConfig = `/**
 * Copyright (c) 2006-2024, JGraph Holdings Ltd
 * Copyright (c) 2006-2024, draw.io AG
 *
 * 青简离线嵌入配置：由 apps/web/scripts/vendor-drawio.mjs 在官方 v31.0.2
 * PreConfig.js 基础上确定性生成。只保留同源静态资源与中英文 locale。
 */
window.DRAWIO_PUBLIC_BUILD = true;
window.ALLOW_CUSTOM_PLUGINS = false;
window.EXPORT_URL = "";
window.SAVE_URL = "";
window.OPEN_URL = "";
window.PROXY_URL = "";
window.DRAWIO_BASE_URL = null;
window.DRAWIO_VIEWER_URL = null;
window.DRAWIO_LIGHTBOX_URL = null;
window.DRAWIO_LOG_URL = "";
window.NOTIFICATIONS_URL = "";
window.REALTIME_URL = "";
window.RT_WEBSOCKET_URL = "";
window.PUSHER_URL = "";
window.ICONSEARCH_PATH = null;
window.ICON_SERVICE_PATH = null;
window.DRAW_MATH_URL = "math4/es5";
window.mxLanguageMap = { en: "English", zh: "简体中文" };
window.mxLanguages = ["zh"];
window.DRAWIO_CONFIG = null;
urlParams.offline = "1";
urlParams.plugins = "0";
urlParams.pwa = "0";
urlParams.gapi = "0";
urlParams.db = "0";
urlParams.od = "0";
urlParams.gh = "0";
urlParams.gl = "0";
urlParams.tr = "0";
urlParams.sync = "manual";
`;

const postConfig = `/**
 * Copyright (c) 2006-2024, JGraph Holdings Ltd
 * Copyright (c) 2006-2024, draw.io AG
 *
 * 青简离线嵌入配置：禁用运行时图标搜索服务。
 */
window.ICONSEARCH_PATH = null;
window.ICON_SERVICE_PATH = null;
`;

async function main() {
  const sourceArg = readSourceArg(process.argv.slice(2));
  let tempRoot = null;
  try {
    const sourceRoot = sourceArg ?? await downloadSource();
    if (!sourceArg) tempRoot = path.dirname(sourceRoot);
    const { repoRoot, webappRoot } = await resolveSourceRoots(sourceRoot);

    await assertSafeOutputDir();
    await rm(outputDir, { recursive: true, force: true });
    await mkdir(outputDir, { recursive: true });
    for (const relativePath of runtimeFiles) {
      await copyRuntimeFile(webappRoot, relativePath);
    }
    await copyRuntimeFile(repoRoot, "LICENSE", "LICENSE");

    const indexPath = path.join(outputDir, "index.html");
    const indexHtml = await readFile(indexPath, "utf8");
    await writeFile(indexPath, normalizeVendorText(hardenIndexHtml(indexHtml)), "utf8");
    const bootstrapPath = path.join(outputDir, "js", "bootstrap.js");
    const bootstrapSource = await readFile(bootstrapPath, "utf8");
    await writeFile(bootstrapPath, normalizeVendorText(hardenBootstrap(bootstrapSource)), "utf8");
    const commonCssPath = path.join(outputDir, "mxgraph", "css", "common.css");
    await writeFile(
      commonCssPath,
      normalizeVendorText(await readFile(commonCssPath, "utf8")),
      "utf8",
    );
    await writeFile(path.join(outputDir, "js", "PreConfig.js"), preConfig, "utf8");
    await writeFile(path.join(outputDir, "js", "PostConfig.js"), postConfig, "utf8");
    await writeFile(path.join(outputDir, "README.md"), vendorReadme(), "utf8");

    console.log(`draw.io ${DRAWIO_TAG} 已裁剪到 ${outputDir}`);
  } finally {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  }
}

function readSourceArg(args) {
  const sourceIndex = args.indexOf("--source");
  if (sourceIndex === -1) return null;
  const source = args[sourceIndex + 1];
  if (!source) throw new Error("--source 需要指向 drawio 仓库根目录或 src/main/webapp");
  return path.resolve(source);
}

async function downloadSource() {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "qingagent-drawio-"));
  const archivePath = path.join(tempRoot, `${DRAWIO_TAG}.tar.gz`);
  const response = await fetch(DRAWIO_ARCHIVE_URL, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`下载 draw.io ${DRAWIO_TAG} 失败：HTTP ${response.status}`);
  }
  await writeFile(archivePath, new Uint8Array(await response.arrayBuffer()));
  await run("tar", ["-xzf", archivePath, "-C", tempRoot]);
  return path.join(tempRoot, `drawio-${DRAWIO_TAG.slice(1)}`);
}

async function resolveSourceRoots(sourceRoot) {
  const directIndex = path.join(sourceRoot, "index.html");
  try {
    await readFile(directIndex);
    const repoRoot = path.resolve(sourceRoot, "..", "..", "..");
    await readFile(path.join(repoRoot, "LICENSE"));
    return { repoRoot, webappRoot: sourceRoot };
  } catch {
    const nested = path.join(sourceRoot, "src", "main", "webapp");
    await readFile(path.join(nested, "index.html"));
    await readFile(path.join(sourceRoot, "LICENSE"));
    return { repoRoot: sourceRoot, webappRoot: nested };
  }
}

async function copyRuntimeFile(sourceRoot, relativePath, outputPath = relativePath) {
  const source = path.join(sourceRoot, relativePath);
  const target = path.join(outputDir, outputPath);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target);
}

function hardenIndexHtml(source) {
  return source
    .replace(/\s*<meta itemprop="image"[^>]*>/g, "")
    .replace(/\s*<link rel="canonical"[^>]*>/g, "")
    .replace(/\s*<link rel="manifest"[^>]*>/g, "")
    .replace(/\s*<link rel="apple-touch-icon"[^>]*>/g, "")
    .replace(
      /(<meta charset="utf-8">)/,
      `$1
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self' data: blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">`,
    );
}

function hardenBootstrap(source) {
  return source
    .replace(
      "https://www.drawio.com/doc/faq/supported-url-parameters",
      "draw.io supported URL parameters (see upstream documentation)",
    )
    .replace(
      "connect-src \\'self\\' https://*.draw.io https://*.diagrams.net https://fonts.googleapis.com https://fonts.gstatic.com; ",
      "connect-src \\'self\\'; ",
    )
    .replace(
      "img-src * data:; media-src *; font-src * data:;",
      "img-src \\'self\\' data: blob:; media-src \\'self\\' data: blob:; font-src \\'self\\' data:;",
    )
    .replace("https://fonts.googleapis.com; ", "");
}

function normalizeVendorText(source) {
  return source
    .replace(/[ \t]+$/gm, "")
    .replace(/^ +\t/gm, "\t")
    .replace(/\s*$/, "\n");
}

function vendorReadme() {
  return `# draw.io 离线编辑器静态资产

- 来源：jgraph/drawio \`${DRAWIO_TAG}\`
- 上游地址：${DRAWIO_ARCHIVE_URL}
- License：Apache-2.0，许可证全文见 \`LICENSE\`
- 产品入口：\`/drawio/index.html?embed=1&proto=json&spin=1&offline=1&lang=zh\`

## 裁剪范围

保留官方生产入口、生产压缩包 \`app.min.js\`、核心 shape/stencil/extension
压缩包、编辑器 CSS、SVG MathJax 运行时、必要图片，以及英文默认资源
\`resources/dia.txt\` 和简体中文 \`resources/dia_zh.txt\`。

移除源码级 JS、服务端 \`WEB-INF/META-INF\`、云盘/协作集成页、service worker、
插件、示例、模板、文档、可选扩展 stencil XML、非 zh/en locale、未被离线
embed 启动路径请求的图片与 MathJax CHTML/扩展字体。核心图形库仍由官方
\`js/shapes-14-6-5.min.js\` 与 \`js/stencils.min.js\` 提供。

## 升级复现

\`\`\`bash
node apps/web/scripts/vendor-drawio.mjs
# 已有上游源码时可跳过下载
node apps/web/scripts/vendor-drawio.mjs --source /path/to/drawio
node apps/web/scripts/check-drawio-vendor.mjs
\`\`\`

\`PreConfig.js\` / \`PostConfig.js\` 由脚本覆盖为离线配置：强制
\`offline=1\`、禁用插件/云服务/日志/通知/实时协作/图标搜索，只声明 zh/en locale。
官方生产 bundle 内仍含被 \`offline=1\` 分支禁止执行的云服务端点字符串；运行时
网络审计只允许当前应用同源的 \`/drawio/\` 请求。
`;
}

async function assertSafeOutputDir() {
  const expected = path.resolve(webRoot, "public", "drawio");
  if (path.resolve(outputDir) !== expected || path.basename(outputDir) !== "drawio") {
    throw new Error(`拒绝清理非预期目录：${outputDir}`);
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} 退出码 ${code}`));
    });
  });
}

await main();
