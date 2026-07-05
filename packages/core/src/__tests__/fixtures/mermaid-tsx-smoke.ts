// 回归 fixture(mermaidServer.test.ts 用 tsx 子进程跑):
// tsx(esbuild keepNames)会把 renderDiagramSvgs 里 evaluate 回调内的
// `const parseMermaid = async …` 包成 __name(fn,"parseMermaid");回调序列化进浏览器后
// 若无 __name 兜底会 ReferenceError → 全部图表回退源码。vitest 转换不开 keepNames,
// 所以这条脏路径只有在 tsx 运行时下才能复现——必须真跑 tsx 子进程。
import { renderDiagramSvgs } from "../../export/mermaidServer.js";
import { closeBrowser } from "../../browser/pool.js";

const [svg] = await renderDiagramSvgs(["flowchart TD\n  A[提交代码] --> B[部署生产]"]);
console.log(
  JSON.stringify({
    ok: typeof svg === "string" && svg.includes("<svg"),
    reasonHint: typeof svg === "string" ? null : "render returned null (查 warn 日志的 reason)",
  }),
);
await closeBrowser().catch(() => undefined);
process.exit(0);
