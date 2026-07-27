export interface CrossTabLockManager {
  request<T>(
    name: string,
    options: {
      mode: "exclusive";
      ifAvailable?: boolean;
    },
    callback: (
      lock: { name: string; mode: "exclusive" | "shared" } | null,
    ) => T | PromiseLike<T>,
  ): Promise<T>;
}

export interface CrossTabLeaseStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface CrossTabStorageEventSource {
  addEventListener(
    type: "storage",
    listener: (event: { key: string | null }) => void,
  ): void;
  removeEventListener(
    type: "storage",
    listener: (event: { key: string | null }) => void,
  ): void;
}

interface CrossTabLease {
  version: 1;
  ownerId: string;
  expiresAt: number;
}

export const CROSS_TAB_LEASE_MS = 15_000;
export const CROSS_TAB_LEASE_HEARTBEAT_MS = 5_000;
const CROSS_TAB_LEASE_RETRY_MS = 50;
const CROSS_TAB_LEASE_SETTLE_MS = 16;
const CROSS_TAB_LEASE_KEY_PREFIX = "qingagent:cross-tab-lease:v1:";

type StopHeartbeat = () => void;

export interface LocalStorageLeaseLockOptions {
  storage: CrossTabLeaseStorage;
  eventSource?: CrossTabStorageEventSource;
  now?: () => number;
  leaseMs?: number;
  heartbeatMs?: number;
  retryMs?: number;
  settleMs?: number;
  createOwnerId?: () => string;
  startHeartbeat?: (
    callback: () => void,
    intervalMs: number,
  ) => StopHeartbeat;
}

