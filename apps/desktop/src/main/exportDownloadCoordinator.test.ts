import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  DownloadItem,
  Session,
  WebContents,
} from "electron";
import {
  ExportDownloadCoordinator,
  EXPORT_DOWNLOAD_RESULT_CHANNEL,
  type ExportDownloadResult,
} from "./exportDownloadCoordinator.js";

class FakeDownloadItem extends EventEmitter {
  savePath: string | null = null;

  constructor(
    private readonly filename: string,
    private readonly requestId = "request-1",
  ) {
    super();
  }

  getFilename(): string {
    return this.filename;
  }

  getURL(): string {
    return `blob:https://example.test/download#qingagent-export-request=${this.requestId}`;
  }

  setSavePath(filePath: string): void {
    this.savePath = filePath;
  }
}

class FakeWebContents {
  readonly id: number;
  readonly results: ExportDownloadResult[] = [];
  destroyed = false;

  constructor(id: number) {
    this.id = id;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  send(channel: string, result: ExportDownloadResult): void {
    assert.equal(channel, EXPORT_DOWNLOAD_RESULT_CHANNEL);
    this.results.push(result);
  }
}

function createHarness(options: { existing?: string[]; unclaimedTimeoutMs?: number } = {}) {
  const downloadsDirectory = mkdtempSync(path.join(tmpdir(), "qingagent-export-download-"));
  for (const filename of options.existing ?? []) {
    writeFileSync(path.join(downloadsDirectory, filename), "existing");
  }
  const session = new EventEmitter();
  const ids = ["request-1", "reveal-1", "request-2", "reveal-2", "request-3"];
  const coordinator = new ExportDownloadCoordinator(
    session as unknown as Session,
    {
      downloadsDirectory,
      unclaimedTimeoutMs: options.unclaimedTimeoutMs ?? 1_000,
      createId: () => ids.shift() ?? "fallback-id",
    },
  );
  const owner = new FakeWebContents(1);
  const otherOwner = new FakeWebContents(2);
  return {
    downloadsDirectory,
    session,
    coordinator,
    owner,
    otherOwner,
    cleanup() {
      coordinator.dispose();
      rmSync(downloadsDirectory, { recursive: true, force: true });
    },
  };
}

function emitDownload(
  session: EventEmitter,
  item: FakeDownloadItem,
  owner: FakeWebContents,
): { prevented: boolean } {
  const event = {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
  session.emit(
    "will-download",
    event,
    item as unknown as DownloadItem,
    owner as unknown as WebContents,
  );
  return event;
}

test("登记意图后只匹配同一 sender 与文件名，并立即设置下载目录路径", () => {
  const harness = createHarness();
  try {
    assert.deepEqual(
      harness.coordinator.register(harness.owner as unknown as WebContents, {
        filename: "测试文档_20260729.pdf",
        format: "pdf",
      }),
      { requestId: "request-1" },
    );

    const wrongSender = new FakeDownloadItem("测试文档_20260729.pdf");
    emitDownload(harness.session, wrongSender, harness.otherOwner);
    assert.equal(wrongSender.savePath, null);

    const wrongFilename = new FakeDownloadItem("其他文档_20260729.pdf");
    emitDownload(harness.session, wrongFilename, harness.owner);
    assert.equal(wrongFilename.savePath, null);

    const wrongRequest = new FakeDownloadItem("测试文档_20260729.pdf", "other-request");
    emitDownload(harness.session, wrongRequest, harness.owner);
    assert.equal(wrongRequest.savePath, null);

    const matched = new FakeDownloadItem("测试文档_20260729.pdf");
    emitDownload(harness.session, matched, harness.owner);
    assert.equal(
      matched.savePath,
      path.join(harness.downloadsDirectory, "测试文档_20260729.pdf"),
    );
    assert.equal(harness.owner.results.length, 0, "done 前不得回报成功");
  } finally {
    harness.cleanup();
  }
});

test("done=completed 且最终文件存在后才回报成功并签发 reveal token", () => {
  const harness = createHarness();
  try {
    harness.coordinator.register(harness.owner as unknown as WebContents, {
      filename: "测试文档_20260729.docx",
      format: "docx",
    });
    const item = new FakeDownloadItem("测试文档_20260729.docx");
    emitDownload(harness.session, item, harness.owner);
    assert.ok(item.savePath);

    item.emit("updated", {}, "progressing");
    assert.equal(harness.owner.results.length, 0);
    writeFileSync(item.savePath, "PK");
    item.emit("done", {}, "completed");

    assert.deepEqual(harness.owner.results, [{
      requestId: "request-1",
      saved: true,
      filename: "测试文档_20260729.docx",
      revealToken: "reveal-1",
    }]);
    assert.equal(
      harness.coordinator.resolveRevealPath(
        harness.owner as unknown as WebContents,
        "reveal-1",
      ),
      item.savePath,
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
});

test("cancelled、interrupted 与完成后文件缺失均回报失败", () => {
  for (const state of ["cancelled", "interrupted", "completed"] as const) {
    const harness = createHarness();
    try {
      harness.coordinator.register(harness.owner as unknown as WebContents, {
        filename: "测试文档_20260729.md",
        format: "markdown",
      });
      const item = new FakeDownloadItem("测试文档_20260729.md");
      emitDownload(harness.session, item, harness.owner);
      item.emit("done", {}, state);
      assert.deepEqual(harness.owner.results, [{
        requestId: "request-1",
        saved: false,
        filename: "测试文档_20260729.md",
        reason: state === "completed" ? "missing-file" : state,
      }]);
    } finally {
      harness.cleanup();
    }
  }
});

test("同名现有文件和并发 reservation 自动追加序号且不覆盖", () => {
  const harness = createHarness({ existing: ["测试文档_20260729.pdf"] });
  try {
    harness.coordinator.register(harness.owner as unknown as WebContents, {
      filename: "测试文档_20260729.pdf",
      format: "pdf",
    });
    harness.coordinator.register(harness.owner as unknown as WebContents, {
      filename: "测试文档_20260729.pdf",
      format: "pdf",
    });
    const first = new FakeDownloadItem("测试文档_20260729.pdf");
    const second = new FakeDownloadItem("测试文档_20260729.pdf", "reveal-1");
    emitDownload(harness.session, first, harness.owner);
    emitDownload(harness.session, second, harness.owner);

    assert.equal(
      first.savePath,
      path.join(harness.downloadsDirectory, "测试文档_20260729 (2).pdf"),
    );
    assert.equal(
      second.savePath,
      path.join(harness.downloadsDirectory, "测试文档_20260729 (3).pdf"),
    );
  } finally {
    harness.cleanup();
  }
});

test("拒绝目录穿越、绝对路径、错误扩展名和超长文件名", () => {
  const harness = createHarness();
  try {
    for (const filename of [
      "../测试.pdf",
      "/tmp/测试.pdf",
      "C:\\temp\\测试.pdf",
      "测试.docx",
      `${"很".repeat(181)}.pdf`,
    ]) {
      assert.equal(
        harness.coordinator.register(harness.owner as unknown as WebContents, {
          filename,
          format: "pdf",
        }),
        null,
        filename,
      );
    }
  } finally {
    harness.cleanup();
  }
});

test("未被 will-download 认领的意图短期回收，已认领的慢下载不受该超时影响", async () => {
  const harness = createHarness({ unclaimedTimeoutMs: 10 });
  try {
    harness.coordinator.register(harness.owner as unknown as WebContents, {
      filename: "未开始.pdf",
      format: "pdf",
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(harness.owner.results[0]?.saved, false);
    assert.equal(
      harness.owner.results[0]?.saved === false
        ? harness.owner.results[0].reason
        : null,
      "not-started",
    );

    harness.owner.results.length = 0;
    const slowRegistration = harness.coordinator.register(
      harness.owner as unknown as WebContents,
      {
      filename: "慢文件.pdf",
      format: "pdf",
      },
    );
    assert.ok(slowRegistration);
    const item = new FakeDownloadItem("慢文件.pdf", slowRegistration.requestId);
    emitDownload(harness.session, item, harness.owner);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(harness.owner.results.length, 0);
  } finally {
    harness.cleanup();
  }
});

test("窗口销毁时卸载 will-download 并收口未完成请求", () => {
  const harness = createHarness();
  harness.coordinator.register(harness.owner as unknown as WebContents, {
    filename: "测试文档_20260729.txt",
    format: "txt",
  });
  assert.equal(harness.session.listenerCount("will-download"), 1);

  harness.coordinator.dispose();

  assert.equal(harness.session.listenerCount("will-download"), 0);
  assert.deepEqual(harness.owner.results, [{
    requestId: "request-1",
    saved: false,
    filename: "测试文档_20260729.txt",
    reason: "window-closed",
  }]);
  rmSync(harness.downloadsDirectory, { recursive: true, force: true });
});
