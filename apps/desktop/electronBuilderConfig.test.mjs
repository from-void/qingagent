import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const config = readFileSync(new URL("./electron-builder.yml", import.meta.url), "utf8");

function readTopLevelBlock(name) {
  const lines = config.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `${name}:`);
  assert.notEqual(start, -1, `缺少 ${name} 配置段`);

  const end = lines.findIndex(
    (line, index) => index > start && /^\S[^:]*:\s*(?:#.*)?$/.test(line),
  );
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

function readBoolean(block, name) {
  const match = block.match(new RegExp(`^  ${name}:\\s*(true|false)\\s*$`, "m"));
  assert.ok(match, `nsis.${name} 必须显式配置为布尔值`);
  return match[1] === "true";
}

function readTopLevelValue(name) {
  const match = config.match(new RegExp(`^${name}:\\s*(.+?)\\s*$`, "m"));
  assert.ok(match, `缺少顶层 ${name} 配置`);
  return match[1];
}

test("Windows NSIS 保持可选目录的每用户向导安装约定", () => {
  const nsis = readTopLevelBlock("nsis");

  assert.equal(readBoolean(nsis, "oneClick"), false);
  assert.equal(readBoolean(nsis, "allowToChangeInstallationDirectory"), true);
  assert.equal(readBoolean(nsis, "perMachine"), false);
  assert.equal(readBoolean(nsis, "differentialPackage"), false);
});

test("macOS 应用名保持青简，跨平台可执行名与发布产物名保持既有约定", () => {
  const mac = readTopLevelBlock("mac");

  assert.equal(readTopLevelValue("productName"), "青简");
  assert.equal(readTopLevelValue("executableName"), "qingagent");
  assert.equal(
    readTopLevelValue("artifactName"),
    "qingagent-${version}-${os}-${arch}.${ext}",
  );
  assert.match(mac, /^  executableName:\s*青简\s*$/m);
});

test("DMG 保持青简安装背景、窗口尺寸与拖拽坐标", () => {
  const dmg = readTopLevelBlock("dmg");

  assert.match(dmg, /^  background:\s*dmg-background\.png\s*$/m);
  assert.match(dmg, /^  title:\s*\$\{productName\}\s*$/m);
  assert.match(dmg, /^  iconSize:\s*96\s*$/m);
  assert.match(dmg, /^  window:\s*\n    width:\s*660\s*\n    height:\s*400\s*$/m);
  assert.match(
    dmg,
    /^  contents:\s*\n    - x:\s*185\s*\n      y:\s*235\s*\n      type:\s*file\s*\n    - x:\s*475\s*\n      y:\s*235\s*\n      type:\s*link\s*\n      path:\s*\/Applications\s*$/m,
  );
});
