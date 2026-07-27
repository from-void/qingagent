import type { ChatChip, SkillRef } from "@qingagent/contract-ts";
import {
  browserCrossTabLockManager,
  withCrossTabLock,
  type CrossTabLockManager,
} from "./crossTabLock";

/**
 * 新建页与工作区之间的首提载荷。
 *
 * sessionStorage 只保存轻量元数据；File 与目录句柄分键写入 IndexedDB。分键是刻意的：
 * 某些浏览器不能 structured-clone FileSystemDirectoryHandle 时，普通文件仍应可恢复。
 */

export const PENDING_SUBMISSION_ID_STORAGE_KEY =
  "qingagent:pending-submission-id";
export const PENDING_SUBMISSION_STORAGE_KEY =
  "qingagent:pending-submission-v2";
export const PENDING_SUBMISSION_CLAIM_STORAGE_KEY =
  "qingagent:pending-submission-claim-v1";
export const PENDING_SUBMISSION_TTL_MS = 30 * 60 * 1_000;
export const PENDING_DESKTOP_FOLDER_TOKEN_TTL_MS = 110_000;

const PENDING_SUBMISSION_CLAIM_LOCK_NAME =
  "qingagent:pending-submission-claim";
const PENDING_SUBMISSION_CLAIM_LEASE_MS = 2 * 60 * 1_000;

const LEGACY_STORAGE_KEYS = [
  "qingagent:pending-message",
  "qingagent:pending-richtext",
  "qingagent:pending-chips",
  "qingagent:pending-skills",
] as const;

const PENDING_DB_NAME = "qingagent-pending-submissions";
const PENDING_DB_STORE = "payloads";
const PENDING_DB_VERSION = 1;

export interface PendingDesktopFolderSource {
  provider: "desktop-local";
  selectedAt: number;
  selection: {
    selectionToken: string;
    name: string;
    pathLabel: string;
    fileCount: number | null;
    fileCountCapped: boolean;
  };
}

export interface PendingBrowserFolderSource {
  provider: "browser-fs-access";
  picked: {
    handle: FileSystemDirectoryHandle;
    name: string;
    browserHandleKey: string;
    clientSourceId: string;
  };
}

export type PendingFolderSource =
  | PendingDesktopFolderSource
  | PendingBrowserFolderSource;

export interface PendingAttachmentInput {
  id: string;
  file: File;
}

export interface PendingUploadedAsset {
  attachmentId: string;
  fileId: string;
  filename: string;
  mime: string | null;
  size: number;
}

export type PendingSubmissionState =
  | "queued"
  | "dispatching"
  | "retryable";

export interface PendingSubmissionInput {
  submissionId: string;
  clientMessageId: string;
  text: string;
  richText: string | null;
  chips: ChatChip[];
  skills: SkillRef[];
  attachments: PendingAttachmentInput[];
  folderSource: PendingFolderSource | null;
}

interface PendingAttachmentDescriptor {
  id: string;
  name: string;
  type: string;
  size: number;
  lastModified: number;
}

interface StoredPendingSubmission {
  version: 2;
  submissionId: string;
  clientMessageId: string;
  createdAt: number;
  expiresAt: number;
  state: PendingSubmissionState;
  targetSessionId: string | null;
  text: string;
  richText: string | null;
  chips: ChatChip[];
  skills: SkillRef[];
  attachments: PendingAttachmentDescriptor[];
  attachmentsPersisted: boolean;
  uploadedAssets: PendingUploadedAsset[];
  folderExpected: boolean;
  folderPersisted: boolean;
  folderAttached: boolean;
}

interface PendingPayload {
  attachments: PendingAttachmentInput[];
  folderSource: PendingFolderSource | null;
}

export interface PendingSubmission {
  submissionId: string;
  clientMessageId: string;
  createdAt: number;
  expiresAt: number;
  state: PendingSubmissionState;
  targetSessionId: string | null;
  text: string;
  richText: string | null;
  chips: ChatChip[];
  skills: SkillRef[];
  attachments: Array<{
    id: string;
    file: File | null;
    uploadedAsset: PendingUploadedAsset | null;
  }>;
  folderSource: PendingFolderSource | null;
  folderAttached: boolean;
}

