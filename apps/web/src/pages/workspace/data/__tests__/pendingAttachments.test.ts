import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Tests for the pending-session module-level file passing and
 * the sessionStorage-based pending-message flow between
 * NewSessionPage and WorkspacePage.
 */

// Mock sessionStorage for Node environment
const store = new Map<string, string>();
const mockSessionStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => store.set(key, value),
  removeItem: (key: string) => store.delete(key),
  clear: () => store.clear(),
};

const PENDING_MSG_KEY = "qingagent:pending-message";

describe("sessionStorage pending-message", () => {
  beforeEach(() => {
    store.clear();
  });

  afterEach(() => {
    store.clear();
  });

  it("stores and retrieves pending-message", () => {
    mockSessionStorage.setItem(PENDING_MSG_KEY, "Hello world");

    const retrieved = mockSessionStorage.getItem(PENDING_MSG_KEY);
    expect(retrieved).toBe("Hello world");
  });

  it("stores pending-message even when text is empty but files exist", () => {
    // This matches the behavior in NewSessionPage: empty text + files
    // should still set pending-message (as empty string) so WorkspacePage
    // knows a submission happened.
    const text = "";
    const hasFiles = true;

    if (text.length > 0 || hasFiles) {
      mockSessionStorage.setItem(PENDING_MSG_KEY, text);
    }

    expect(mockSessionStorage.getItem(PENDING_MSG_KEY)).toBe("");
  });

  it("cleans up pending-message after retrieval", () => {
    mockSessionStorage.setItem(PENDING_MSG_KEY, "some text");

    const pending = mockSessionStorage.getItem(PENDING_MSG_KEY);
    expect(pending).toBeTruthy();

    mockSessionStorage.removeItem(PENDING_MSG_KEY);
    expect(mockSessionStorage.getItem(PENDING_MSG_KEY)).toBeNull();
  });
});

describe("pendingSession module-level file passing", () => {
  afterEach(async () => {
    const { clearPendingFiles, clearPendingFolderSource } = await import(
      "../../../../system/pendingSession"
    );
    clearPendingFiles();
    clearPendingFolderSource();
  });

  it("setPendingFiles + consumePendingFiles 按 submission 所有权 round-trip", async () => {
    const { setPendingFiles, consumePendingFiles } = await import(
      "../../../../system/pendingSession"
    );

    // Simulate File objects with plain objects (sufficient for this test)
    const fakeFiles = [
      new File(["hello"], "test.txt", { type: "text/plain" }),
      new File(["pdf data"], "report.pdf", { type: "application/pdf" }),
    ];

    setPendingFiles("submission-1", fakeFiles);
    const consumed = consumePendingFiles("submission-1");

    expect(consumed).toHaveLength(2);
    expect(consumed[0]!.name).toBe("test.txt");
    expect(consumed[1]!.name).toBe("report.pdf");
  });

  it("consumePendingFiles clears the slot", async () => {
    const { setPendingFiles, consumePendingFiles } = await import(
      "../../../../system/pendingSession"
    );

    setPendingFiles("submission-1", [new File(["data"], "a.txt")]);
    consumePendingFiles("submission-1"); // first consume
    const second = consumePendingFiles("submission-1"); // should be empty
    expect(second).toHaveLength(0);
  });

  it("consumePendingFiles returns empty when nothing was set", async () => {
    const { consumePendingFiles } = await import(
      "../../../../system/pendingSession"
    );

    const result = consumePendingFiles("submission-empty");
    expect(result).toEqual([]);
  });

  it("旧 submission 既读不到也清不掉新 submission 的附件", async () => {
    const {
      clearPendingFiles,
      peekPendingFiles,
      setPendingFiles,
    } = await import("../../../../system/pendingSession");
    const stale = new File(["old"], "old.txt");
    const current = new File(["new"], "new.txt");

    setPendingFiles("submission-old", [stale]);
    setPendingFiles("submission-new", [current]);
    expect(peekPendingFiles("submission-old")).toEqual([]);

    clearPendingFiles("submission-old");
    expect(peekPendingFiles("submission-new")).toEqual([current]);
  });

  it("setPendingFolderSource + consumePendingFolderSource round-trip", async () => {
    const {
      consumePendingFolderSource,
      peekPendingFolderSource,
      setPendingFolderSource,
    } = await import("../../../../system/pendingSession");
    const source = {
      provider: "desktop-local" as const,
      selectedAt: 1,
      selection: {
        selectionToken: "dfs_1_token",
        name: "客户资料",
        pathLabel: "~/Documents/客户资料",
        fileCount: 14,
        fileCountCapped: false,
      },
    };

    setPendingFolderSource(source);

    expect(peekPendingFolderSource()).toEqual(source);
    expect(consumePendingFolderSource()).toEqual(source);
    expect(consumePendingFolderSource()).toBeNull();
  });
});
