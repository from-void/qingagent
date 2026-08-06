import { build } from "esbuild";
import { isBundlePyodideEnabled, stagePyodideResources } from "./buildPyodideStage.mjs";
import { writeTelemetryBuildInfo } from "./buildTelemetryInfo.mjs";
import { buildInjectBundle } from "./src/main/telemetry/buildInjectBundle.mjs";
import { isBundleLarkCliEnabled, stageLarkCli } from "./stageLarkCli.mjs";

/** Shared esbuild options for Electron's Node-based contexts. */
const sharedOptions = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // electron and native Node modules must stay external.
  // npm packages are bundled (especially @qingagent/* workspace packages
  // which export raw .ts source and have no pre-built output).
  // libsql / @libsql contain native bindings — keep them external so
  // electron-builder can package the platform-specific .node files.
  // pdf-parse/pdfjs-dist rely on package export/runtime optional deps; bundling
  // breaks their Node entry initialization and ESM/CJS interop in packaged apps.
  // Keep them external and package the real runtime dependency.
  // playwright / playwright-core ship a browser driver and lazily require
  // optional deps (chromium-bidi) that esbuild cannot resolve at bundle
  // time; like the native modules above, keep them external and let them
  // resolve from node_modules at runtime.
  // pyodide:wasm/动态加载,运行时从 Resources/pyodide(打包)或 node_modules(dev)解析,esbuild 不打它。
  external: ["electron", "libsql", "@libsql/linux-x64-gnu", "@libsql/linux-x64-musl", "@libsql/darwin-arm64", "@libsql/darwin-x64", "@libsql/win32-x64-msvc", "pdf-parse", "playwright", "playwright-core", "chromium-bidi", "pyodide"],
  sourcemap: false,
  banner: {
    js: [
      // esbuild ESM output needs import.meta.url for __dirname shims.
      // createRequire is needed for native modules if any.
      'import { createRequire as __createRequire } from "node:module";',
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
};

// Bundle the main process entry point.
// Workspace packages (@qingagent/server, @qingagent/core, etc.) export raw
// .ts source, so we must bundle them into the output.  Node built-ins and
// electron are left external — they are resolved at runtime.
await build({
  ...sharedOptions,
  entryPoints: {
    index: "src/main/index.ts",
    "packaged-worker-smoke": "src/main/packagedWorkerSmoke.ts",
  },
  outdir: "dist/main",
});

console.log("Desktop main process bundled -> dist/main/index.js + packaged worker smoke");

// 遥测端点走构建期注入:源码默认空,官方包由 release 环境变量烤入 dist 产物。
const telemetryBuildInfo = writeTelemetryBuildInfo({ outdir: "dist/main" });
console.log(
  `Desktop telemetry build info -> ${telemetryBuildInfo.file} (` +
    (telemetryBuildInfo.info.telemetryEndpoint ? "endpoint injected" : "endpoint empty") +
    (telemetryBuildInfo.info.updatePolicyUrl ? ", policy URL override injected" : "") +
    ")",
);

// Bundle the preload script.
// Runs in Electron's preload context (sandboxed renderer bridge).
// 关键:preload 必须是 CommonJS。package.json 是 "type":"module",.js 会被当 ESM,
// 而 Electron 的 preload 加载器无法加载 ESM 的 .js preload(contextBridge 不执行 →
// window.electron 缺失 → 文件夹连接退化成浏览器 FS 路径)。所以单独以 cjs 产出 .cjs,
// 并去掉 sharedOptions 里的 ESM banner(createRequire/import.meta.url 在 CJS 里非法)。
await build({
  ...sharedOptions,
  format: "cjs",
  banner: { js: "" },
  entryPoints: ["src/preload/index.ts", "src/preload/rememberPrompt.ts"],
  outdir: "dist/preload",
  outExtension: { ".js": ".cjs" },
});

console.log("Desktop preload scripts bundled -> dist/preload/*.cjs (CommonJS)");

await buildInjectBundle({ write: true });

console.log("Desktop renderer telemetry inject bundled -> dist/renderer-inject/telemetry-inject.js");

// Pyodide 运行时按 build flag 暂存到 build/pyodide,electron-builder 通过 extraResources
// 拷进 Resources/pyodide。默认(flag 关)只放一个标记文件,安装包不含 ~12MB wasm,体积不变;
// 仅 QINGAGENT_BUNDLE_PYODIDE=1 时把 5 个运行时文件拷入,产出"Python 版"安装包。
// 桌面「全能力包」默认随包 Pyodide(Python 能力)。显式设 QINGAGENT_BUNDLE_PYODIDE=0/false/off/no
// 可关掉出「瘦包」;未设置(undefined/空)按默认 ON。isBundlePyodideEnabled 仍只认显式真值,
// 此处仅改「未设置时的默认」。
const pyodideFlag = process.env.QINGAGENT_BUNDLE_PYODIDE;
const BUNDLE_PYODIDE =
  pyodideFlag === undefined || pyodideFlag.trim() === ""
    ? true
    : isBundlePyodideEnabled(pyodideFlag);
const pyodideStage = stagePyodideResources({
  bundle: BUNDLE_PYODIDE,
});
if (BUNDLE_PYODIDE) {
  console.log(`Pyodide bundling ON -> build/pyodide (${pyodideStage.files.length} files, ~12MB)`);
} else {
  console.log("Pyodide bundling OFF (set QINGAGENT_BUNDLE_PYODIDE=1 to include the Python runtime)");
}

// qa CLI:随包分发的用户终端命令行(零运行时依赖),esbuild 直接把 workspace TS 打成单文件
// ESM(.mjs,Node 按扩展名认 ESM,目录里无需 package.json)暂存到 build/qa-cli,
// electron-builder 通过 extraResources 拷进 Resources/qa-cli。首启由主进程写
// ~/.qingagent/bin/qa 终端 shim(ELECTRON_RUN_AS_NODE 借应用运行时,用户无需装 Node)。
await build({
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  entryPoints: ["../../packages/qa-cli/src/cli.ts"],
  outfile: "build/qa-cli/cli.mjs",
  sourcemap: false,
});
console.log("qa CLI bundled -> build/qa-cli/cli.mjs");

// 飞书 lark-cli(@larksuite/cli)按 build flag 暂存到 build/lark-cli,electron-builder 通过
// extraResources 拷进 Resources/lark-cli。桌面「全能力包」默认 ON;显式
// QINGAGENT_BUNDLE_LARK_CLI=0/false/off/no 关掉出「不含飞书」瘦包。带版本缓存,重复构建不重装。
const BUNDLE_LARK_CLI = isBundleLarkCliEnabled();
const larkStage = stageLarkCli({ bundle: BUNDLE_LARK_CLI });
if (BUNDLE_LARK_CLI) {
  console.log(
    `lark-cli bundling ON -> build/lark-cli${larkStage.cached ? " (cached)" : " (npm install)"}`,
  );
} else {
  console.log("lark-cli bundling OFF (set QINGAGENT_BUNDLE_LARK_CLI=1 to include the Feishu CLI)");
}
