import type { ChatChip } from "@qingagent/contract-ts";
import { describe, expect, it } from "vitest";
import {
  PENDING_SUBMISSION_CLAIM_STORAGE_KEY,
  PENDING_SUBMISSION_STORAGE_KEY,
  PENDING_SUBMISSION_TTL_MS,
  PENDING_DESKTOP_FOLDER_TOKEN_TTL_MS,
  createPendingSubmissionManager,
  type PendingFolderSource,
  type PendingPayloadStore,
  type PendingSessionStorage,
  type PendingSubmissionInput,
} from "./pendingSession";
import {
  createLocalStorageLeaseLockManager,
  type CrossTabLockManager,
} from "./crossTabLock";

function createStorage(): PendingSessionStorage & {
  values: Map<string, string>;
} {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

function createPayloadStore(options?: {
  persistAttachments?: boolean;
  persistFolder?: boolean;
}): PendingPayloadStore {
  const payloads = new Map<
    string,
    {
      attachments?: PendingSubmissionInput["attachments"];
      folderSource?: PendingFolderSource | null;
    }
  >();
  return {
    async save(submissionId, payload) {
      const current = payloads.get(submissionId) ?? {};
      if (options?.persistAttachments !== false) {
        current.attachments = payload.attachments;
      }
      if (options?.persistFolder !== false) {
        current.folderSource = payload.folderSource;
      }
      payloads.set(submissionId, current);
      return {
        attachments:
          payload.attachments.length === 0 ||
          options?.persistAttachments !== false,
        folder:
          payload.folderSource === null ||
          options?.persistFolder !== false,
      };
    },
    async load(submissionId) {
      return payloads.get(submissionId) ?? null;
    },
    async remove(submissionId) {
      payloads.delete(submissionId);
    },
  };
}

function createLockManager(): CrossTabLockManager {
  let tail = Promise.resolve();
  return {
    async request<T>(
      _name: string,
      _options: { mode: "exclusive"; ifAvailable?: boolean },
      callback: (
        lock: { name: string; mode: "exclusive" | "shared" } | null,
      ) => T | PromiseLike<T>,
    ): Promise<T> {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await callback({
          name: "pending-test",
          mode: "exclusive",
        });
      } finally {
        release();
      }
    },
  };
}

function attachChip(id: string, label = "材料.txt"): ChatChip {
  return {
    kind: { kind: "attach" },
    resourceRef: { id, domain: { kind: "file" } },
    prefix: null,
    label,
    suffix: null,
  };
}

function skillChip(id: string, label = "深度研究"): ChatChip {
  return {
    kind: { kind: "skill" },
    resourceRef: null,
    skillId: id,
    prefix: null,
    label,
    suffix: null,
  };
}

function submissionInput(
  submissionId: string,
  overrides: Partial<PendingSubmissionInput> = {},
): PendingSubmissionInput {
  return {
    submissionId,
    clientMessageId: `message-${submissionId}`,
    text: "请分析材料",
    richText: "请分析{{chip:0}}",
    chips: [attachChip("attachment-1")],
    skills: [],
    attachments: [
      {
        id: "attachment-1",
        file: new File(["真实文件内容"], "材料.txt", {
          type: "text/plain",
          lastModified: 123,
        }),
      },
    ],
    folderSource: null,
    ...overrides,
  };
}

