import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 默认 testTimeout 5000ms 对本包里少数「浏览器渲染」用例太短:导出 PDF/PNG(toPdf/
    // toDocx 含公式渲染)会真起 headless 浏览器渲染,CI 慢 runner 上冷启动 + 渲染单个用例
    // 可达 10~20s(export-rich-formats / rich-formats-persistence 等,均按 hasChromium 门控:
    // 本地无浏览器时 skip,CI 装了 Chromium 才真跑)。抬到 30s 给这些用例足够预算;绝大多数
    // 纯逻辑用例远低于此,不受影响。并行竞争另由 CI 侧 --fileParallelism=false 串行规避。
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
