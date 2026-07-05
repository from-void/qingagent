import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 注意:本文件为 .mjs(纯 JS)。build.mjs 用 `node` 直接 import 它;CI/deploy 跑在 Node 22,
// Node 22 默认不支持 import `.ts`(类型擦除需 Node 23.6+/flag),故这里不能写成 .ts。

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(currentDir, "../../..");
const entryPoint = path.join(desktopRoot, "src/renderer-inject/telemetry-inject.ts");
const outfile = path.join(desktopRoot, "dist/renderer-inject/telemetry-inject.js");

/**
 * 把渲染端注入源(Umami 发送器:pageview/settings_shown/error)打成浏览器 IIFE。
 * @param {{ write: boolean }} options write:true 写盘(prod build);write:false 返回内存代码(dev 注入)。
 * @returns {Promise<{ outfile: string, code: string | null }>}
 */
export async function buildInjectBundle(options) {
  const result = await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: "browser",
    target: "chrome130",
    format: "iife",
    globalName: "__QingAgentTelemetryInject",
    sourcemap: false,
    legalComments: "none",
    write: options.write,
    logLevel: "silent",
  });

  return {
    outfile,
    code: options.write ? null : (result.outputFiles?.[0]?.text ?? null),
  };
}
