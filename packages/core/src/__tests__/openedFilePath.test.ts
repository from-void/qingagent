import { mkdir, mkdtemp, open, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  statOpenedFileIdentity,
  verifyOpenedFilePath,
} from "../tools/openedFilePath.js";

describe("verifyOpenedFilePath fd 实际路径复核", () => {
  it.runIf(process.platform === "linux")("正常 fd 位于授权根内时通过", async () => {
    const root = await mkdtemp(join(tmpdir(), "opened-fd-safe-"));
    const filePath = join(root, "safe.txt");
    await writeFile(filePath, "safe");
    const canonical = await realpath(filePath);
    const expectedIdentity = await statOpenedFileIdentity(canonical);
    const handle = await open(canonical, "r");
    try {
      await expect(verifyOpenedFilePath(handle, {
        expectedPath: canonical,
        expectedIdentity,
        allowedRoot: root,
      })).resolves.toBe(canonical);
    } finally {
      await handle.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")(
    "P2-7 回归:授权后父目录替换为外部 symlink，按字符串打开的 fd 被复核拒绝",
    async () => {
      const testRoot = await mkdtemp(join(tmpdir(), "opened-fd-toctou-"));
      const allowedRoot = join(testRoot, "allowed");
      const parent = join(allowedRoot, "parent");
      const oldParent = join(allowedRoot, "parent-old");
      const outside = join(testRoot, "outside");
      await mkdir(parent, { recursive: true });
      await mkdir(outside, { recursive: true });
      await writeFile(join(parent, "document.txt"), "authorized");
      await writeFile(join(outside, "document.txt"), "secret");
      const authorizedPath = await realpath(join(parent, "document.txt"));
      const expectedIdentity = await statOpenedFileIdentity(authorizedPath);

      // 精确复现窗口：realpath/授权完成后替换中间父目录，再按原字符串 open。
      await rename(parent, oldParent);
      await symlink(outside, parent, "dir");
      const handle = await open(authorizedPath, "r");
      try {
        await expect(verifyOpenedFilePath(handle, {
          expectedPath: authorizedPath,
          expectedIdentity,
          allowedRoot,
        })).rejects.toThrow(/mismatch|outside_root/);
      } finally {
        await handle.close();
        await rm(testRoot, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "P2-7 回归:授权后同名普通目录置换，即使 fd 路径字符串相同也因 inode 不同拒绝",
    async () => {
      const testRoot = await mkdtemp(join(tmpdir(), "opened-fd-directory-swap-"));
      const allowedRoot = join(testRoot, "allowed");
      const parent = join(allowedRoot, "parent");
      const oldParent = join(allowedRoot, "parent-old");
      const filePath = join(parent, "document.txt");
      await mkdir(parent, { recursive: true });
      await writeFile(filePath, "authorized");
      const authorizedPath = await realpath(filePath);
      const expectedIdentity = await statOpenedFileIdentity(authorizedPath);

      await rename(parent, oldParent);
      await mkdir(parent);
      await writeFile(filePath, "replacement");
      const handle = await open(authorizedPath, "r");
      try {
        await expect(verifyOpenedFilePath(handle, {
          expectedPath: authorizedPath,
          expectedIdentity,
          allowedRoot,
        })).rejects.toThrow("opened_file_identity_mismatch");
      } finally {
        await handle.close();
        await rm(testRoot, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "P2-7 回归:授权后同名文件异 inode 置换被拒绝",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "opened-fd-file-swap-"));
      const filePath = join(root, "document.txt");
      const oldFilePath = join(root, "document-old.txt");
      await writeFile(filePath, "authorized");
      const canonical = await realpath(filePath);
      const expectedIdentity = await statOpenedFileIdentity(canonical);

      await rename(filePath, oldFilePath);
      await writeFile(filePath, "replacement");
      const handle = await open(canonical, "r");
      try {
        await expect(verifyOpenedFilePath(handle, {
          expectedPath: canonical,
          expectedIdentity,
          allowedRoot: root,
        })).rejects.toThrow("opened_file_identity_mismatch");
      } finally {
        await handle.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "linux")("根内合法软链解析到普通文件后仍可读", async () => {
    const root = await mkdtemp(join(tmpdir(), "opened-fd-inside-link-"));
    const targetPath = join(root, "target.txt");
    const linkPath = join(root, "link.txt");
    await writeFile(targetPath, "safe");
    await symlink(targetPath, linkPath);
    const canonical = await realpath(linkPath);
    const expectedIdentity = await statOpenedFileIdentity(canonical);
    const handle = await open(canonical, "r");
    try {
      await expect(verifyOpenedFilePath(handle, {
        expectedPath: canonical,
        expectedIdentity,
        allowedRoot: root,
      })).resolves.toBe(canonical);
    } finally {
      await handle.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("Windows 无等价安全句柄反查时明确拒绝", async () => {
    const root = await mkdtemp(join(tmpdir(), "opened-fd-windows-"));
    const filePath = join(root, "safe.txt");
    await writeFile(filePath, "safe");
    const expectedIdentity = await statOpenedFileIdentity(filePath);
    const handle = await open(filePath, "r");
    try {
      await expect(verifyOpenedFilePath(handle, {
        expectedPath: filePath,
        expectedIdentity,
        platform: "win32",
      })).rejects.toThrow("Windows host file reads are disabled");
    } finally {
      await handle.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
