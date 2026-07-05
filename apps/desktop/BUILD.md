# 桌面客户端构建说明(总览 · 改构建逻辑前必读)

青简桌面端 = Electron 外壳 + 内嵌 Hono server(`@qingagent/server`)+ 打包好的 Web SPA(`apps/web/dist`)。
本文是**通用构建逻辑与踩坑沉淀**;Windows 交叉构建的专属细节见 [`BUILD-windows.md`](./BUILD-windows.md)。

> 一句话原则:**main 走 ESM,preload 必须走 CommonJS;能力依赖(Chromium / CJK 字体 / lark-cli / Pyodide)默认不随包,要"全能力"得显式打进去。**

---

## 1. 构建流程(两步)

```
node build.mjs            # ① esbuild 打包 main + preload + 暂存 Pyodide
electron-builder ...      # ② 套壳出安装包(读 electron-builder.yml)
```

常用命令(`apps/desktop/`):

| 命令 | 作用 |
|---|---|
| `pnpm run build` | 只跑 `node build.mjs`(出 `dist/main`、`dist/preload`) |
| `pnpm run pack` | build + `electron-builder --dir`(出免安装目录,本地快速验证) |
| `pnpm run dist` | build + `electron-builder`(出正式安装包:mac=dmg/zip,win=nsis/zip,linux=AppImage/deb) |
| `pnpm run build:win` | `bash build-win.sh`(WSL/Linux 上交叉出 Windows 包,见 BUILD-windows.md) |

前置:先确保 `apps/web` 已 `pnpm --filter @qingagent/web build`(`electron-builder.yml` 的 `extraResources` 会把 `../web/dist` 拷进 `Resources/web`)。

---

## 2. 必须遵守的构建逻辑(踩过的坑)

### 2.1 ★ preload 必须是 CommonJS(`.cjs`)——最易踩、且静默失败

`package.json` 是 `"type": "module"`,所以 `.js` 一律按 **ESM** 解释。
**Electron 的 preload 加载器无法加载 ESM 的 `.js` preload**——`contextBridge.exposeInMainWorld(...)` 不会执行,
渲染进程里 `window.electron` 变成 `undefined`,**失败是静默的(app 照常启动)**。

后果(真实事故,2026-06-22 Mac 包):`window.electron` 缺失 → 文件夹连接走到浏览器分支
(`WorkspacePage.tsx` 的 `else if (... showDirectoryPicker)`)→ 用了 `browser-fs-access`(浏览器 File System Access API)
→ 客户端里出现「此浏览器缺少文件夹授权记录 / 需要重新授权」、关掉重开还要重新授权。

**正确做法**(`build.mjs` 已落实):
- main 用 `format: "esm"` → `dist/main/index.js`(OK,Electron 主进程支持 ESM)。
- **preload 单独 `format: "cjs"` + `outExtension: { ".js": ".cjs" }` → `dist/preload/index.cjs`**,并**去掉 ESM 专用 banner**(`createRequire`/`import.meta.url` 在 CJS 里非法)。
- `src/main/index.ts` 的 `webPreferences.preload` 指向 **`../preload/index.cjs`**。

验证(见 §4):产物 `dist/preload/index.cjs` 应是 `require("electron")` 而**不是** `import ... from "electron"`。

### 2.2 main 是 ESM,但 native 模块要 external + 运行时 require

`build.mjs` 的 `sharedOptions.external` 把这些留给运行时解析,不让 esbuild 打:
- `electron`、`libsql` / `@libsql/*`(原生 `.node`,按平台)、`playwright` / `playwright-core` / `chromium-bidi`、`pyodide`。
- 工作区包(`@qingagent/server`、`@qingagent/core` 等导出的是裸 `.ts`)**要被 bundle 进** main(不在 external)。

### 2.3 libsql 原生按平台打

每个目标平台都要带对应的 `@libsql/<platform>` 原生:
- mac:`@libsql/darwin-arm64` / `darwin-x64`(在对应 Mac 上 `pnpm install` 自带)。
- win 交叉构建:必须**手动注入** `@libsql/win32-x64-msvc`(见 BUILD-windows.md §2),否则启动 `Cannot find module`。

