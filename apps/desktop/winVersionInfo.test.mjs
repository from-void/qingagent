import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { NtExecutable, NtExecutableResource, Resource } from "resedit";

import {
  parsePackageVersion,
  stampWinVersionInfo,
  verifyWinVersionInfo,
  WIN_VERSION_STRINGS,
} from "./winVersionInfo.mjs";

async function createExecutable(filePath, withElectronVersionInfo) {
  const executable = NtExecutable.createEmpty(false, false);
  if (withElectronVersionInfo) {
    const resources = NtExecutableResource.from(executable);
    const versionInfo = Resource.VersionInfo.createEmpty();
    versionInfo.setFileVersion("39.8.10", 0x0409);
    versionInfo.setProductVersion("39.8.10", 0x0409);
    versionInfo.setStringValues(
      { lang: 0x0409, codepage: 1200 },
      { ProductName: "Electron", FileDescription: "Electron", CompanyName: "Electron authors" },
    );
    versionInfo.outputToResourceEntries(resources.entries);
    resources.outputResource(executable);
  }
  await writeFile(filePath, Buffer.from(executable.generate()), { mode: 0o755 });
}

test("parsePackageVersion 将 SemVer 映射为四段 Windows 固定版本", () => {
  assert.deepEqual(parsePackageVersion("0.1.4"), { text: "0.1.4", numeric: [0, 1, 4, 0] });
  assert.deepEqual(parsePackageVersion("2.3.4-beta.1"), {
    text: "2.3.4-beta.1",
    numeric: [2, 3, 4, 0],
  });
  assert.throws(() => parsePackageVersion("1.70000.0"), /超出 Windows VersionInfo 范围/);
});

for (const withElectronVersionInfo of [false, true]) {
  test(`盖章并读回断言${withElectronVersionInfo ? "覆盖 Electron 默认值" : "可补建缺失的 VersionInfo"}`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "qingagent-version-info-"));
    const executablePath = path.join(directory, "qingagent.exe");
    const version = parsePackageVersion("0.1.4");
    try {
      await createExecutable(executablePath, withElectronVersionInfo);
      await stampWinVersionInfo(executablePath, { version });
      const entries = await verifyWinVersionInfo(executablePath, { version });

      assert.ok(entries.length > 0);
      assert.deepEqual(entries[0].fixedFileVersion, [0, 1, 4, 0]);
      assert.deepEqual(entries[0].fixedProductVersion, [0, 1, 4, 0]);
      assert.deepEqual(
        Object.fromEntries(
          Object.keys(WIN_VERSION_STRINGS).map((key) => [key, entries[0].strings[0].values[key]]),
        ),
        WIN_VERSION_STRINGS,
      );
      assert.equal(entries[0].strings[0].values.FileVersion, "0.1.4");
      assert.equal(entries[0].strings[0].values.ProductVersion, "0.1.4");
      assert.equal((await stat(executablePath)).mode & 0o111, 0o111);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("预发布 SemVer 保留完整字符串，固定版本不误用预发布序号", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qingagent-prerelease-version-info-"));
  const executablePath = path.join(directory, "qingagent.exe");
  const version = parsePackageVersion("2.3.4-beta.1");
  try {
    await createExecutable(executablePath, true);
    const entries = await stampWinVersionInfo(executablePath, { version });

    assert.deepEqual(entries[0].fixedFileVersion, [2, 3, 4, 0]);
    assert.deepEqual(entries[0].fixedProductVersion, [2, 3, 4, 0]);
    assert.equal(entries[0].strings[0].values.FileVersion, "2.3.4-beta.1");
    assert.equal(entries[0].strings[0].values.ProductVersion, "2.3.4-beta.1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