describe("pending submission 持久化与归属", () => {
  it("在 IDB 写入完成前同步落下文字元数据，刷新后明确进入 degraded", async () => {
    const storage = createStorage();
    let finishSave!: (result: {
      attachments: boolean;
      folder: boolean;
    }) => void;
    const payloadStore: PendingPayloadStore = {
      save: () =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
      load: async () => null,
      remove: async () => undefined,
    };
    const beforeRefresh = createPendingSubmissionManager({
      storage,
      payloadStore,
      now: () => 1_000,
    });

    const creating = beforeRefresh.create(
      submissionInput("submission-writing", {
        text: "IDB 写入中也不能丢的文字",
      }),
    );
    const storedWhileWriting = JSON.parse(
      storage.getItem(PENDING_SUBMISSION_STORAGE_KEY) ?? "null",
    );
    expect(storedWhileWriting).toMatchObject({
      submissionId: "submission-writing",
      text: "IDB 写入中也不能丢的文字",
      state: "queued",
      attachmentsPersisted: false,
    });

    const afterRefresh = createPendingSubmissionManager({
      storage,
      payloadStore,
      now: () => 2_000,
    });
    const degraded = await afterRefresh.load();
    expect(degraded.kind).toBe("degraded");
    if (degraded.kind === "degraded") {
      expect(degraded.submission.text).toBe("IDB 写入中也不能丢的文字");
      expect(degraded.missingAttachmentCount).toBe(1);
      expect(degraded.submission.state).toBe("queued");
    }

    finishSave({ attachments: true, folder: true });
    await expect(creating).resolves.toMatchObject({ durable: true });
  });

  it("跨模块实例从持久层恢复 File 内容，不留下只有 chip 的假附件", async () => {
    const storage = createStorage();
    const payloadStore = createPayloadStore();
    const beforeRefresh = createPendingSubmissionManager({
      storage,
      payloadStore,
      now: () => 1_000,
    });
    await expect(
      beforeRefresh.create(submissionInput("submission-refresh")),
    ).resolves.toMatchObject({ durable: true });

    // 新 manager 没有上一实例的内存 Map，等价于页面刷新后的模块重载。
    const afterRefresh = createPendingSubmissionManager({
      storage,
      payloadStore,
      now: () => 2_000,
    });
    const result = await afterRefresh.load();

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.submission.attachments).toHaveLength(1);
    expect(
      await result.submission.attachments[0]!.file?.text(),
    ).toBe("真实文件内容");
    expect(result.submission.chips).toEqual([
      attachChip("attachment-1"),
    ]);
  });

  it("失败载荷保留为 retryable，且只能由绑定会话认领", async () => {
    const storage = createStorage();
    const payloadStore = createPayloadStore();
    const manager = createPendingSubmissionManager({
      storage,
      payloadStore,
      now: () => 1_000,
    });
    await manager.create(submissionInput("submission-owned"));

    await expect(
      manager.claim("submission-owned", null, ["queued"]),
    ).resolves.toBe(true);
    expect(
      manager.bindToSession("submission-owned", "session-a"),
    ).toBe(true);
    await expect(
      manager.markRetryable("submission-owned"),
    ).resolves.toBe(true);

    const afterRefresh = createPendingSubmissionManager({
      storage,
      payloadStore,
      now: () => 2_000,
    });
    const loaded = await afterRefresh.load();
    expect(loaded.kind).toBe("ready");
    if (loaded.kind !== "ready") return;
    expect(loaded.submission.state).toBe("retryable");
    expect(loaded.submission.targetSessionId).toBe("session-a");
    await expect(
      afterRefresh.claim("submission-owned", "session-b", [
        "retryable",
      ]),
    ).resolves.toBe(false);
    await expect(
      afterRefresh.claim("submission-owned", "session-a", [
        "retryable",
      ]),
    ).resolves.toBe(true);
  });

  it("IndexedDB 无法恢复附件时移除对应 chip、重排 richText，并保留文字", async () => {
    const storage = createStorage();
    const payloadStore = createPayloadStore({
      persistAttachments: false,
    });
    const beforeRefresh = createPendingSubmissionManager({
      storage,
      payloadStore,
      now: () => 1_000,
    });
    const input = submissionInput("submission-degraded", {
      text: "前文后文",
      richText: "前文{{chip:0}}后文{{chip:1}}",
      chips: [
        attachChip("attachment-1"),
        skillChip("skill-research"),
      ],
      skills: [{ id: "skill-research", version: null }],
    });
    await expect(beforeRefresh.create(input)).resolves.toMatchObject({
      durable: false,
    });

    const afterRefresh = createPendingSubmissionManager({
      storage,
      payloadStore,
      now: () => 2_000,
    });
    const result = await afterRefresh.load();

    expect(result.kind).toBe("degraded");
    if (result.kind !== "degraded") return;
    expect(result.missingAttachmentCount).toBe(1);
    expect(result.submission.text).toBe("前文后文");
    expect(result.submission.attachments).toEqual([]);
    expect(result.submission.chips).toEqual([
      skillChip("skill-research"),
    ]);
    expect(result.submission.richText).toBe("前文后文{{chip:0}}");
    expect(result.submission.state).toBe("queued");

    const repeated = await afterRefresh.load();
    expect(repeated.kind).toBe("degraded");
    if (repeated.kind === "degraded") {
      expect(repeated.missingAttachmentCount).toBe(1);
      expect(repeated.submission.text).toBe("前文后文");
    }
  });

  it("目录句柄不可持久化时仍恢复普通文件，并明确标记文件夹缺失", async () => {
    const storage = createStorage();
    const payloadStore = createPayloadStore({
      persistFolder: false,
    });
    const folderSource: PendingFolderSource = {
      provider: "desktop-local",
      selectedAt: 1_000,
      selection: {
        selectionToken: "folder-token",
        name: "客户资料",
        pathLabel: "~/客户资料",
        fileCount: 2,
        fileCountCapped: false,
      },
    };
    const beforeRefresh = createPendingSubmissionManager({
      storage,
      payloadStore,
      now: () => 1_000,
    });
    await beforeRefresh.create(
      submissionInput("submission-folder", { folderSource }),
    );

    const afterRefresh = createPendingSubmissionManager({
      storage,
      payloadStore,
      now: () => 2_000,
    });
    const result = await afterRefresh.load();

    expect(result.kind).toBe("degraded");
    if (result.kind !== "degraded") return;
    expect(result.folderMissing).toBe(true);
    expect(result.missingAttachmentCount).toBe(0);
    expect(result.submission.attachments[0]!.file?.name).toBe(
      "材料.txt",
    );
  });

  it("桌面文件夹令牌超过安全时效后不作为可恢复素材重试", async () => {
    const storage = createStorage();
    const payloadStore = createPayloadStore();
    const folderSource: PendingFolderSource = {
      provider: "desktop-local",
      selectedAt: 1_000,
      selection: {
        selectionToken: "folder-token",
        name: "客户资料",
        pathLabel: "~/客户资料",
        fileCount: 2,
        fileCountCapped: false,
      },
    };
    const beforeRefresh = createPendingSubmissionManager({
      storage,
      payloadStore,
      now: () => 1_000,
    });
    await beforeRefresh.create(
      submissionInput("submission-folder-expired", {
        folderSource,
      }),
    );
    const afterRefresh = createPendingSubmissionManager({
      storage,
      payloadStore,
      now: () =>
        1_000 + PENDING_DESKTOP_FOLDER_TOKEN_TTL_MS + 1,
    });

    const result = await afterRefresh.load();

    expect(result.kind).toBe("degraded");
    if (result.kind !== "degraded") return;
    expect(result.folderMissing).toBe(true);
    expect(result.submission.folderSource).toBeNull();
  });

  it("已上传附件即使刷新后 File 不可读也可沿用 fileId 重试", async () => {
    const storage = createStorage();
    const payloadStore = createPayloadStore({
      persistAttachments: false,
    });
    const manager = createPendingSubmissionManager({
      storage,
      payloadStore,
      now: () => 1_000,
    });
    await manager.create(submissionInput("submission-uploaded"));
    await manager.claim("submission-uploaded", null, ["queued"]);
    manager.bindToSession("submission-uploaded", "session-a");
    manager.updateProgress("submission-uploaded", {
      uploadedAssets: [
        {
          attachmentId: "attachment-1",
          fileId: "file-server-1",
          filename: "材料.txt",
          mime: "text/plain",
          size: 18,
        },
      ],
    });
    await manager.markRetryable("submission-uploaded");

    const afterRefresh = createPendingSubmissionManager({
      storage,
      payloadStore,
      now: () => 2_000,
    });
    const result = await afterRefresh.load();

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.submission.attachments[0]).toMatchObject({
      file: null,
      uploadedAsset: {
        fileId: "file-server-1",
      },
    });
  });

  it("超过 TTL 自动清理，不再自动重发旧载荷", async () => {
    let time = 1_000;
    const storage = createStorage();
    const payloadStore = createPayloadStore();
    const manager = createPendingSubmissionManager({
      storage,
      payloadStore,
      now: () => time,
    });
    await manager.create(submissionInput("submission-expired"));

    time += PENDING_SUBMISSION_TTL_MS + 1;
    await expect(manager.load()).resolves.toEqual({ kind: "expired" });
    expect(storage.getItem(PENDING_SUBMISSION_STORAGE_KEY)).toBeNull();
    await expect(manager.load()).resolves.toEqual({ kind: "none" });
  });

  it("新提交覆盖旧 submission，旧回调不能清掉新载荷", async () => {
    const storage = createStorage();
    const payloadStore = createPayloadStore();
    const manager = createPendingSubmissionManager({
      storage,
      payloadStore,
      now: () => 1_000,
    });
    await manager.create(submissionInput("submission-old"));
    await manager.claim("submission-old", null, ["queued"]);
    await manager.markRetryable("submission-old");
    await manager.create(
      submissionInput("submission-new", {
        text: "新的首提",
        attachments: [],
        chips: [],
        richText: null,
      }),
    );

    await expect(manager.clear("submission-old")).resolves.toBe(false);
    const result = await manager.load();
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.submission.submissionId).toBe("submission-new");
    expect(result.submission.text).toBe("新的首提");
  });

  it("克隆标签共享 queued submission 时仅一个标签取得跨标签所有权", async () => {
    const originalStorage = createStorage();
    const claimStorage = createStorage();
    const payloadStore = createPayloadStore();
    const lockManager = createLockManager();
    const original = createPendingSubmissionManager({
      storage: originalStorage,
      claimStorage,
      lockManager,
      claimOwnerId: "tab-original",
      payloadStore,
      now: () => 1_000,
    });
    await original.create(submissionInput("submission-cloned"));

    const clonedStorage = createStorage();
    for (const [key, value] of originalStorage.values) {
      clonedStorage.setItem(key, value);
    }
    const cloned = createPendingSubmissionManager({
      storage: clonedStorage,
      claimStorage,
      lockManager,
      claimOwnerId: "tab-cloned",
      payloadStore,
      now: () => 1_000,
    });

    const claims = await Promise.all([
      original.claim("submission-cloned", null, ["queued"]),
      cloned.claim("submission-cloned", null, ["queued"]),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(
      JSON.parse(
        claimStorage.getItem(PENDING_SUBMISSION_CLAIM_STORAGE_KEY) ?? "null",
      ),
    ).toMatchObject({
      claims: [{
        submissionId: "submission-cloned",
        ownerId: claims[0] ? "tab-original" : "tab-cloned",
      }],
    });

    const winner = claims[0] ? original : cloned;
    const loser = claims[0] ? cloned : original;
    await winner.clear("submission-cloned");
    await expect(
      loser.claim("submission-cloned", null, ["queued"]),
    ).resolves.toBe(false);
  });

  it("无 Web Locks 时通过 localStorage 租约互斥且首提仍可发送", async () => {
    const originalStorage = createStorage();
    const claimStorage = createStorage();
    const payloadStore = createPayloadStore();
    const original = createPendingSubmissionManager({
      storage: originalStorage,
      claimStorage,
      lockManager: createLocalStorageLeaseLockManager({
        storage: claimStorage,
        settleMs: 0,
        retryMs: 1,
        createOwnerId: () => "lease-original",
      }),
      claimOwnerId: "tab-original",
      payloadStore,
      now: () => 1_000,
    });
    await original.create(submissionInput("submission-lease"));

    const clonedStorage = createStorage();
    for (const [key, value] of originalStorage.values) {
      clonedStorage.setItem(key, value);
    }
    const cloned = createPendingSubmissionManager({
      storage: clonedStorage,
      claimStorage,
      lockManager: createLocalStorageLeaseLockManager({
        storage: claimStorage,
        settleMs: 0,
        retryMs: 1,
        createOwnerId: () => "lease-cloned",
      }),
      claimOwnerId: "tab-cloned",
      payloadStore,
      now: () => 1_000,
    });

    const claims = await Promise.all([
      original.claim("submission-lease", null, ["queued"]),
      cloned.claim("submission-lease", null, ["queued"]),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it.each([
    ["截断 JSON", '{"version":2,"submissionId":"broken"'],
    [
      "字段形状错误",
      JSON.stringify({
        version: 2,
        submissionId: "broken",
        clientMessageId: "message-broken",
        createdAt: 1,
        expiresAt: "永不过期",
        state: "queued",
        targetSessionId: null,
        text: "不应发送",
        richText: null,
        chips: [],
        skills: [],
        attachments: [],
        attachmentsPersisted: true,
        uploadedAssets: [],
        folderExpected: false,
        folderPersisted: true,
        folderAttached: false,
      }),
    ],
  ])("脏 sessionStorage（%s）不会被当作待发送载荷", async (_name, raw) => {
    const storage = createStorage();
    storage.setItem(PENDING_SUBMISSION_STORAGE_KEY, raw);
    const manager = createPendingSubmissionManager({
      storage,
      payloadStore: createPayloadStore(),
      now: () => 1_000,
    });

    await expect(manager.load()).resolves.toEqual({ kind: "none" });
    expect(manager.peekState()).toBeNull();
  });
});
