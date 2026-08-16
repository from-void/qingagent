import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireStartingLease,
  dataDirDigest,
  readStartingLeaseFile,
  startExternalInstance,
  startingInstancePath,
  stopExternalInstance,
} from "../lib/externalInstance";

const dirs: string[] = [];

afterEach(async () => {
  await stopExternalInstance();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempInstancePath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qa-starting-lease-"));
  dirs.push(dir);
  return path.join(dir, "instance.json");
}

describe("starting.json 同文件系统所有权序", () => {
  it("O_EXCL 创建 0600 租约，活 owner 阻止第二启动者，release 后可重争", async () => {
    const instanceFilePath = await tempInstancePath();
    const digest = dataDirDigest("file:/tmp/library-a/qingagent.db");
    const acquired = await acquireStartingLease({ instanceFilePath, dataDirDigest: digest });
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind !== "acquired") return;
    const leasePath = startingInstancePath(instanceFilePath);
    expect((await stat(leasePath)).mode & 0o777).toBe(0o600);
    expect(await readStartingLeaseFile(leasePath)).toMatchObject({
      pid: process.pid,
      nonce: expect.stringMatching(/^[0-9a-f]{64}$/),
      dataDirDigest: digest,
      leaseExpiresAt: expect.any(String),
    });
    await expect(acquireStartingLease({ instanceFilePath, dataDirDigest: digest }))
      .rejects.toThrow("another Qingagent instance is starting");
    await acquired.lease.release();
    const reacquired = await acquireStartingLease({ instanceFilePath, dataDirDigest: digest });
    expect(reacquired.kind).toBe("acquired");
    if (reacquired.kind === "acquired") await reacquired.lease.release();
  });

  it("只有 lease 过期且 pid 不存活才回收", async () => {
    const instanceFilePath = await tempInstancePath();
    const leasePath = startingInstancePath(instanceFilePath);
    await writeFile(leasePath, JSON.stringify({
      pid: 2_000_000_000,
      nonce: "a".repeat(64),
      dataDirDigest: "b".repeat(64),
      leaseExpiresAt: "2020-01-01T00:00:00.000Z",
    }), { mode: 0o600 });
    const acquired = await acquireStartingLease({
      instanceFilePath,
      dataDirDigest: "c".repeat(64),
    });
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind === "acquired") {
      expect(acquired.lease.info.nonce).not.toBe("a".repeat(64));
      await acquired.lease.release();
    }
  });

  it("陈旧的空文件、截断 JSON 与坏结构 starting.json 都可回收重建", async () => {
    const malformedSamples = ["", "{\"pid\":", "{}"];
    for (const raw of malformedSamples) {
      const instanceFilePath = await tempInstancePath();
      const leasePath = startingInstancePath(instanceFilePath);
      await writeFile(leasePath, raw, { mode: 0o600 });
      const staleAt = new Date(Date.now() - 2_000);
      await utimes(leasePath, staleAt, staleAt);

      const acquired = await acquireStartingLease({
        instanceFilePath,
        dataDirDigest: "a".repeat(64),
        leaseDurationMs: 1_000,
      });
      expect(acquired.kind, JSON.stringify(raw)).toBe("acquired");
      if (acquired.kind === "acquired") {
        await expect(readStartingLeaseFile(leasePath)).resolves.toMatchObject({
          nonce: expect.stringMatching(/^[0-9a-f]{64}$/),
        });
        await acquired.lease.release();
      }
    }
  });

  it("发布 v2 instance.json 后删除租约，竞争者必须重发现 live instance", async () => {
    const instanceFilePath = await tempInstancePath();
    const acquired = await acquireStartingLease({
      instanceFilePath,
      dataDirDigest: "d".repeat(64),
    });
    if (acquired.kind !== "acquired") throw new Error("lease not acquired");
    const info = await startExternalInstance({
      port: 45678,
      version: "test",
      libraryId: "00000000-0000-4000-8000-000000000001",
      filePath: instanceFilePath,
      lease: acquired.lease,
    });
    await expect(stat(startingInstancePath(instanceFilePath))).rejects.toMatchObject({ code: "ENOENT" });
    const raw = JSON.parse(await readFile(instanceFilePath, "utf8")) as Record<string, unknown>;
    expect(raw).toMatchObject({
      schemaVersion: 2,
      attachProtocolVersion: 1,
      instanceId: info.instanceId,
      libraryId: info.libraryId,
      token: expect.stringMatching(/^qa_instance_[0-9a-f]{64}$/),
    });

    const rediscovered = await acquireStartingLease({
      instanceFilePath,
      dataDirDigest: "d".repeat(64),
      probeInstance: async (candidate) => candidate.instanceId === info.instanceId,
    });
    expect(rediscovered).toEqual({ kind: "existing", instance: info });
  });

  it("不兼容或半写 instance 文件 fail closed，不静默覆盖", async () => {
    const instanceFilePath = await tempInstancePath();
    await writeFile(instanceFilePath, "{\"schemaVersion\":1}", { mode: 0o600 });
    await expect(acquireStartingLease({
      instanceFilePath,
      dataDirDigest: "e".repeat(64),
    })).rejects.toThrow("malformed or incompatible");
    expect(await readFile(instanceFilePath, "utf8")).toBe("{\"schemaVersion\":1}");
  });

  it("instance 原子发布失败会抛错且不留下 tmp，租约由启动者显式收尾", async () => {
    const instanceFilePath = await tempInstancePath();
    const acquired = await acquireStartingLease({
      instanceFilePath,
      dataDirDigest: "f".repeat(64),
    });
    if (acquired.kind !== "acquired") throw new Error("lease not acquired");
    const badTarget = path.join(path.dirname(instanceFilePath), "target-is-directory");
    await mkdir(badTarget);
    await expect(startExternalInstance({
      port: 45678,
      version: "test",
      libraryId: "00000000-0000-4000-8000-000000000001",
      filePath: badTarget,
      lease: acquired.lease,
    })).rejects.toBeTruthy();
    expect((await readStartingLeaseFile(startingInstancePath(instanceFilePath))).nonce)
      .toBe(acquired.lease.info.nonce);
    const names = await readdir(path.dirname(instanceFilePath));
    expect(names.some((name) => name.includes(".tmp"))).toBe(false);
    await acquired.lease.release();
  });
});
