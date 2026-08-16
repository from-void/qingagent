import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverAttachInstances, isDiscoveryReport } from "./attachDiscovery.js";
import {
  decodeWslOutput,
  discoverWsl,
  inspectCandidate,
  inspectWslCandidate,
  wslUncHomes,
} from "./attachDiscoveryWorker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];

async function tempHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "qingagent-attach-discovery-"));
  roots.push(home);
  return home;
}

function discover(home: string) {
  return discoverAttachInstances({
    home,
    platform: "linux",
    workerPath: path.join(__dirname, "attachDiscoveryWorker.ts"),
    developmentWorker: true,
    execPath: process.execPath,
  });
}

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test("本机发现确认无文件时返回 absent", async () => {
  const result = await discover(await tempHome());
  assert.deepEqual(result, { observations: [{ source: "local", state: "absent" }] });
});

test("活跃 starting.json 租约返回精确的 STARTING_LEASE", async () => {
  const home = await tempHome();
  const discoveryDir = path.join(home, ".qingagent");
  await mkdir(discoveryDir, { recursive: true });
  await writeFile(path.join(discoveryDir, "starting.json"), JSON.stringify({
    pid: process.pid,
    nonce: "1".repeat(64),
    dataDirDigest: "2".repeat(64),
    leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
  }), { mode: 0o600 });
  const result = await discover(home);
  assert.deepEqual(result, {
    observations: [{ source: "local", state: "indeterminate", errorCode: "STARTING_LEASE" }],
  });
});

test("WSL 输出兼容 UTF-16 BOM、无 BOM UTF-16 与 UTF-8", () => {
  assert.equal(decodeWslOutput(Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from("Ubuntu\r\n", "utf16le"),
  ])).trim(), "Ubuntu");
  assert.equal(decodeWslOutput(Buffer.from("Ubuntu\r\n", "utf16le")).trim(), "Ubuntu");
  assert.equal(decodeWslOutput(Buffer.from("Ubuntu\n", "utf8")).trim(), "Ubuntu");
});

test("WSL UNC 先试 wsl.localhost，再回退兼容 wsl$", async () => {
  assert.deepEqual(wslUncHomes("Ubuntu-24.04", "/home/测试"), [
    "\\\\wsl.localhost\\Ubuntu-24.04\\home\\测试",
    "\\\\wsl$\\Ubuntu-24.04\\home\\测试",
  ]);
  const attempted: string[] = [];
  const result = await inspectWslCandidate(
    "wsl:Ubuntu-24.04",
    "Ubuntu-24.04",
    "/home/tester",
    async (source, home) => {
      attempted.push(home);
      return attempted.length === 1
        ? { source, state: "indeterminate", errorCode: "HOME_UNREACHABLE" }
        : { source, state: "absent" };
    },
  );
  assert.deepEqual(attempted, [
    "\\\\wsl.localhost\\Ubuntu-24.04\\home\\tester",
    "\\\\wsl$\\Ubuntu-24.04\\home\\tester",
  ]);
  assert.deepEqual(result, { source: "wsl:Ubuntu-24.04", state: "absent" });

  const inaccessible = await inspectWslCandidate(
    "wsl:Ubuntu-24.04",
    "Ubuntu-24.04",
    "/home/tester",
    async (source) => ({ source, state: "indeterminate", errorCode: "HOME_UNREACHABLE" }),
  );
  assert.deepEqual(inaccessible, {
    source: "wsl:Ubuntu-24.04",
    state: "indeterminate",
    errorCode: "HOME_UNREACHABLE",
  });
  const recoveredFromTimeout = await inspectWslCandidate(
    "wsl:Ubuntu-24.04",
    "Ubuntu-24.04",
    "/home/tester",
    (() => {
      let attempts = 0;
      return async (source) => (++attempts === 1
        ? { source, state: "indeterminate", errorCode: "READ_TIMEOUT" }
        : { source, state: "absent" });
    })(),
  );
  assert.deepEqual(recoveredFromTimeout, {
    source: "wsl:Ubuntu-24.04",
    state: "absent",
  });
});