### 2.4 asar 关闭、agent-browser 二进制排除

`electron-builder.yml`:`asar: false`(便于排查 + 避开原生模块 asar 解包问题);
`files` 里 `!**/node_modules/agent-browser/**`(它的 `.exe` 会触发 Linux 上 wine 签名 → 无 wine 即失败;浏览器自动化走 playwright)。

---

## 3. 能力依赖:默认不随包,要"全能力"得显式开(见依赖盘点)

打包**只保证 app 能起 + 基础写作**。以下能力的依赖**不在包里**,缺了会硬失败或静默降级:

| 能力 | 依赖 | 不打包的后果 | 全能力怎么开 |
|---|---|---|---|
| PDF 导出 / 浏览器抓取 | Playwright **Chromium**(不复用 Electron 内置) | PDF 直接 500;抓取降级 | 随包带 Playwright Chromium 并让其可被解析,或配 CDP/系统 Chrome |
| 中文 PDF/DOCX 质量 | **Noto Sans/Serif CJK** 字体 | 静默回退 → 方块/乱码/版式漂移 | 随包带 CJK 字体并让 Chromium 可发现 |
| 飞书 | `lark-cli` | 命令/onboarding 失败 | 随包带锁版本 lark-cli,首启复制到 userData/bin |
| `run_python` | Pyodide(~12MB) | 工具不注入 | 构建设 `QINGAGENT_BUNDLE_PYODIDE=1` + 运行时 `QINGAGENT_PYODIDE_ENABLED=1` |
| `browser_*` 自主浏览器 | Chromium + 开关 | 工具不注入 | 带 Chromium + `QINGAGENT_AGENT_BROWSER=1` 或配 CDP |
| 主模型 | 用户自配 key | 桌面代码删了 env key,必须用户配 | 提供配置流程,别靠随包 .env |

> 完整盘点见飞书《青简 · 运行时/系统依赖盘点》与本仓 codex 审计;`QINGAGENT_BUNDLE_PYODIDE` 的产物分支见 `build.mjs` / `buildPyodideStage.mjs`。

---

## 4. 出包后自检清单(每次正式包都过一遍)

1. **preload 是 CJS**:`unzip -p <app>/.../app/dist/preload/index.cjs`(asar 关,直接看文件)首行应是 `var import_electron = require("electron")`,**不能**出现 `import ... from "electron"`。
2. **window.electron 注入**:启动 app → 开发者工具 Console 敲 `window.electron` → 应得到 `{platform, isDesktop:true, selectFolderSource: ƒ}`,**不是 undefined**。
3. **文件夹走原生路径**:连一个文件夹 → hover 卡**不应**出现「浏览器缺少授权记录 / 需要重新授权」;关掉重开应**自动重连**(走 `desktop-local` 真实路径)。
4. **DB 可写**:首启不崩(libsql 原生命中、userData DB 可写)。
5. (如要 PDF)导出一份 PDF → 不 500、中文不乱码(= Chromium + CJK 字体到位)。

任一不过,**别发包**;1/2/3 不过基本就是 preload 没正确以 CJS 加载。

---

## 5. 已知遗留 / 注意

- **开发态(`pnpm dev:desktop` = `tsx src/main/index.ts`)没有 preload**:`webPreferences.preload` 指向 `dist/preload/index.cjs`,而 dev 不跑 `build.mjs` → 该文件不存在 → dev 桌面同样没有 `window.electron`、文件夹退化浏览器路径。要在 dev 里验证原生文件夹,先 `node build.mjs` 出 preload 再起 dev。
- **UNC 路径**:从 `\\wsl$\...` 双击运行有坑,见 BUILD-windows.md §1。
- **密钥不进包**:走 `userData/.env`(BUILD-windows.md §4)。

---

## 变更记录

- 2026-06-22:修复 preload 被按 ESM 打包导致打包版 `window.electron` 缺失、文件夹退化浏览器 FS 的 bug(改 `build.mjs` 出 `index.cjs` + main 指向 `.cjs`);沉淀本文。
