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
  build: {
    // 全站 CSS 打成一个文件、由 index.html 静态 <link> 引入(渲染阻塞)。
    //
    // 病根:开启 CSS 代码分割时,页面样式随 lazy chunk 走,而 Vite preload helper 用全局 seen
    // 表去重 —— 只有第一次碰到某个 CSS 才返回「等 link load」的 promise。App.tsx 的空闲预热正是
    // 那第一次(等待被 void 掉),等用户真正切页、React.lazy 第二次调同一工厂时 seen 命中直接短路,
    // 不等 CSS 就把 chunk 交出去 → 组件先挂载、样式后到,那几百毫秒是**完全无样式的裸 DOM**
    // (布局/字色/玻璃感全丢)。在 lazy 工厂里等样式表只能缓解:等待必须带超时(否则网络异常会卡死
    // 导航),一超时裸 DOM 照旧 —— 实测 10s 慢 CSS 下必然触发。
    //
    // 关掉分割则从根上消除「组件可能早于样式」:CSS 在 React 挂载前就已生效,任何路由、任何进入
    // 路径(转场/hash 直达/深链/前进后退)都不可能无样式。代价是首屏多下全站 CSS(约 90KB gzip,
    // 单请求、与 JS 并行),相对 WorkspacePage 自己 777KB gzip 的 JS 可以忽略。
    cssCodeSplit: false,
  },
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