function createLockOwnerId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `lease-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function crossTabLeaseStorageKey(name: string): string {
  return `${CROSS_TAB_LEASE_KEY_PREFIX}${encodeURIComponent(name)}`;
}

function parseLease(raw: string | null): CrossTabLease | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<CrossTabLease>;
    return value.version === 1 &&
      typeof value.ownerId === "string" &&
      value.ownerId.length > 0 &&
      typeof value.expiresAt === "number" &&
      Number.isFinite(value.expiresAt)
      ? value as CrossTabLease
      : null;
  } catch {
    return null;
  }
}

function defaultStartHeartbeat(
  callback: () => void,
  intervalMs: number,
): StopHeartbeat {
  const timer = setInterval(callback, intervalMs);
  return () => clearInterval(timer);
}

function createSingleContextLockManager(): CrossTabLockManager {
  let tail = Promise.resolve();
  return {
    async request<T>(
      name: string,
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
        return await callback({ name, mode: "exclusive" });
      } finally {
        release();
      }
    },
  };
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function waitForStorageChange(input: {
  eventSource?: CrossTabStorageEventSource;
  key: string;
  retryMs: number;
}): Promise<void> {
  const eventSource = input.eventSource;
  if (!eventSource) return sleep(input.retryMs);
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      eventSource.removeEventListener("storage", onStorage);
      resolve();
    };
    const onStorage = (event: { key: string | null }) => {
      if (event.key === input.key || event.key === null) finish();
    };
    const timer = setTimeout(finish, input.retryMs);
    eventSource.addEventListener("storage", onStorage);
  });
}

/**
 * Web Locks 缺失时的跨标签租约锁。
 *
 * localStorage 的写入对同源标签可见；申请者写入 ownerId + expiresAt 后再确认
 * 自己仍是持有者。持有期间心跳续租，正常结束仅删除自己的租约；标签崩溃后，
 * 其他申请者可在 expiresAt 后接管。storage 事件只负责及时唤醒，轮询兜底避免
 * 浏览器漏发事件时永久等待。
 */
export function createLocalStorageLeaseLockManager(
  options: LocalStorageLeaseLockOptions,
): CrossTabLockManager {
  const now = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? CROSS_TAB_LEASE_MS;
  const heartbeatMs =
    options.heartbeatMs ?? CROSS_TAB_LEASE_HEARTBEAT_MS;
  const retryMs = options.retryMs ?? CROSS_TAB_LEASE_RETRY_MS;
  const settleMs = options.settleMs ?? CROSS_TAB_LEASE_SETTLE_MS;
  const createOwnerId = options.createOwnerId ?? createLockOwnerId;
  const startHeartbeat =
    options.startHeartbeat ?? defaultStartHeartbeat;
  const singleContextFallback = createSingleContextLockManager();

  const readLease = (
    key: string,
  ): { kind: "ok"; lease: CrossTabLease | null } | {
    kind: "unavailable";
  } => {
    try {
      return { kind: "ok", lease: parseLease(options.storage.getItem(key)) };
    } catch {
      return { kind: "unavailable" };
    }
  };

  const writeLease = (key: string, lease: CrossTabLease): boolean => {
    try {
      options.storage.setItem(key, JSON.stringify(lease));
      return true;
    } catch {
      return false;
    }
  };

  return {
    async request<T>(
      name: string,
      requestOptions: { mode: "exclusive"; ifAvailable?: boolean },
      callback: (
        lock: { name: string; mode: "exclusive" | "shared" } | null,
      ) => T | PromiseLike<T>,
    ): Promise<T> {
      const key = crossTabLeaseStorageKey(name);
      const ownerId = createOwnerId();

      for (;;) {
        const current = readLease(key);
        if (current.kind === "unavailable") {
          // localStorage 也受限时至少保留当前标签内的串行发送；跨标签重复由
          // 服务端持久幂等兜住，不能把旧浏览器直接堵死。
          return singleContextFallback.request(
            name,
            requestOptions,
            callback,
          );
        }
        if (current.lease && current.lease.expiresAt > now()) {
          if (requestOptions.ifAvailable) return callback(null);
          await waitForStorageChange({
            eventSource: options.eventSource,
            key,
            retryMs: Math.min(
              retryMs,
              Math.max(1, current.lease.expiresAt - now()),
            ),
          });
          continue;
        }

        const lease: CrossTabLease = {
          version: 1,
          ownerId,
          expiresAt: now() + leaseMs,
        };
        if (!writeLease(key, lease)) {
          return singleContextFallback.request(
            name,
            requestOptions,
            callback,
          );
        }
        if (settleMs > 0) await sleep(settleMs);
        const confirmed = readLease(key);
        if (confirmed.kind === "unavailable") {
          return singleContextFallback.request(
            name,
            requestOptions,
            callback,
          );
        }
        if (confirmed.lease?.ownerId !== ownerId) {
          if (requestOptions.ifAvailable) return callback(null);
          await waitForStorageChange({
            eventSource: options.eventSource,
            key,
            retryMs,
          });
          continue;
        }

        const renew = () => {
          const owned = readLease(key);
          if (
            owned.kind !== "ok" ||
            owned.lease?.ownerId !== ownerId
          ) {
            return;
          }
          writeLease(key, {
            ...owned.lease,
            expiresAt: Math.max(
              owned.lease.expiresAt,
              now() + leaseMs,
            ),
          });
        };
        const stopHeartbeat = startHeartbeat(renew, heartbeatMs);
        try {
          return await callback({ name, mode: "exclusive" });
        } finally {
          stopHeartbeat();
          const owned = readLease(key);
          if (
            owned.kind === "ok" &&
            owned.lease?.ownerId === ownerId
          ) {
            try {
              options.storage.removeItem(key);
            } catch {
              // 租约有到期时间，清理失败也不会永久锁死。
            }
          }
        }
      }
    },
  };
}

function browserStorageEventSource(): CrossTabStorageEventSource | undefined {
  if (typeof window === "undefined") return undefined;
  return {
    addEventListener(type, listener) {
      window.addEventListener(
        type,
        listener as unknown as EventListener,
      );
    },
    removeEventListener(type, listener) {
      window.removeEventListener(
        type,
        listener as unknown as EventListener,
      );
    },
  };
}

export function browserCrossTabLockManager(input?: {
  leaseStorage?: CrossTabLeaseStorage;
}): CrossTabLockManager | null {
  let nativeManager: CrossTabLockManager | null = null;
  try {
    if (
      typeof navigator !== "undefined" &&
      typeof navigator.locks?.request === "function"
    ) {
      nativeManager = navigator.locks as unknown as CrossTabLockManager;
    }
  } catch {
    nativeManager = null;
  }
  const leaseManager = input?.leaseStorage
    ? createLocalStorageLeaseLockManager({
        storage: input.leaseStorage,
        eventSource: browserStorageEventSource(),
      })
    : null;
  if (!nativeManager) return leaseManager;
  if (!leaseManager) return nativeManager;
  return {
    async request<T>(
      name: string,
      options: { mode: "exclusive"; ifAvailable?: boolean },
      callback: (
        lock: { name: string; mode: "exclusive" | "shared" } | null,
      ) => T | PromiseLike<T>,
    ): Promise<T> {
      let callbackStarted = false;
      try {
        return await nativeManager.request(name, options, (lock) => {
          callbackStarted = true;
          return callback(lock);
        });
      } catch (error) {
        if (callbackStarted) throw error;
        return leaseManager.request(name, options, callback);
      }
    },
  };
}

export async function withCrossTabLock<T>(input: {
  name: string;
  lockManager: CrossTabLockManager | null;
  ifAvailable?: boolean;
  unavailable: T;
  run: () => T | PromiseLike<T>;
}): Promise<T> {
  if (!input.lockManager) return input.unavailable;
  try {
    return await input.lockManager.request(
      input.name,
      {
        mode: "exclusive",
        ...(input.ifAvailable ? { ifAvailable: true } : {}),
      },
      async (lock) => {
        if (!lock) return input.unavailable;
        return input.run();
      },
    );
  } catch {
    return input.unavailable;
  }
}
