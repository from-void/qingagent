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

test("Windows NSIS 保持可选目录的每用户向导安装约定", () => {
  const nsis = readTopLevelBlock("nsis");

  assert.equal(readBoolean(nsis, "oneClick"), false);
  assert.equal(readBoolean(nsis, "allowToChangeInstallationDirectory"), true);
  assert.equal(readBoolean(nsis, "perMachine"), false);
  assert.equal(readBoolean(nsis, "differentialPackage"), false);
});