test("跨 WSL 的过期租约不使用 Windows pid 表续命", async () => {
  const home = await tempHome();
  const discoveryDir = path.join(home, ".qingagent");
  await mkdir(discoveryDir, { recursive: true });
  await writeFile(path.join(discoveryDir, "starting.json"), JSON.stringify({
    pid: process.pid,
    nonce: "1".repeat(64),
    dataDirDigest: "2".repeat(64),
    leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
  }), { mode: 0o600 });
  assert.deepEqual(await inspectCandidate("wsl:test", home, {
    requireReachableHome: true,
    sameProcessNamespace: false,
  }), { source: "wsl:test", state: "absent" });
  assert.deepEqual(await inspectCandidate("local", home, {
    sameProcessNamespace: true,
  }), { source: "local", state: "indeterminate", errorCode: "STARTING_LEASE" });
});

test("UNC HOME 不可达不能等同 discovery 文件 absent", async () => {
  const result = await inspectCandidate(
    "wsl:missing",
    path.join(await tempHome(), "not-reachable"),
    { requireReachableHome: true, sameProcessNamespace: false },
  );
  assert.deepEqual(result, {
    source: "wsl:missing",
    state: "indeterminate",
    errorCode: "HOME_UNREACHABLE",
  });
});

test("WSL 枚举区分未安装、停止与全局枚举失败", async () => {
  const notInstalled = Object.assign(new Error("missing"), { code: "ENOENT" });
  assert.deepEqual(await discoverWsl({ runWslImpl: async () => { throw notInstalled; } }), [
    { source: "wsl", state: "absent", errorCode: "WSL_NOT_INSTALLED" },
  ]);
  assert.deepEqual(await discoverWsl({ runWslImpl: async () => "" }), [
    { source: "wsl", state: "absent", errorCode: "WSL_STOPPED" },
  ]);
  assert.deepEqual(await discoverWsl({ runWslImpl: async () => { throw new Error("denied"); } }), [
    { source: "wsl", state: "indeterminate", errorCode: "ENUM_FAILED" },
  ]);
});

test("单发行版 HOME 失败只降级该候选，不遮蔽可用 WSL 实例", async () => {
  const result = await discoverWsl({
    runWslImpl: async (args) => {
      if (args[0] === "--list") return "docker-desktop\nUbuntu\n";
      if (args[1] === "docker-desktop") throw new Error("no regular HOME");
      return "/home/tester";
    },
    inspectWslCandidateImpl: async (source) => ({
      source,
      state: "valid",
      instance: {
        schemaVersion: 2,
        port: 43123,
        pid: 123,
        version: "0.1.4",
        attachProtocolVersion: 1,
        instanceId: "00000000-0000-4000-8000-000000000001",
        libraryId: "00000000-0000-4000-8000-000000000002",
        token: `qa_instance_${"a".repeat(64)}`,
        startedAt: "2026-01-01T00:00:00.000Z",
        endpoint: "http://127.0.0.1:43123",
        source,
      },
    }),
  });
  assert.equal(result[0]?.state, "absent");
  assert.equal(result[0]?.errorCode, "HOME_FAILED");
  assert.equal(result[1]?.state, "valid");
});

test("父进程拒绝子进程伪造的远程 endpoint、token 与空观察集", () => {
  assert.equal(isDiscoveryReport({ observations: [] }), false);
  assert.equal(isDiscoveryReport({
    observations: [{
      source: "local",
      state: "valid",
      instance: {
        schemaVersion: 2,
        port: 43123,
        pid: 123,
        version: "1.0.0",
        attachProtocolVersion: 1,
        instanceId: "00000000-0000-4000-8000-000000000001",
        libraryId: "00000000-0000-4000-8000-000000000002",
        token: "qa_instance_secret",
        startedAt: new Date().toISOString(),
        source: "local",
        endpoint: "https://evil.example",
      },
    }],
  }), false);
  assert.equal(isDiscoveryReport({
    observations: [{ source: "local", state: "indeterminate", errorCode: "UNKNOWN" }],
  }), false);
  assert.equal(isDiscoveryReport({
    observations: [{ source: "wsl:docker-desktop", state: "absent", errorCode: "HOME_FAILED" }],
  }), true);
});
