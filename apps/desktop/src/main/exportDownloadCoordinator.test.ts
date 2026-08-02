import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { WebContents } from "electron";
import {
  ExportDownloadCoordinator,
  type ExportDownloadCoordinatorOptions,
  type ExportDownloadFormat,
} from "./exportDownloadCoordinator.js";

class FakeWebContents {
  destroyed = false;

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

function createHarness(
  options: Partial<ExportDownloadCoordinatorOptions> & { existing?: string[] } = {},
) {
  const downloadsDirectory = mkdtempSync(path.join(tmpdir(), "qingagent-export-download-"));
  for (const filename of options.existing ?? []) {
    writeFileSync(path.join(downloadsDirectory, filename), "existing");
  }
  const ids = [
    "pending-1",
    "reveal-1",
    "pending-2",
    "reveal-2",
    "pending-3",
    "reveal-3",
  ];
  const coordinator = new ExportDownloadCoordinator({
    downloadsDirectory,
    saveTimeoutMs: 1_000,
    createId: () => ids.shift() ?? "fallback-id",
    ...options,
  });
  const owner = new FakeWebContents();
  const otherOwner = new FakeWebContents();
  return {
    downloadsDirectory,
    coordinator,
    owner,
    otherOwner,
    cleanup() {
      coordinator.dispose();
      rmSync(downloadsDirectory, { recursive: true, force: true });
    },
  };
}

function saveInput(
  filename: string,
  format: ExportDownloadFormat,
  content: string | number[],
) {
  return {
    filename,
    format,
    bytes: typeof content === "string"
      ? new Uint8Array(Buffer.from(content))
      : new Uint8Array(content),
  };
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("PDF、DOCX、HTML、Markdown、TXT 均由主进程字节写盘并签发 owner-scoped reveal token", async () => {
  const cases = [
    ["测试文档_20260802.pdf", "pdf", [...Buffer.from("%PDF-1.7\n%%EOF\n")]],
    ["测试文档_20260802.docx", "docx", [0x50, 0x4b, 0x03, 0x04]],
    ["测试文档｜完整指南_20260802.html", "html", "<!doctype html><title>测试</title>\n"],
    ["测试文档｜完整指南_20260802.md", "markdown", "# Markdown 测试\n"],
    ["测试文档｜完整指南_20260802.txt", "txt", "TXT 测试\n"],
  ] as const;

  for (const [filename, format, content] of cases) {
    const harness = createHarness();
    try {
      const input = saveInput(filename, format, content as string | number[]);
      const result = await harness.coordinator.save(
        harness.owner as unknown as WebContents,
        input,
      );
      assert.deepEqual(result, {
        saved: true,
        filename,
        revealToken: "reveal-1",
      });
      assert.deepEqual(
        readFileSync(path.join(harness.downloadsDirectory, filename)),
        Buffer.from(input.bytes),
      );
      assert.equal(
        harness.coordinator.resolveRevealPath(
          harness.owner as unknown as WebContents,
          "reveal-1",
        ),
        path.join(harness.downloadsDirectory, filename),
      );
      assert.equal(
        harness.coordinator.resolveRevealPath(
          harness.otherOwner as unknown as WebContents,
          "reveal-1",
        ),
        null,
      );
    } finally {
      harness.cleanup();
    }
  }
});

test("同名现有文件与并发 pending 保存均自动编号且不覆盖", async () => {
  let releaseFirst: (() => void) | undefined;
  let markFirstStarted: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  let writeCount = 0;
  const harness = createHarness({
    existing: ["测试文档_20260802.pdf"],
    writeFile: async (filePath, bytes, options) => {
      writeCount += 1;
      if (writeCount === 1) {
        markFirstStarted?.();
        await firstGate;
      }
      await writeFile(filePath, bytes, options);
    },
  });
  try {
    const firstSave = harness.coordinator.save(
      harness.owner as unknown as WebContents,
      saveInput("测试文档_20260802.pdf", "pdf", "%PDF-first"),
    );
    await firstStarted;
    const secondSave = harness.coordinator.save(
      harness.owner as unknown as WebContents,
      saveInput("测试文档_20260802.pdf", "pdf", "%PDF-second"),
    );
    const secondResult = await secondSave;
    releaseFirst?.();
    const firstResult = await firstSave;

    assert.equal(firstResult.filename, "测试文档_20260802 (2).pdf");
    assert.equal(secondResult.filename, "测试文档_20260802 (3).pdf");
    assert.equal(
      readFileSync(path.join(harness.downloadsDirectory, "测试文档_20260802.pdf"), "utf8"),
      "existing",
    );
    assert.equal(
      readFileSync(path.join(harness.downloadsDirectory, "测试文档_20260802 (2).pdf"), "utf8"),
      "%PDF-first",
    );
    assert.equal(
      readFileSync(path.join(harness.downloadsDirectory, "测试文档_20260802 (3).pdf"), "utf8"),
      "%PDF-second",
    );
  } finally {
    harness.cleanup();
  }
});

test("写盘失败回报 write-failed，且不留下半成品或临时文件", async () => {
  const harness = createHarness({
    writeFile: async (filePath) => {
      await writeFile(filePath, "partial", { flag: "wx" });
      throw new Error("disk full");
    },
  });
  try {
    const result = await harness.coordinator.save(
      harness.owner as unknown as WebContents,
      saveInput("失败.txt", "txt", "完整内容"),
    );
    assert.deepEqual(result, {
      saved: false,
      filename: "失败.txt",
      reason: "write-failed",
    });
    assert.deepEqual(readdirSync(harness.downloadsDirectory), []);
  } finally {
    harness.cleanup();
  }
});

test("写盘超过上限会中止 pending 并回报 timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const writeStarted = createDeferred();
  const writeAborted = createDeferred();
  const cleanupFinished = createDeferred();
  let rejectWrite: ((reason?: unknown) => void) | undefined;
  const harness = createHarness({
    saveTimeoutMs: 1_000,
    ensureDirectory: async () => undefined,
    writeFile: async (_filePath, _bytes, { signal }) => {
      writeStarted.resolve();
      signal.addEventListener(
        "abort",
        () => writeAborted.resolve(),
        { once: true },
      );
      return new Promise((_, reject) => {
        rejectWrite = reject;
      });
    },
    removeFile: async () => {
      cleanupFinished.resolve();
    },
  });
  try {
    let saveSettled = false;
    const pendingSave = harness.coordinator.save(
      harness.owner as unknown as WebContents,
      saveInput("超时.html", "html", "<p>test</p>"),
    ).then((result) => {
      saveSettled = true;
      return result;
    });
    await writeStarted.promise;

    t.mock.timers.tick(999);
    await Promise.resolve();
    assert.equal(saveSettled, false);

    t.mock.timers.tick(1);
    await writeAborted.promise;
    const result = await pendingSave;
    assert.deepEqual(result, {
      saved: false,
      filename: "超时.html",
      reason: "timeout",
    });
    rejectWrite?.(new Error("write aborted"));
    await cleanupFinished.promise;
    assert.equal(existsSync(path.join(harness.downloadsDirectory, "超时.html")), false);
  } finally {
    rejectWrite?.(new Error("test cleanup"));
    await Promise.resolve();
    harness.cleanup();
  }
});

test("窗口关闭会中止未完成保存并回报 window-closed", async () => {
  const writeStarted = createDeferred();
  const writeSettled = createDeferred();
  const harness = createHarness({
    writeFile: async (_filePath, _bytes, { signal }) => {
      writeStarted.resolve();
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          reject(new Error("write aborted"));
          writeSettled.resolve();
        }, { once: true });
      });
    },
  });
  try {
    const pendingSave = harness.coordinator.save(
      harness.owner as unknown as WebContents,
      saveInput("窗口关闭.md", "markdown", "# test"),
    );
    await writeStarted.promise;
    harness.coordinator.dispose();
    assert.deepEqual(await pendingSave, {
      saved: false,
      filename: "窗口关闭.md",
      reason: "window-closed",
    });
    await writeSettled.promise;
  } finally {
    harness.cleanup();
  }
});