export type PendingSubmissionLoadResult =
  | { kind: "none" }
  | { kind: "expired" }
  | { kind: "ready"; submission: PendingSubmission }
  | {
      kind: "degraded";
      submission: PendingSubmission;
      missingAttachmentCount: number;
      folderMissing: boolean;
    };

export interface PendingPayloadSaveResult {
  attachments: boolean;
  folder: boolean;
}

export interface PendingPayloadStore {
  save(
    submissionId: string,
    payload: PendingPayload,
  ): Promise<PendingPayloadSaveResult>;
  load(submissionId: string): Promise<Partial<PendingPayload> | null>;
  remove(submissionId: string): Promise<void>;
}

export interface PendingSessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PendingSubmissionManager {
  create(
    input: PendingSubmissionInput,
  ): Promise<{ durable: boolean; submissionId: string }>;
  load(): Promise<PendingSubmissionLoadResult>;
  peekState(): {
    submissionId: string;
    state: PendingSubmissionState;
  } | null;
  claim(
    submissionId: string,
    workspaceSessionId: string | null,
    allowedStates: readonly PendingSubmissionState[],
  ): Promise<boolean>;
  bindToSession(submissionId: string, sessionId: string): boolean;
  markRetryable(submissionId: string): Promise<boolean>;
  updateProgress(
    submissionId: string,
    update: {
      uploadedAssets?: PendingUploadedAsset[];
      folderAttached?: boolean;
    },
  ): boolean;
  clear(submissionId?: string): Promise<boolean>;
}

interface PendingSubmissionClaim {
  submissionId: string;
  ownerId: string;
  expiresAt: number;
}

interface PendingSubmissionClaimRegistry {
  version: 1;
  claims: PendingSubmissionClaim[];
}

function attachmentDescriptor(
  attachment: PendingAttachmentInput,
): PendingAttachmentDescriptor {
  return {
    id: attachment.id,
    name: attachment.file.name,
    type: attachment.file.type,
    size: attachment.file.size,
    lastModified: attachment.file.lastModified,
  };
}

function fileMatchesDescriptor(
  file: File,
  descriptor: PendingAttachmentDescriptor,
): boolean {
  return (
    file.name === descriptor.name &&
    file.type === descriptor.type &&
    file.size === descriptor.size &&
    file.lastModified === descriptor.lastModified
  );
}

function isPendingState(value: unknown): value is PendingSubmissionState {
  return (
    value === "queued" ||
    value === "dispatching" ||
    value === "retryable"
  );
}

function parseMetadata(raw: string | null): StoredPendingSubmission | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredPendingSubmission>;
    if (
      value.version !== 2 ||
      typeof value.submissionId !== "string" ||
      typeof value.clientMessageId !== "string" ||
      typeof value.createdAt !== "number" ||
      typeof value.expiresAt !== "number" ||
      !isPendingState(value.state) ||
      (value.targetSessionId !== null &&
        typeof value.targetSessionId !== "string") ||
      typeof value.text !== "string" ||
      (value.richText !== null && typeof value.richText !== "string") ||
      !Array.isArray(value.chips) ||
      !Array.isArray(value.skills) ||
      !Array.isArray(value.attachments) ||
      typeof value.attachmentsPersisted !== "boolean" ||
      !Array.isArray(value.uploadedAssets) ||
      typeof value.folderExpected !== "boolean" ||
      typeof value.folderPersisted !== "boolean" ||
      typeof value.folderAttached !== "boolean"
    ) {
      return null;
    }
    return value as StoredPendingSubmission;
  } catch {
    return null;
  }
}

function parseSubmissionClaims(raw: string | null): PendingSubmissionClaim[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as Partial<PendingSubmissionClaimRegistry>;
    if (
      value.version !== 1 ||
      !Array.isArray(value.claims)
    ) {
      return [];
    }
    return value.claims.filter(
      (claim): claim is PendingSubmissionClaim =>
        claim !== null &&
        typeof claim === "object" &&
        typeof claim.submissionId === "string" &&
        typeof claim.ownerId === "string" &&
        typeof claim.expiresAt === "number",
    );
  } catch {
    return [];
  }
}

