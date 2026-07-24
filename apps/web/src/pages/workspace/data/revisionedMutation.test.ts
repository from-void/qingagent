import { describe, expect, it, vi } from "vitest";
import { RevisionedMutationCoordinator } from "./revisionedMutation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("RevisionedMutationCoordinator", () => {
  it("同 key 单飞，失败只回滚本 revision 的完整快照", async () => {
    const coordinator = new RevisionedMutationCoordinator();
    const request = deferred<void>();
    let state = { summary: "旧摘要", metadata: { fileId: "f-1" } };
    const snapshot = state;
    const rollback = vi.fn((value: typeof state) => {
      state = value;
    });

    const first = coordinator.tryRun("resource:file:m-1", {
      capture: () => state,
      applyOptimistic: () => {
        state = { ...state, summary: "新摘要" };
      },
      commit: () => request.promise,
      rollback,
    });
    const duplicate = coordinator.tryRun("resource:file:m-1", {
      capture: () => state,
      applyOptimistic: vi.fn(),
      commit: async () => undefined,
      rollback: vi.fn(),
    });

    expect(first).not.toBeNull();
    expect(duplicate).toBeNull();
    expect(state).toEqual({ summary: "新摘要", metadata: { fileId: "f-1" } });
    request.reject(new Error("network down"));
    await expect(first!.promise).rejects.toThrow("network down");
    expect(rollback).toHaveBeenCalledWith(snapshot);
    expect(state).toBe(snapshot);
  });

  it("权威帧推进 revision 后，迟到失败不得覆盖权威状态", async () => {
    const coordinator = new RevisionedMutationCoordinator();
    const request = deferred<void>();
    let state = "old";
    const rollback = vi.fn((snapshot: string) => {
      state = snapshot;
    });
    const handle = coordinator.tryRun("annotation:s-1:g-1", {
      capture: () => state,
      applyOptimistic: () => {
        state = "ignored-local";
      },
      commit: () => request.promise,
      rollback,
    })!;

    coordinator.reconcile("annotation:s-1:g-1");
    state = "ignored-authoritative";
    request.reject(new Error("late proxy error"));

    await expect(handle.promise).rejects.toThrow("late proxy error");
    expect(rollback).not.toHaveBeenCalled();
    expect(state).toBe("ignored-authoritative");
  });

  it("无乐观态请求复用在途 promise，避免 ask-more 双发", async () => {
    const coordinator = new RevisionedMutationCoordinator();
    const request = deferred<number>();
    const commit = vi.fn(() => request.promise);
    const first = coordinator.run("ask-more:s-1:ask-1", commit);
    const second = coordinator.run("ask-more:s-1:ask-1", commit);

    request.resolve(2);
    await expect(Promise.all([first, second])).resolves.toEqual([2, 2]);
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
