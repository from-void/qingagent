import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const MAIN_ROOT = fileURLToPath(new URL(".", import.meta.url));
const NATIVE_MESSAGE_BOX = /\bdialog\s*\.\s*showMessageBox\s*\(/g;
const NATIVE_ERROR_BOX = /\bdialog\s*\.\s*showErrorBox\s*\(/g;

test("desktop 原生消息框只存在于 renderer 不可用的集中兜底", () => {
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
    { file: "index.ts", api: "showErrorBox" },
    { file: "nativeDialogFallback.ts", api: "showMessageBox" },
    { file: "nativeDialogFallback.ts", api: "showMessageBox" },
    { file: "server.ts", api: "showErrorBox" },
  ]);
  assert.deepEqual(
    productionSources
      .filter((file) => /\bshowMessageBox\b/.test(readFileSync(file, "utf8")))
      .map((file) => basename(file)),
    ["nativeDialogFallback.ts"],
    "任何写法的 showMessageBox 都只能进入 renderer 不可用兜底文件",
  );

  const indexSource = readFileSync(join(MAIN_ROOT, "index.ts"), "utf8");
  const fallbackSource = readFileSync(
    join(MAIN_ROOT, "nativeDialogFallback.ts"),
    "utf8",
  );
  const serverSource = readFileSync(join(MAIN_ROOT, "server.ts"), "utf8");
  assert.doesNotMatch(indexSource, NATIVE_MESSAGE_BOX);
  assert.match(indexSource, /rendererDialogBroker\.request/);
  assert.match(indexSource, /showNativeQuitFallback/);
  assert.match(indexSource, /showNativeContentRecoveryFallback/);
  assert.doesNotMatch(
    indexSource,
    /showNativeBrowserCredentialCleanupFailure|浏览器登录数据清理失败[\s\S]{0,240}?app\.exit\(1\)/,
    "旧浏览器凭据清理失败不得用启动弹窗阻断应用",
  );
  assert.match(fallbackSource, /buttons:\s*\["退出应用", "继续生成"\]/);
  assert.match(fallbackSource, /defaultId:\s*1/);
  assert.match(fallbackSource, /buttons:\s*\["重试", "退出"\]/);
  assert.doesNotMatch(fallbackSource, /浏览器登录数据清理失败/);
  assert.doesNotMatch(indexSource, /showErrorBox\([\s\S]{0,240}?\+\s*detail/);
  assert.doesNotMatch(serverSource, /showErrorBox\([\s\S]{0,320}?\+\s*detail/);
});

function productionMainSources(): string[] {
  return readdirSync(MAIN_ROOT)
    .filter((name) => name.endsWith(".ts") && !name.includes(".test.") && !name.endsWith(".fixture.ts"))
    .sort()
    .map((name) => join(MAIN_ROOT, name));
}
