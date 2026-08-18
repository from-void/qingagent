import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { showNativeFatalEarlyErrorFallback } from "./nativeDialogFallback.js";

const MAIN_ROOT = fileURLToPath(new URL(".", import.meta.url));
const NATIVE_MESSAGE_BOX = /\.\s*showMessageBox\s*\(/g;
const NATIVE_ERROR_BOX = /\.\s*showErrorBox\s*\(/g;

test("desktop 常规消息全部走产品浮层，原生错误框只保留唯一致命早期兜底", () => {
  const productionSources = productionMainSources();
  const occurrences = productionSources.flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return [
      ...Array.from(source.matchAll(NATIVE_MESSAGE_BOX), () => ({
        file: basename(file),
        api: "showMessageBox",
      })),
      ...Array.from(source.matchAll(NATIVE_ERROR_BOX), () => ({
        file: basename(file),
        api: "showErrorBox",
      })),
    ];
  });

  assert.deepEqual(occurrences, [
    { file: "nativeDialogFallback.ts", api: "showErrorBox" },
  ]);
  assert.equal(productionSources.some((file) => (
    /\bshowMessageBox\b/.test(readFileSync(file, "utf8"))
  )), false, "常规路径不得调用任何 Electron showMessageBox");

  const indexSource = readFileSync(join(MAIN_ROOT, "index.ts"), "utf8");
  const fallbackSource = readFileSync(
    join(MAIN_ROOT, "nativeDialogFallback.ts"),
    "utf8",
  );
  const serverSource = readFileSync(join(MAIN_ROOT, "server.ts"), "utf8");
  assert.doesNotMatch(indexSource, NATIVE_MESSAGE_BOX);
  for (const kind of [
    "quit-during-generation",
    "content-load-failed",
    "renderer-recovery-stopped",
    "backend-startup-failed",
    "database-migration-failed",
  ]) {
    assert.match(indexSource, new RegExp(`"${kind}"`));
  }
  assert.ok((indexSource.match(/rendererDialogBroker\.request\(/g)?.length ?? 0) >= 4);
  assert.doesNotMatch(indexSource, /showNativeQuitFallback|showNativeContentRecoveryFallback|showNativeRendererRecoveryStopped|showNativeCrossNamespaceDemotionNotice/);
  assert.doesNotMatch(
    indexSource,
    /showNativeBrowserCredentialCleanupFailure|浏览器登录数据清理失败[\s\S]{0,240}?app\.exit\(1\)/,
    "旧浏览器凭据清理失败不得用启动弹窗阻断应用",
  );
  assert.match(fallbackSource, /仅限渲染层不可用的致命早期错误/);
  assert.match(fallbackSource, /nativeDialog\.showErrorBox\(title, content\)/);
  assert.doesNotMatch(fallbackSource, /showMessageBox|退出应用|内容页加载失败|已改用本机文库/);
  assert.doesNotMatch(fallbackSource, /浏览器登录数据清理失败/);
  assert.equal(indexSource.match(/showNativeFatalEarlyErrorFallback\(/g)?.length, 1);
  assert.doesNotMatch(serverSource, /showErrorBox|showMessageBox/);
});

test("唯一原生兜底支持注入替身，且只接收收敛后的中文安全文案", () => {
  const calls: Array<{ title: string; content: string }> = [];
  showNativeFatalEarlyErrorFallback({
    showErrorBox: (title, content) => calls.push({ title, content }),
  }, "后台连接失败", "请重新打开应用。");

  assert.deepEqual(calls, [{ title: "后台连接失败", content: "请重新打开应用。" }]);
});

function productionMainSources(directory = MAIN_ROOT): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const filePath = join(directory, entry.name);
      if (entry.isDirectory()) return productionMainSources(filePath);
      return entry.isFile()
        && entry.name.endsWith(".ts")
        && !entry.name.includes(".test.")
        && !entry.name.endsWith(".fixture.ts")
        ? [filePath]
        : [];
    })
    .sort();
}
