#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const testVendorRoot =
  process.env.NODE_ENV === "test" && process.env.VITEST === "true"
    ? process.env.QINGAGENT_DRAWIO_VENDOR_ROOT_TEST?.trim()
    : undefined;
const vendorRoot = testVendorRoot
  ? path.resolve(testVendorRoot)
  : path.resolve(scriptDir, "..", "public", "drawio");
const maxVendorBytes = 25 * 1024 * 1024;
const requiredFiles = [
  "LICENSE",
  "README.md",
  "index.html",
  "js/PreConfig.js",
  "js/PostConfig.js",
  "js/app.min.js",
  "js/shapes-14-6-5.min.js",
  "js/stencils.min.js",
  "math4/es5/core.js",
  "math4/es5/fonts/mathjax-tex-font/svg.js",
  "math4/es5/input/asciimath.js",
  "math4/es5/input/tex.js",
  "math4/es5/output/svg.js",
  "math4/es5/startup.js",
  "math4/es5/ui/safe.js",
  "resources/dia.txt",
  "resources/dia_zh.txt",
  "styles/grapheditor.css",
];
const forbiddenRuntimeUrl = /\bhttps?:\/\/[^\s"'<>]+/i;
const auditedTextFiles = [
  "index.html",
  "js/PreConfig.js",
  "js/PostConfig.js",
  "js/bootstrap.js",
  "js/main.js",
  "styles/grapheditor.css",
  "styles/high-contrast.css",
  "mxgraph/css/common.css",
];

const failures = [];
for (const relativePath of requiredFiles) {
  try {
    const info = await stat(path.join(vendorRoot, relativePath));
    if (!info.isFile() || info.size === 0) failures.push(`${relativePath} 不是非空文件`);
  } catch {
    failures.push(`缺少 ${relativePath}`);
  }
}

const files = await walkFiles(vendorRoot);
const totalBytes = (await Promise.all(files.map((file) => stat(file)))).reduce((sum, info) => sum + info.size, 0);
if (totalBytes > maxVendorBytes) {
  failures.push(`vendor 体积 ${totalBytes} bytes 超过 ${maxVendorBytes} bytes`);
}

const locales = files
  .map((file) => path.relative(vendorRoot, file).replaceAll(path.sep, "/"))
  .filter((file) => /^resources\/dia_.+\.txt$/.test(file))
  .sort();
if (JSON.stringify(locales) !== JSON.stringify(["resources/dia_zh.txt"])) {
  failures.push(`locale 裁剪异常：${locales.join(", ")}`);
}

for (const relativePath of auditedTextFiles) {
  const source = await readFile(path.join(vendorRoot, relativePath), "utf8");
  if (forbiddenRuntimeUrl.test(source)) failures.push(`${relativePath} 含运行时外联 URL`);
}

const preConfig = await readFile(path.join(vendorRoot, "js", "PreConfig.js"), "utf8");
for (const assertion of [
  'urlParams.offline = "1"',
  'urlParams.plugins = "0"',
  'window.DRAWIO_LOG_URL = ""',
  "window.ICON_SERVICE_PATH = null",
  'window.DRAW_MATH_URL = "math4/es5"',
  'settingsName: "qingagent-drawio"',
  "enableCustomLibraries: false",
]) {
  if (!preConfig.includes(assertion)) failures.push(`PreConfig 缺少离线断言：${assertion}`);
}
const indexHtml = await readFile(path.join(vendorRoot, "index.html"), "utf8");
for (const directive of [
  "default-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "frame-src 'none'",
]) {
  if (!indexHtml.includes(directive)) failures.push(`index CSP 缺少：${directive}`);
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`draw.io vendor 检查通过：${files.length} files，${totalBytes} bytes`);
}

async function walkFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? walkFiles(target) : [target];
  }));
  return nested.flat();
}
