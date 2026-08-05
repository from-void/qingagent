import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

    const result = migrateLegacyAgentBrowserData({
      legacyDirectories: [legacyDir],
      storageStatePath: targetState,
      profileDir: targetProfile,
    });

    assert.deepEqual(result.failures, []);
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
