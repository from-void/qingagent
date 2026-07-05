import { describe, expect, it, vi } from "vitest";
import type { ServerStream } from "../serverStream";
import { ensureSessionIdOnce, startNewSessionOnce, workspaceHashWithSession } from "../sessionLifecycle";
import { initialWorkspaceState } from "../workspaceState";

describe("ensureSessionIdOnce", () => {
  it("starts a session once and reuses it while docState is still init", async () => {
    const sendCommand = vi.fn().mockResolvedValue(undefined);
    const stream = {
      startSession: vi.fn().mockResolvedValue("session-A"),
      sendCommand,
    } as unknown as ServerStream;
    const stateRef = { current: initialWorkspaceState };
    const sessionIdRef = { current: null as string | null };
    const startSessionPromiseRef = { current: null as Promise<string> | null };

    const firstSessionId = await ensureSessionIdOnce(
      stream,
      stateRef,
      sessionIdRef,
      startSessionPromiseRef,
    );
    await stream.sendCommand({
      kind: "sendMessage",
      data: {
        sessionId: firstSessionId,
        text: "first",
        mentions: [],
        skills: [],
        chips: [],
        fileIds: [],
      },
    });

    const secondSessionId = await ensureSessionIdOnce(
      stream,
      stateRef,
      sessionIdRef,
      startSessionPromiseRef,
    );
    await stream.sendCommand({
      kind: "sendMessage",
      data: {
        sessionId: secondSessionId,
        text: "second",
        mentions: [],
        skills: [],
        chips: [],
        fileIds: [],
      },
    });

    expect(stream.startSession).toHaveBeenCalledTimes(1);
    expect(firstSessionId).toBe("session-A");
    expect(secondSessionId).toBe("session-A");
    expect(
      new Set(sendCommand.mock.calls.map(([command]) => command.data.sessionId)),
    ).toEqual(new Set(["session-A"]));
  });

  it("coalesces concurrent callers and clears failed starts for retry", async () => {
    const stream = {
      startSession: vi
        .fn()
        .mockRejectedValueOnce(new Error("network"))
        .mockResolvedValueOnce("session-B"),
    } as unknown as ServerStream;
    const stateRef = { current: initialWorkspaceState };
    const sessionIdRef = { current: null as string | null };
    const startSessionPromiseRef = { current: null as Promise<string> | null };

    await expect(
      Promise.all([
        ensureSessionIdOnce(
          stream,
          stateRef,
          sessionIdRef,
          startSessionPromiseRef,
        ),
        ensureSessionIdOnce(
          stream,
          stateRef,
          sessionIdRef,
          startSessionPromiseRef,
        ),
      ]),
    ).rejects.toThrow("network");

    expect(stream.startSession).toHaveBeenCalledTimes(1);
    expect(startSessionPromiseRef.current).toBeNull();

    await expect(
      ensureSessionIdOnce(
        stream,
        stateRef,
        sessionIdRef,
        startSessionPromiseRef,
      ),
    ).resolves.toBe("session-B");
    expect(stream.startSession).toHaveBeenCalledTimes(2);
  });

  it("startSession 成功后回调一次,用于把新 session 写回 URL", async () => {
    const stream = {
      startSession: vi.fn().mockResolvedValue("session-C"),
    } as unknown as ServerStream;
    const stateRef = { current: initialWorkspaceState };
    const sessionIdRef = { current: null as string | null };
    const startSessionPromiseRef = { current: null as Promise<string> | null };
    const onSessionReady = vi.fn();

    await ensureSessionIdOnce(
      stream,
      stateRef,
      sessionIdRef,
      startSessionPromiseRef,
      onSessionReady,
    );
    await ensureSessionIdOnce(
      stream,
      stateRef,
      sessionIdRef,
      startSessionPromiseRef,
      onSessionReady,
    );

    expect(onSessionReady).toHaveBeenCalledTimes(1);
    expect(onSessionReady).toHaveBeenCalledWith("session-C");
  });

  it("pending-message 预先写入 start promise 后，ensureSessionId 复用同一个会话", async () => {
    let release!: (sessionId: string) => void;
    const pendingSession = new Promise<string>((resolve) => {
      release = resolve;
    });
    const stream = {
      startSession: vi.fn().mockReturnValue(pendingSession),
    } as unknown as ServerStream;
    const stateRef = { current: initialWorkspaceState };
    const sessionIdRef = { current: null as string | null };
    const startSessionPromiseRef = { current: null as Promise<string> | null };
    const onSessionReady = vi.fn();

    const pendingPath = startNewSessionOnce(
      stream,
      sessionIdRef,
      startSessionPromiseRef,
      onSessionReady,
    );
    const attachPath = ensureSessionIdOnce(
      stream,
      stateRef,
      sessionIdRef,
      startSessionPromiseRef,
      onSessionReady,
    );
    release("session-pending");

    await expect(Promise.all([pendingPath, attachPath])).resolves.toEqual([
      "session-pending",
      "session-pending",
    ]);
    expect(stream.startSession).toHaveBeenCalledTimes(1);
    expect(sessionIdRef.current).toBe("session-pending");
    expect(onSessionReady).toHaveBeenCalledTimes(1);
  });

  it("workspaceHashWithSession 保留 overlay 段并不覆盖 existing session", () => {
    expect(workspaceHashWithSession("#/workspace", "s-new")).toBe("#/workspace?session=s-new");
    expect(workspaceHashWithSession("#/workspace;modal-import", "s-new")).toBe(
      "#/workspace?session=s-new;modal-import",
    );
    expect(workspaceHashWithSession("#/workspace?session=s-old", "s-new")).toBe(
      "#/workspace?session=s-old",
    );
  });
});
