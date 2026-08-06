import assert from "node:assert/strict";
import fs from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  legacyAgentBrowserDirectories,
  migrateLegacyAgentBrowserData,
} from "./browserCredentialMigration.js";

test("旧 cwd 登录态与完整 profile 迁入 userData 后不留敏感副本", () => {
  const root = mkdtempSync(path.join(tmpdir(), "qingagent-browser-migration-"));
  const legacyDir = path.join(root, "legacy-cwd");
  const userDataDir = path.join(root, "user-data");
  const oldState = path.join(legacyDir, ".qingagent-browser-state.json");
  const oldProfile = path.join(legacyDir, ".qingagent-browser-profile");
  const targetState = path.join(userDataDir, ".qingagent-browser-state.json");
  const targetProfile = path.join(userDataDir, ".qingagent-browser-profile");
  try {
    mkdirSync(path.join(oldProfile, "Default", "Local Storage"), {
      recursive: true,
    });
    writeFileSync(oldState, '{"cookies":[{"name":"sid"}]}');
    writeFileSync(
      path.join(oldProfile, "Default", "Local Storage", "leveldb.log"),
      "sensitive-profile",
    );

    const chmodCalls: Array<readonly unknown[]> = [];
    const mkdirCalls: Array<readonly unknown[]> = [];
    const originalChmodSync = fs.chmodSync;
    const originalMkdirSync = fs.mkdirSync;
    fs.chmodSync = ((...args: Parameters<typeof fs.chmodSync>) => {
      chmodCalls.push(args);
      return originalChmodSync(...args);
    }) as typeof fs.chmodSync;
    fs.mkdirSync = ((...args: Parameters<typeof fs.mkdirSync>) => {
      mkdirCalls.push(args);
      return originalMkdirSync(...args);
    }) as typeof fs.mkdirSync;
    syncBuiltinESMExports();

    let result;
    try {
      result = migrateLegacyAgentBrowserData({
        legacyDirectories: [legacyDir],
        storageStatePath: targetState,
        profileDir: targetProfile,
      });
    } finally {
      fs.chmodSync = originalChmodSync;
      fs.mkdirSync = originalMkdirSync;
      syncBuiltinESMExports();
    }

    assert.deepEqual(result.failures, []);
    assert.ok(
      mkdirCalls.some(
        ([target, options]) =>
          target === userDataDir &&
          typeof options === "object" &&
          options !== null &&
          (options as { mode?: number }).mode === 0o700,
      ),
      "迁移目标父目录必须以 0700 创建",
    );
    assert.ok(
      chmodCalls.some(([target, mode]) => target === targetState && mode === 0o600),
      "迁入的登录态文件必须收紧为 0600",
    );
    assert.ok(
      chmodCalls.some(([target, mode]) => target === targetProfile && mode === 0o700),
      "迁入的浏览器 profile 必须收紧为 0700",
    );
    assert.equal(readFileSync(targetState, "utf8"), '{"cookies":[{"name":"sid"}]}');
    assert.equal(
      readFileSync(
        path.join(targetProfile, "Default", "Local Storage", "leveldb.log"),
        "utf8",
      ),
      "sensitive-profile",
    );
    assert.equal(existsSync(oldState), false);
    assert.equal(existsSync(oldProfile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("跨卷迁移成功但旧登录态清理失败时记录可告知的 failure", () => {
  const root = mkdtempSync(path.join(tmpdir(), "qingagent-browser-cleanup-failure-"));
  const legacyDir = path.join(root, "legacy-system-dir");
  const userDataDir = path.join(root, "user-data");
  const oldState = path.join(legacyDir, ".qingagent-browser-state.json");
  const targetState = path.join(userDataDir, ".qingagent-browser-state.json");
  const targetProfile = path.join(userDataDir, ".qingagent-browser-profile");
  const originalRenameSync = fs.renameSync;
  const originalUnlinkSync = fs.unlinkSync;
  try {
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(oldState, "legacy-state");

    fs.renameSync = ((source, target) => {
      if (source === oldState && target === targetState) {
        throw Object.assign(new Error("fixture cross-device rename"), {
          code: "EXDEV",
        });
      }
      return originalRenameSync(source, target);
    }) as typeof fs.renameSync;
    fs.unlinkSync = ((target) => {
      if (target === oldState) throw new Error("fixture unlink denied");
      return originalUnlinkSync(target);
    }) as typeof fs.unlinkSync;
    syncBuiltinESMExports();

    const result = migrateLegacyAgentBrowserData({
      legacyDirectories: [legacyDir],
      storageStatePath: targetState,
      profileDir: targetProfile,
    });

    assert.deepEqual(result.migrated, [oldState]);
    assert.deepEqual(result.failures, [
      { path: oldState, reason: "fixture unlink denied" },
    ]);
    assert.equal(readFileSync(targetState, "utf8"), "legacy-state");
    assert.equal(readFileSync(oldState, "utf8"), "legacy-state");
  } finally {
    fs.renameSync = originalRenameSync;
    fs.unlinkSync = originalUnlinkSync;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("目标已有数据时保留目标，并清理所有旧位置的敏感副本", () => {
  const root = mkdtempSync(path.join(tmpdir(), "qingagent-browser-cleanup-"));
  const legacyDirs = [path.join(root, "cwd"), path.join(root, "install")];
  const userDataDir = path.join(root, "user-data");
  const targetState = path.join(userDataDir, ".qingagent-browser-state.json");
  const targetProfile = path.join(userDataDir, ".qingagent-browser-profile");
  try {
    mkdirSync(targetProfile, { recursive: true });
    writeFileSync(targetState, "current-state");
    writeFileSync(path.join(targetProfile, "current"), "current-profile");
    for (const legacyDir of legacyDirs) {
      mkdirSync(path.join(legacyDir, ".qingagent-browser-profile"), {
        recursive: true,
      });
      writeFileSync(
        path.join(legacyDir, ".qingagent-browser-state.json"),
        "legacy-state",
      );
      writeFileSync(
        path.join(legacyDir, ".qingagent-browser-profile", "legacy"),
        "legacy-profile",
      );
    }

    const result = migrateLegacyAgentBrowserData({
      legacyDirectories: legacyDirs,
      storageStatePath: targetState,
      profileDir: targetProfile,
    });

    assert.deepEqual(result.failures, []);
    assert.equal(readFileSync(targetState, "utf8"), "current-state");
    assert.equal(readFileSync(path.join(targetProfile, "current"), "utf8"), "current-profile");
    for (const legacyDir of legacyDirs) {
      assert.equal(
        existsSync(path.join(legacyDir, ".qingagent-browser-state.json")),
        false,
      );
      assert.equal(
        existsSync(path.join(legacyDir, ".qingagent-browser-profile")),
        false,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("旧位置候选覆盖 cwd、安装目录与 Windows 系统目录并去重", () => {
  assert.deepEqual(
    legacyAgentBrowserDirectories({
      cwd: "/runtime/cwd",
      execPath: "/install/qingagent",
      platform: "win32",
      env: {
        SystemRoot: "C:\\Windows",
        WINDIR: "c:\\windows",
      },
    }),
    ["/runtime/cwd", "/install", "C:\\Windows"],
  );
});