function createClaimOwnerId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `pending-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sanitizeMissingAttachmentChips(
  chips: readonly ChatChip[],
  richText: string | null,
  missingAttachmentIds: ReadonlySet<string>,
): { chips: ChatChip[]; richText: string | null } {
  if (missingAttachmentIds.size === 0) {
    return { chips: [...chips], richText };
  }

  const nextChips: ChatChip[] = [];
  const nextIndexByOldIndex = new Map<number, number>();
  chips.forEach((chip, oldIndex) => {
    const remove =
      chip.kind.kind === "attach" &&
      chip.resourceRef !== null &&
      missingAttachmentIds.has(chip.resourceRef.id);
    if (remove) return;
    nextIndexByOldIndex.set(oldIndex, nextChips.length);
    nextChips.push(chip);
  });

  const nextRichText =
    richText === null
      ? null
      : richText.replace(/\{\{chip:(\d+)\}\}/g, (_marker, indexRaw) => {
          const nextIndex = nextIndexByOldIndex.get(Number(indexRaw));
          return nextIndex === undefined ? "" : `{{chip:${nextIndex}}}`;
        });
  return { chips: nextChips, richText: nextRichText };
}

function toSubmission(
  metadata: StoredPendingSubmission,
  attachments: PendingSubmission["attachments"],
  folderSource: PendingFolderSource | null,
): PendingSubmission {
  return {
    submissionId: metadata.submissionId,
    clientMessageId: metadata.clientMessageId,
    createdAt: metadata.createdAt,
    expiresAt: metadata.expiresAt,
    state: metadata.state,
    targetSessionId: metadata.targetSessionId,
    text: metadata.text,
    richText: metadata.richText,
    chips: metadata.chips,
    skills: metadata.skills,
    attachments,
    folderSource,
    folderAttached: metadata.folderAttached,
  };
}

export function createPendingSubmissionManager(input: {
  storage: PendingSessionStorage;
  payloadStore: PendingPayloadStore;
  claimStorage?: PendingSessionStorage;
  lockManager?: CrossTabLockManager | null;
  claimOwnerId?: string;
  now?: () => number;
}): PendingSubmissionManager {
  const { storage, payloadStore } = input;
  const claimStorage = input.claimStorage ?? storage;
  const lockManager =
    input.lockManager === undefined
      ? input.claimStorage
        ? browserCrossTabLockManager({ leaseStorage: claimStorage })
        : createSingleContextLockManager()
      : input.lockManager;
  const claimOwnerId = input.claimOwnerId ?? createClaimOwnerId();
  const now = input.now ?? Date.now;
  let memoryMetadata: StoredPendingSubmission | null = null;
  const memoryPayloads = new Map<string, PendingPayload>();

  const removeLegacyStorage = () => {
    for (const key of LEGACY_STORAGE_KEYS) {
      try {
        storage.removeItem(key);
      } catch {
        // sessionStorage 在受限环境中可能不可写；内存副本仍可完成当前 SPA 交接。
      }
    }
  };

  const readMetadata = (): StoredPendingSubmission | null => {
    let stored: StoredPendingSubmission | null = null;
    try {
      stored = parseMetadata(storage.getItem(PENDING_SUBMISSION_STORAGE_KEY));
    } catch {
      // 使用同一模块实例内的副本继续当前 SPA 交接。
    }
    return stored ?? memoryMetadata;
  };

  const writeMetadata = (metadata: StoredPendingSubmission): boolean => {
    memoryMetadata = metadata;
    let stored = false;
    try {
      storage.setItem(
        PENDING_SUBMISSION_STORAGE_KEY,
        JSON.stringify(metadata),
      );
      storage.setItem(
        PENDING_SUBMISSION_ID_STORAGE_KEY,
        metadata.submissionId,
      );
      stored = true;
    } catch {
      // 调用方根据 durable=false 告知用户刷新风险。
    }
    return stored;
  };

  const clearMetadata = (submissionId?: string): boolean => {
    const current = readMetadata();
    if (
      submissionId !== undefined &&
      current?.submissionId !== submissionId
    ) {
      return false;
    }
    memoryMetadata = null;
    try {
      storage.removeItem(PENDING_SUBMISSION_STORAGE_KEY);
      storage.removeItem(PENDING_SUBMISSION_ID_STORAGE_KEY);
    } catch {
      // 内存所有权已清；受限 storage 无法进一步处理。
    }
    removeLegacyStorage();
    return true;
  };

  const removePayload = async (submissionId: string) => {
    memoryPayloads.delete(submissionId);
    try {
      await payloadStore.remove(submissionId);
    } catch {
      // 清理失败不应阻断成功发送；TTL 与提交 id 会阻止旧载荷再被读取。
    }
  };

  const readClaims = (): PendingSubmissionClaim[] => {
    try {
      return parseSubmissionClaims(
        claimStorage.getItem(PENDING_SUBMISSION_CLAIM_STORAGE_KEY),
      );
    } catch {
      return [];
    }
  };

  const writeClaims = (claims: PendingSubmissionClaim[]): boolean => {
    try {
      claimStorage.setItem(
        PENDING_SUBMISSION_CLAIM_STORAGE_KEY,
        JSON.stringify({
          version: 1,
          claims: claims
            .sort((left, right) => left.expiresAt - right.expiresAt)
            .slice(-32),
        } satisfies PendingSubmissionClaimRegistry),
      );
      return true;
    } catch {
      return false;
    }
  };

  const releaseOwnedClaim = (submissionId: string): void => {
    const claims = readClaims();
    const next = claims.filter(
      (claim) =>
        claim.submissionId !== submissionId ||
        claim.ownerId !== claimOwnerId,
    );
    if (next.length !== claims.length) writeClaims(next);
  };

  const completeOwnedClaim = (
    submissionId: string,
    expiresAt: number,
  ): void => {
    const claims = readClaims();
    let updated = false;
    const next = claims.map((claim) => {
      if (
        claim.submissionId !== submissionId ||
        claim.ownerId !== claimOwnerId
      ) {
        return claim;
      }
      updated = true;
      return { ...claim, expiresAt: Math.max(claim.expiresAt, expiresAt) };
    });
    if (updated) writeClaims(next);
  };

  const clear = async (submissionId?: string): Promise<boolean> => {
    const current = readMetadata();
    if (
      submissionId !== undefined &&
      current?.submissionId !== submissionId
    ) {
      return false;
    }
    const ownedId = current?.submissionId ?? submissionId;
    if (ownedId && current) {
      await withCrossTabLock({
        name: PENDING_SUBMISSION_CLAIM_LOCK_NAME,
        lockManager,
        unavailable: undefined,
        run: () => completeOwnedClaim(ownedId, current.expiresAt),
      });
    }
    if (!clearMetadata(submissionId)) return false;
    if (ownedId) await removePayload(ownedId);
    return true;
  };

  const currentMetadata = (): StoredPendingSubmission | null => {
    const metadata = readMetadata();
    if (!metadata) return null;
    if (metadata.expiresAt > now()) return metadata;
    void clear(metadata.submissionId);
    return null;
  };

  return {
    async create(submissionInput) {
      const previous = readMetadata();
      const payload: PendingPayload = {
        attachments: submissionInput.attachments,
        folderSource: submissionInput.folderSource,
      };
      memoryPayloads.clear();
      memoryPayloads.set(submissionInput.submissionId, payload);

      const createdAt = now();
      const metadata: StoredPendingSubmission = {
        version: 2,
        submissionId: submissionInput.submissionId,
        clientMessageId: submissionInput.clientMessageId,
        createdAt,
        expiresAt: createdAt + PENDING_SUBMISSION_TTL_MS,
        state: "queued",
        targetSessionId: null,
        text: submissionInput.text,
        richText: submissionInput.richText,
        chips: submissionInput.chips,
        skills: submissionInput.skills,
        attachments: submissionInput.attachments.map(attachmentDescriptor),
        // 元数据必须在任何 await 前同步落盘。刷新若发生在 IDB 写入窗口，
        // 新页面仍能恢复文字与缺失描述，并进入明确 degraded 交接。
        attachmentsPersisted: submissionInput.attachments.length === 0,
        uploadedAssets: [],
        folderExpected: submissionInput.folderSource !== null,
        folderPersisted: submissionInput.folderSource === null,
        folderAttached: false,
      };
      const metadataPersisted = writeMetadata(metadata);
      removeLegacyStorage();

      if (
        previous &&
        previous.submissionId !== submissionInput.submissionId
      ) {
        await removePayload(previous.submissionId);
      }

      let persisted: PendingPayloadSaveResult = {
        attachments: submissionInput.attachments.length === 0,
        folder: submissionInput.folderSource === null,
      };
      try {
        persisted = await payloadStore.save(
          submissionInput.submissionId,
          payload,
        );
      } catch {
        // 同一 SPA 内继续使用内存载荷；刷新后 load() 会进入 degraded。
      }

      const latest = readMetadata();
      if (latest?.submissionId === submissionInput.submissionId) {
        writeMetadata({
          ...latest,
          attachmentsPersisted: persisted.attachments,
          folderPersisted: persisted.folder,
        });
      }
      return {
        durable:
          metadataPersisted &&
          persisted.attachments &&
          persisted.folder,
        submissionId: submissionInput.submissionId,
      };
    },

    async load() {
      const metadata = readMetadata();
      if (!metadata) return { kind: "none" };
      if (metadata.expiresAt <= now()) {
        await clear(metadata.submissionId);
        return { kind: "expired" };
      }

      let payload = memoryPayloads.get(metadata.submissionId) ?? null;
      if (!payload) {
        try {
          const storedPayload = await payloadStore.load(
            metadata.submissionId,
          );
          if (storedPayload) {
            payload = {
              attachments: storedPayload.attachments ?? [],
              folderSource: storedPayload.folderSource ?? null,
            };
          }
        } catch {
          // 下方按缺失载荷走 degraded，禁止静默发送。
        }
      }

      const filesById = new Map(
        (payload?.attachments ?? []).map((attachment) => [
          attachment.id,
          attachment.file,
        ]),
      );
      const uploadedById = new Map(
        metadata.uploadedAssets.map((asset) => [
          asset.attachmentId,
          asset,
        ]),
      );
      const missingAttachmentIds = new Set<string>();
      const attachments = metadata.attachments.map((descriptor) => {
        const uploadedAsset = uploadedById.get(descriptor.id) ?? null;
        const candidate = filesById.get(descriptor.id);
        const file =
          candidate && fileMatchesDescriptor(candidate, descriptor)
            ? candidate
            : null;
        if (!uploadedAsset && !file) {
          missingAttachmentIds.add(descriptor.id);
        }
        return { id: descriptor.id, file, uploadedAsset };
      });
      const persistedFolderSource =
        metadata.folderExpected && !metadata.folderAttached
          ? payload?.folderSource ?? null
          : null;
      const folderSource =
        persistedFolderSource?.provider === "desktop-local" &&
        now() - persistedFolderSource.selectedAt >
          PENDING_DESKTOP_FOLDER_TOKEN_TTL_MS
          ? null
          : persistedFolderSource;
      const folderMissing =
        metadata.folderExpected &&
        !metadata.folderAttached &&
        folderSource === null;

      if (missingAttachmentIds.size === 0 && !folderMissing) {
        return {
          kind: "ready",
          submission: toSubmission(metadata, attachments, folderSource),
        };
      }

      const sanitized = sanitizeMissingAttachmentChips(
        metadata.chips,
        metadata.richText,
        missingAttachmentIds,
      );
      const remainingAttachments = attachments.filter(
        (attachment) => !missingAttachmentIds.has(attachment.id),
      );
      const degradedMetadata: StoredPendingSubmission = {
        ...metadata,
        richText: sanitized.richText,
        chips: sanitized.chips,
        attachments: metadata.attachments.filter(
          (descriptor) => !missingAttachmentIds.has(descriptor.id),
        ),
        uploadedAssets: metadata.uploadedAssets.filter(
          (asset) => !missingAttachmentIds.has(asset.attachmentId),
        ),
        folderExpected: folderMissing ? false : metadata.folderExpected,
        folderPersisted: folderMissing ? true : metadata.folderPersisted,
      };

      return {
        kind: "degraded",
        submission: toSubmission(
          degradedMetadata,
          remainingAttachments,
          folderSource,
        ),
        missingAttachmentCount: missingAttachmentIds.size,
        folderMissing,
      };
    },

    peekState() {
      const metadata = currentMetadata();
      return metadata
        ? {
            submissionId: metadata.submissionId,
            state: metadata.state,
          }
        : null;
    },

    async claim(submissionId, workspaceSessionId, allowedStates) {
      const claim = () => {
        const metadata = currentMetadata();
        if (
          !metadata ||
          metadata.submissionId !== submissionId ||
          !allowedStates.includes(metadata.state)
        ) {
          return false;
        }
        if (
          metadata.targetSessionId !== null
            ? metadata.targetSessionId !== workspaceSessionId
            : workspaceSessionId !== null
        ) {
          return false;
        }
        const claims = readClaims().filter(
          (item) => item.expiresAt > now(),
        );
        if (claims.some(
          (item) => item.submissionId === submissionId,
        )) {
          return false;
        }
        if (!writeClaims([...claims, {
          submissionId,
          ownerId: claimOwnerId,
          expiresAt: now() + PENDING_SUBMISSION_CLAIM_LEASE_MS,
        }])) {
          return false;
        }
        writeMetadata({ ...metadata, state: "dispatching" });
        return true;
      };
      // Web Locks 缺失时 browserCrossTabLockManager 会使用 localStorage
      // 租约；localStorage 也受限时仍执行当前标签的首提，由服务端持久幂等兜底。
      if (!lockManager) return claim();
      return withCrossTabLock({
        name: PENDING_SUBMISSION_CLAIM_LOCK_NAME,
        lockManager,
        unavailable: false,
        run: claim,
      });
    },

    bindToSession(submissionId, sessionId) {
      const metadata = currentMetadata();
      if (
        !metadata ||
        metadata.submissionId !== submissionId ||
        (metadata.targetSessionId !== null &&
          metadata.targetSessionId !== sessionId)
      ) {
        return false;
      }
      writeMetadata({ ...metadata, targetSessionId: sessionId });
      return true;
    },

    async markRetryable(submissionId) {
      const metadata = currentMetadata();
      if (!metadata || metadata.submissionId !== submissionId) return false;
      writeMetadata({ ...metadata, state: "retryable" });
      await withCrossTabLock({
        name: PENDING_SUBMISSION_CLAIM_LOCK_NAME,
        lockManager,
        unavailable: undefined,
        run: () => releaseOwnedClaim(submissionId),
      });
      return true;
    },

    updateProgress(submissionId, update) {
      const metadata = currentMetadata();
      if (!metadata || metadata.submissionId !== submissionId) return false;
      writeMetadata({
        ...metadata,
        ...(update.uploadedAssets
          ? { uploadedAssets: update.uploadedAssets }
          : {}),
        ...(update.folderAttached !== undefined
          ? { folderAttached: update.folderAttached }
          : {}),
      });
      return true;
    },

    clear,
  };
}

function createSingleContextLockManager(): CrossTabLockManager {
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
          name: PENDING_SUBMISSION_CLAIM_LOCK_NAME,
          mode: "exclusive",
        });
      } finally {
        release();
      }
    },
  };
}

function openPendingDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const request = indexedDB.open(PENDING_DB_NAME, PENDING_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PENDING_DB_STORE)) {
        database.createObjectStore(PENDING_DB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

async function putPendingPayloadValue(
  key: string,
  value: unknown,
): Promise<void> {
  const database = await openPendingDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(PENDING_DB_STORE, "readwrite");
      transaction.objectStore(PENDING_DB_STORE).put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("IndexedDB write failed"));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("IndexedDB write aborted"));
    });
  } finally {
    database.close();
  }
}

async function getPendingPayloadValue<T>(key: string): Promise<T | null> {
  const database = await openPendingDatabase();
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const transaction = database.transaction(PENDING_DB_STORE, "readonly");
      const request = transaction.objectStore(PENDING_DB_STORE).get(key);
      request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
      request.onerror = () =>
        reject(request.error ?? new Error("IndexedDB read failed"));
    });
  } finally {
    database.close();
  }
}

async function deletePendingPayloadValue(key: string): Promise<void> {
  const database = await openPendingDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(PENDING_DB_STORE, "readwrite");
      transaction.objectStore(PENDING_DB_STORE).delete(key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("IndexedDB delete failed"));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("IndexedDB delete aborted"));
    });
  } finally {
    database.close();
  }
}

const indexedDbPayloadStore: PendingPayloadStore = {
  async save(submissionId, payload) {
    const attachmentsKey = `${submissionId}:attachments`;
    const folderKey = `${submissionId}:folder`;
    const attachments =
      payload.attachments.length === 0 ||
      (await putPendingPayloadValue(
        attachmentsKey,
        payload.attachments,
      ).then(
        () => true,
        () => false,
      ));
    const folder =
      payload.folderSource === null ||
      (await putPendingPayloadValue(folderKey, payload.folderSource).then(
        () => true,
        () => false,
      ));
    return { attachments, folder };
  },

  async load(submissionId) {
    const [attachments, folderSource] = await Promise.all([
      getPendingPayloadValue<PendingAttachmentInput[]>(
        `${submissionId}:attachments`,
      ).catch(() => null),
      getPendingPayloadValue<PendingFolderSource>(
        `${submissionId}:folder`,
      ).catch(() => null),
    ]);
    if (!attachments && !folderSource) return null;
    return {
      attachments: attachments ?? [],
      folderSource,
    };
  },

  async remove(submissionId) {
    await Promise.all([
      deletePendingPayloadValue(`${submissionId}:attachments`).catch(
        () => undefined,
      ),
      deletePendingPayloadValue(`${submissionId}:folder`).catch(
        () => undefined,
      ),
    ]);
  },
};

const browserSessionStorage: PendingSessionStorage = {
  getItem(key) {
    return typeof sessionStorage === "undefined"
      ? null
      : sessionStorage.getItem(key);
  },
  setItem(key, value) {
    if (typeof sessionStorage === "undefined") {
      throw new Error("sessionStorage unavailable");
    }
    sessionStorage.setItem(key, value);
  },
  removeItem(key) {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem(key);
    }
  },
};

const browserLocalStorage: PendingSessionStorage = {
  getItem(key) {
    return typeof localStorage === "undefined"
      ? null
      : localStorage.getItem(key);
  },
  setItem(key, value) {
    if (typeof localStorage === "undefined") {
      throw new Error("localStorage unavailable");
    }
    localStorage.setItem(key, value);
  },
  removeItem(key) {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(key);
    }
  },
};

const pendingSubmissionManager = createPendingSubmissionManager({
  storage: browserSessionStorage,
  payloadStore: indexedDbPayloadStore,
  claimStorage: browserLocalStorage,
});

export const createPendingSubmission =
  pendingSubmissionManager.create.bind(pendingSubmissionManager);
export const loadPendingSubmission =
  pendingSubmissionManager.load.bind(pendingSubmissionManager);
export const peekPendingSubmissionState =
  pendingSubmissionManager.peekState.bind(pendingSubmissionManager);
export const claimPendingSubmission =
  pendingSubmissionManager.claim.bind(pendingSubmissionManager);
export const bindPendingSubmissionToSession =
  pendingSubmissionManager.bindToSession.bind(pendingSubmissionManager);
export const markPendingSubmissionRetryable =
  pendingSubmissionManager.markRetryable.bind(pendingSubmissionManager);
export const updatePendingSubmissionProgress =
  pendingSubmissionManager.updateProgress.bind(pendingSubmissionManager);
export const clearPendingSubmission =
  pendingSubmissionManager.clear.bind(pendingSubmissionManager);