test("最终文件不存在时不误报成功", async () => {
  const harness = createHarness({ fileExists: () => false });
  try {
    const result = await harness.coordinator.save(
      harness.owner as unknown as WebContents,
      saveInput("缺失.docx", "docx", [0x50, 0x4b]),
    );
    assert.deepEqual(result, {
      saved: false,
      filename: "缺失.docx",
      reason: "missing-file",
    });
  } finally {
    harness.cleanup();
  }
});

test("拒绝目录穿越、绝对路径、错误扩展名、非字节载荷和超长文件名", async () => {
  const harness = createHarness();
  try {
    for (const input of [
      saveInput("../测试.pdf", "pdf", "%PDF"),
      saveInput("/tmp/测试.pdf", "pdf", "%PDF"),
      saveInput("C:\\temp\\测试.pdf", "pdf", "%PDF"),
      saveInput("测试.docx", "pdf", "%PDF"),
      saveInput(`${"很".repeat(181)}.pdf`, "pdf", "%PDF"),
      { filename: "测试.pdf", format: "pdf", bytes: "%PDF" },
    ]) {
      const result = await harness.coordinator.save(
        harness.owner as unknown as WebContents,
        input,
      );
      assert.equal(result.saved, false);
      assert.equal(result.saved ? null : result.reason, "not-started");
    }
    assert.deepEqual(readdirSync(harness.downloadsDirectory), []);
  } finally {
    harness.cleanup();
  }
});

test("拒绝 Windows 保留设备名 stem，且不误伤相邻普通名称", async () => {
  const harness = createHarness();
  try {
    for (const filename of [
      "CON.pdf",
      "con.pdf",
      "PrN.pdf",
      "aux.pdf",
      "NuL.pdf",
      ...Array.from({ length: 9 }, (_, index) => `CoM${index + 1}.pdf`),
      ...Array.from({ length: 9 }, (_, index) => `lPt${index + 1}.pdf`),
    ]) {
      const result = await harness.coordinator.save(
        harness.owner as unknown as WebContents,
        saveInput(filename, "pdf", "%PDF"),
      );
      assert.equal(result.saved, false, filename);
      assert.equal(result.saved ? null : result.reason, "not-started", filename);
    }

    for (const filename of ["CONSOLE.pdf", "COM10.pdf"]) {
      const result = await harness.coordinator.save(
        harness.owner as unknown as WebContents,
        saveInput(filename, "pdf", "%PDF"),
      );
      assert.equal(result.saved, true, filename);
    }
  } finally {
    harness.cleanup();
  }
});
