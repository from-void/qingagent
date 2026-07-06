# Windows 客户端构建说明

## 一键构建(推荐,在 WSL/Linux 上交叉构建)

```bash
pnpm --filter @qingagent/desktop build:win
# 等价于:bash apps/desktop/build-win.sh
```

产物:
- `apps/desktop/release/win-unpacked/青简.exe`
- `C:\qingagent\win-unpacked\青简.exe`(脚本自动复制到 Windows 本地盘,可直接双击)

脚本 `build-win.sh` 一条龙做四件事:
1. 构建 web 前端(`@qingagent/web`)
2. esbuild 打包 electron main/preload + `electron-builder --win --dir` 出 win-unpacked
3. 注入 win 版原生依赖：`@libsql/win32-x64-msvc` 和 `@napi-rs/canvas-win32-x64-msvc`,清掉打错的 linux 原生
4. 整个 win-unpacked 复制到 `C:\qingagent\win-unpacked`

---

## 关键规则(踩过的坑,改前必读)

### 1. 必须从 Windows 本地盘运行,不要从 WSL UNC 路径双击
从 `\\wsl.localhost\...` / `\\wsl$\...` 这类 UNC 网络路径直接运行 exe,
electron 的 GPU 子进程会启动失败(`error_code=18`)→ 反复崩溃 → FATAL
`GPU process isn't usable. Goodbye` → 整个 app 闪退。
**认准 `C:\qingagent\win-unpacked\青简.exe` 本地盘路径**,有硬件加速、不崩。

`main/index.ts` 里:仅在「Linux」或「从 UNC 路径运行」时
`app.disableHardwareAcceleration()` 走软件渲染;本地 Windows 盘运行保留全速硬件加速。

### 2. 必须手动注入 win 版原生依赖(交叉构建专属)
pnpm 在 Linux 上只装 libsql 的 linux 原生(`@libsql/linux-x64-gnu`),
不装 `@libsql/win32-x64-msvc`;electron-builder 会把 linux 原生打进 win 包 →
Windows 上 `Cannot find module '@libsql/win32-x64-msvc'` 启动报错。
脚本第 3 步用 `npm pack @libsql/win32-x64-msvc@<版本>` 解决。
**版本号(当前 0.5.29)必须与 `package.json` 里 libsql 主包一致**,
升级 libsql 时同步改 `build-win.sh` 里的 `LIBSQL_VERSION`。

PDF 解析依赖 `pdf-parse` → `@napi-rs/canvas`,后者同样按平台安装 native 包。
WSL/Linux 交叉构建时也必须注入 `@napi-rs/canvas-win32-x64-msvc`;脚本会从
`@napi-rs/canvas` 的 `optionalDependencies` 读取版本并自动注入。

### 3. DATABASE_URL 必须用 pathToFileURL 生成
Windows 路径含盘符+反斜杠(`C:\Users\...`),`file:${dbPath}` 是非法 URL,
libsql 连库即崩(启动闪退)。用 `pathToFileURL(dbPath).href`,
Windows 输出 `file:///C:/...`、*nix 输出 `file:///...`,两端皆可用。

### 4. 密钥走 userData/.env,不进包
打包后无需重新构建即可配密钥:把 `.env` 放进
`%APPDATA%\@qingagent\desktop\.env`(如 `DEEPSEEK_API_KEY=...`)。
`main/index.ts` 在 import server 之前 `loadEnvFile` 加载它
(@qingagent/core 在模块求值期就读环境变量,必须早加载)。
缺 key → app 里 agent 调用报"连接失败"。

### 5. 为什么不出 nsis Setup.exe / 为什么 asar 关闭
- nsis 安装包在 Linux 上需要 wine 签名/打包,无 wine 无 sudo → 只出 `--dir`(win-unpacked)。
  要 Setup.exe 得在 Windows 机器上跑(见下)。
- `electron-builder.yml` 关了 asar、关了 `signAndEditExecutable`(避免 wine 依赖)。
- 排除了 `node_modules/agent-browser/**`(它的 .exe 会触发 wine 签名);
  浏览器自动化走 playwright。chromium 未随包分发,浏览器类工具会降级,核心写作链路不受影响。

---

## 在 Windows 机器上原生构建(出 nsis Setup.exe,自动装 win 原生,无需注入)

```
pnpm install
pnpm --filter @qingagent/web build
pnpm --filter @qingagent/desktop dist   # 出 nsis Setup.exe;产物在 apps/desktop/release/
```

注:Windows 机器需能访问 npm registry。早前实测该机无外网/被 WSL-interop 注入了
错误代理(`http;\\wsl.localhost\...`)导致 `pnpm install` ENOTFOUND,故改走 WSL 交叉构建。
