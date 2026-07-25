import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";

// 应用版本号:从 package.json 取,编译期以 __APP_VERSION__ 注入,供 web 端「网页版 vX.Y.Z」降级显示。
const appVersion = (createRequire(import.meta.url)("./package.json") as { version?: string }).version ?? "0.0.0";

const devPort = Number(process.env.QINGAGENT_WEB_PORT ?? process.env.PORT ?? 6173);
const apiTarget = process.env.WE_API_TARGET ?? "http://127.0.0.1:8080";

// 构建信息(版本/时间/commit):由 build-win.sh 等打包脚本注入 QINGAGENT_BUILD_INFO
// (形如 "2026-07-02 11:05 · a993510+"),编译期定值进包;dev 未注入时显示 "dev"。
// 让客户端标题栏/首页角标直观显示"这个包是什么时候打的",便于验收区分新旧包。
const buildInfo = process.env.QINGAGENT_BUILD_INFO || "dev";

export default defineConfig({
  plugins: [react()],
  envPrefix: ["VITE_"],
  define: {
    __BUILD_INFO__: JSON.stringify(buildInfo),
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  // 注:CSS 保持按页分割(Vite 默认 cssCodeSplit:true)—— 首屏只下首页那份,其余随 lazy chunk
  // 后台预载。「组件早于样式挂载 → 无样式裸 DOM」不靠关掉分割来解,而是由 App.tsx 用 onceAsync
  // 记忆化路由工厂来解:让预热与 React.lazy 落在同一次 __vitePreload 上,那一次会等 CSS link
  // load(第二次调用会命中 Vite 的 seen 去重、直接短路不等 CSS)。详见 system/onceAsync.ts。
  server: {
    host: true,
    port: devPort,
    strictPort: false,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: false,
      },
    },
  },
  preview: {
    host: true,
    port: Number(process.env.QINGAGENT_PREVIEW_PORT ?? devPort),
    strictPort: false,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: false,
      },
    },
  },
});
