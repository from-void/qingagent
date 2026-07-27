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

export function browserCrossTabLockManager(): CrossTabLockManager | null {
  try {
    if (
      typeof navigator === "undefined" ||
      typeof navigator.locks?.request !== "function"
    ) {
      return null;
    }
    return navigator.locks as unknown as CrossTabLockManager;
  } catch {
    return null;
  }
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
