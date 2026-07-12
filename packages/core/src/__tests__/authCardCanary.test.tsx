// @vitest-environment jsdom
// @ts-nocheck -- 跨 package 金丝雀故意走真实 server/web 源码，不把 React 变成 core 运行依赖。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React, { act } from "../../../../apps/web/node_modules/react/index.js";
import { createRoot } from "../../../../apps/web/node_modules/react-dom/client.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const { memory, threads, logger } = vi.hoisted(() => {
  const threads = new Map<string, Record<string, unknown>>();
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const memory = {
    getThreadById: vi.fn(async ({ threadId }: { threadId: string }) => threads.get(threadId) ?? null),
    recall: vi.fn(async () => ({ messages: [] })),
    updateThread: vi.fn(async () => undefined),
  };
  return { memory, threads, logger };
});

vi.mock("../mastra.js", () => ({
  mastra: { getLogger: () => logger, getMemory: () => memory, getAgent: () => ({}) },
  getObservability: () => ({ getDefaultInstance: () => null }),
}));
vi.mock("../agent-run/agentSpans.js", () => ({ sessionIdToTraceId: (id: string) => `trace-${id}` }));
vi.mock("@qingagent/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@qingagent/db")>()),
  documentRepo: { load: vi.fn(async () => null) },
}));

import { loadSessionFromThread } from "../session/threadPersistence.js";
import { emitRestoreFrames } from "../../../server/src/gateway/bridgeHandler.js";
import { validateBridgeFrame } from "../../../../apps/web/src/system/validators/wireFrame.js";
import { AuthCard } from "../../../../apps/web/src/pages/workspace/components/AuthCard.js";
import { chatInputBus } from "../../../../apps/web/src/system/chatInputBus.js";

afterEach(() => {
  threads.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AuthCard v1 restore 金丝雀", () => {
  it("chatHistory → loadSessionFromThread → emitRestoreFrames → validator → DOM，旧操作仍幂等", async () => {
    vi.useFakeTimers();
    const fixture = JSON.parse(readFileSync(
      resolve(process.cwd(), "src/__tests__/fixtures/auth-card-v1-chat-history.json"),
      "utf8",
    ));
    threads.set("auth-card-v1", {
      id: "auth-card-v1",
      resourceId: "qingagent-user",
      title: "旧卡会话",
      createdAt: new Date("2026-07-11T12:00:00.000Z"),
      updatedAt: new Date("2026-07-11T12:00:00.000Z"),
      metadata: {
        docId: "auth-card-v1",
        docState: { kind: "empty" },
        docVersion: 0,
        legacySections: [],
        materials: [],
        folderSources: [],
        chatHistory: fixture,
      },
    });

    const restored = await loadSessionFromThread("auth-card-v1");
    expect(restored).not.toBeNull();
    const frames = [...emitRestoreFrames(restored!)];
    for (const frame of frames) expect(() => validateBridgeFrame(frame)).not.toThrow();
    const qrBodies = frames
      .filter((frame) => frame.kind === "chatMessageAdded")
      .flatMap((frame) => frame.data.message.parts)
      .filter((part) => part.kind === "toolCall" && part.data.body.kind === "qrCard")
      .map((part) => part.data.body.data);
    expect(qrBodies).toHaveLength(2);
    expect(qrBodies.every((body) => body.connectorId === undefined && body.pendingId === undefined)).toBe(true);

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const send = vi.spyOn(chatInputBus, "send").mockImplementation(() => undefined);
    act(() => root.render(React.createElement(
      React.Fragment,
      null,
      ...qrBodies.map((body, index) => React.createElement(AuthCard, { key: index, data: body })),
    )));
    expect(host.querySelectorAll('[data-component="AuthCard"]')).toHaveLength(2);

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    const confirm = host.querySelector<HTMLButtonElement>(".qr-card__confirm")!;
    const refresh = host.querySelector<HTMLButtonElement>(".qr-card__refresh")!;
    act(() => { confirm.click(); confirm.click(); refresh.click(); refresh.click(); });
    expect(send.mock.calls).toEqual([
      ["我已完成旧版授权"],
      ["请刷新旧授权卡"],
    ]);

    act(() => root.unmount());
    host.remove();
  });
});
