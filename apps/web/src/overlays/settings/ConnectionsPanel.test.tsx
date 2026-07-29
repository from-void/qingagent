// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorId, ConnectorInfo, ConnectorState, QrCardBody } from "@qingagent/contract-ts";

const h = vi.hoisted(() => ({
  capabilities: { connectors: { mutationEnabled: true, reasonCode: null } } as Record<string, unknown>,
  connectors: [] as ConnectorInfo[],
  pendingSessions: {} as Partial<Record<ConnectorId, {
    connectorId: ConnectorId;
    pendingId: string;
    startedAt: number;
    card: QrCardBody;
  }>>,
  pendingListeners: new Set<() => void>(),
  loading: false,
  probe: vi.fn(),
  disconnect: vi.fn(),
  cancel: vi.fn(),
  start: vi.fn(),
  refresh: vi.fn(),
  toast: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("../../system", () => ({
  useClientCapabilities: () => h.capabilities,
  useConfirm: () => h.confirm,
}));
vi.mock("../../system/ToastProvider", () => ({ useToast: () => ({ show: h.toast }) }));
vi.mock("./connectorAuthSession", () => ({
  saveConnectorAuthSession: vi.fn((session) => {
    h.pendingSessions = { ...h.pendingSessions, [session.connectorId]: session };
    for (const listener of h.pendingListeners) listener();
  }),
}));
vi.mock("./useConnectors", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useConnectors: () => ({
      connectors: h.connectors,
      pendingSessions: useSyncExternalStore(
        (listener) => {
          h.pendingListeners.add(listener);
          return () => h.pendingListeners.delete(listener);
        },
        () => h.pendingSessions,
        () => h.pendingSessions,
      ),
      loading: h.loading,
      error: null,
      refresh: h.refresh,
      start: h.start,
      cancel: h.cancel,
      probe: h.probe,
      disconnect: h.disconnect,
    }),
  };
});

import { ConnectionsPanel, mapConnectorStart } from "./ConnectionsPanel";

let host: HTMLDivElement;
let root: Root;

function connector(state: ConnectorState, reasonCode: string | null = null): ConnectorInfo {
  return {
    id: "feishu", name: "飞书", icon: "feishu", official: true, riskNote: null,
    authPresentation: "scan",
    usedBySkills: ["feishu"],
    status: {
      state, reasonCode, account: null, scopes: [], lastCheckedAt: null,
      statusFreshness: "fresh", canProbe: state === "connected" || state === "needs_reauth",
    },
  };
}

function github(state: ConnectorState, reasonCode: string | null = null): ConnectorInfo {
  return { ...connector(state), id: "github", name: "GitHub", icon: "github", authPresentation: "device-code", usedBySkills: ["github-materials"], status: { ...connector(state).status, reasonCode, account: state === "connected" ? { id: "1", displayName: "@octo" } : null, scopes: state === "connected" ? ["public_repo"] : [] } } as ConnectorInfo;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-12T09:00:00.000Z"));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  h.capabilities = { connectors: { mutationEnabled: true, reasonCode: null } };
  h.connectors = [];
  h.pendingSessions = {};
  h.pendingListeners.clear();
  h.loading = false;
  h.start.mockReset();
  h.refresh.mockReset();
  h.cancel.mockReset();
  h.disconnect.mockReset();
  h.confirm.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("ConnectionsPanel", () => {
  it.each([
    ["unavailable", "此环境不可用"], ["unconfigured", "未配置"],
    ["disconnected", "未连接"], ["pending", "等待授权"],
    ["connected", "已连接"], ["needs_reauth", "需重新授权"],
  ] as const)("列表渲染六态 %s", (state, label) => {
    h.connectors = [connector(state)];
    act(() => root.render(<ConnectionsPanel />));
    expect(host.textContent).toContain(label);
    expect(host.querySelector(".cn-row button")).toBeNull();
  });

  it("未连接详情保留对话引导并可从设置页发起授权", () => {
    h.connectors = [connector("disconnected")];
    act(() => root.render(<ConnectionsPanel selectedId="feishu" />));
    expect(host.textContent).toContain("在对话里说「连飞书」发起");
    expect(host.textContent).toContain("扫码授权");
    expect(host.textContent).not.toContain("立即检查");
    expect(host.textContent).not.toContain("设置页不直接发起授权");
  });

  it("首次慢加载立即显示三行骨架，不留空白卡片区", () => {
    h.loading = true;
    act(() => root.render(<ConnectionsPanel />));

    expect(host.querySelector('[role="status"][aria-label="正在加载连接"]')).toBeTruthy();
    expect(host.querySelectorAll(".cn-skeleton-row")).toHaveLength(3);
  });

  it.each([
    ["LARK_CLI_MISSING", "未找到飞书连接组件"],
    ["LARK_CLI_SPAWN_FAILED", "飞书连接组件未能启动"],
    ["LARK_CLI_VERSION_TIMEOUT", "飞书连接组件版本检查超时"],
  ])("飞书不可用详情按 reasonCode=%s 展示中性说明", (reasonCode, copy) => {
    h.connectors = [connector("unavailable", reasonCode)];
    act(() => root.render(<ConnectionsPanel selectedId="feishu" />));
    expect(host.textContent).toContain(copy);
    expect(host.textContent).not.toContain(reasonCode);
    expect(host.textContent).not.toContain("EINVAL");
  });

  it("飞书 start 传完整非空授权域，返回列表后仍显示等待授权", async () => {
    h.start.mockResolvedValue({
      mode: "authorization", verification_url: "https://feishu.test/auth", user_code: "LARK-CODE",
      expiresAt: "2026-07-12T10:00:00.000Z", pendingId: "fs-pending",
    });
    h.connectors = [connector("disconnected")];
    await act(async () => { root.render(<ConnectionsPanel selectedId="feishu" />); });

    const startButton = Array.from(host.querySelectorAll("button")).find((item) => item.textContent === "扫码授权")!;
    await act(async () => { startButton.click(); });
    expect(h.start).toHaveBeenCalledWith("feishu", {
      domains: [
        "docs", "base", "sheets", "calendar", "im", "drive", "mail", "task",
        "approval", "contact", "minutes", "wiki",
      ],
    });
    expect(host.querySelector('[data-component="AuthCard"]')).toBeTruthy();

    const back = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("返回连接"));
    act(() => back?.click());
    expect(host.querySelector(".cn-badge--pending")?.textContent).toContain("等待授权");
    expect(host.querySelector(".cn-sub")?.textContent).toContain("扫码验证进行中");
  });

  it("点击主按钮显示 loading 并把 GitHub start 结果内嵌为 AuthCard", async () => {
    let resolve!: (value: unknown) => void;
    h.start.mockReturnValue(new Promise((done) => { resolve = done; }));
    h.connectors = [github("disconnected")];
    await act(async () => { root.render(<ConnectionsPanel selectedId="github" />); });
    const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent === "连 接")!;
    act(() => { button.click(); });
    expect(host.textContent).toContain("发起中…");
    expect(button.disabled).toBe(true);
    await act(async () => { resolve({ user_code: "ABCD-EFGH", verification_uri: "https://github.test/device", expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), pendingId: "gh-1" }); });
    expect(h.start).toHaveBeenCalledWith("github", { scope: "repo" });
    expect(host.querySelector('[data-component="AuthCard"]')).toBeTruthy();
    expect(host.textContent).toContain("ABCD-EFGH");
    expect(host.textContent).toContain("等待授权");
  });

  it("start 失败沿用 toast 错误通道", async () => {
    h.start.mockRejectedValue(new Error("连接操作失败 (403)"));
    h.connectors = [github("disconnected")];
    await act(async () => { root.render(<ConnectionsPanel selectedId="github" />); });
    const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent === "连 接")!;
    await act(async () => { button.click(); });
    expect(h.toast).toHaveBeenCalledWith({ message: "连接操作失败 (403)", tone: "error" });
  });

  it("等待态在详情与列表都提供取消入口", async () => {
    const card = mapConnectorStart("github", "device-code", {
      user_code: "ABCD-EFGH",
      verification_uri: "https://github.test/device",
      expiresAt: "2026-07-12T10:00:00.000Z",
      pendingId: "github-pending",
    });
    h.pendingSessions = {
      github: {
        connectorId: "github",
        pendingId: "github-pending",
        startedAt: Date.now(),
        card,
      },
    };
    h.connectors = [github("disconnected")];
    h.cancel.mockResolvedValue(github("disconnected"));
    await act(async () => {
      root.render(<ConnectionsPanel selectedId="github" />);
    });

    const detailCancel = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "取消本次授权")!;
    await act(async () => detailCancel.click());
    expect(h.cancel).toHaveBeenCalledWith("github", "github-pending");

    act(() => {
      Array.from(host.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("返回连接"))
        ?.click();
    });
    expect(host.textContent).toContain("等待授权");
    expect(Array.from(host.querySelectorAll("button"))
      .some((button) => button.textContent === "取消授权")).toBe(true);
  });

  it("断开连接必须二次确认，取消时不撤权", async () => {
    h.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    h.disconnect.mockResolvedValue(connector("disconnected"));
    h.connectors = [connector("connected")];
    await act(async () => { root.render(<ConnectionsPanel selectedId="feishu" />); });
    const disconnectButton = Array.from(host.querySelectorAll("button")).find((item) => item.textContent === "断开连接")!;

    await act(async () => { disconnectButton.click(); });
    expect(h.confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: "断开「飞书」连接？",
      confirmLabel: "断开连接",
    }));
    expect(h.disconnect).not.toHaveBeenCalled();

    await act(async () => { disconnectButton.click(); });
    expect(h.disconnect).toHaveBeenCalledWith("feishu");
  });

  it("迟到的 start 响应不会显示到另一连接器详情", async () => {
    let resolve!: (value: unknown) => void;
    h.start.mockReturnValue(new Promise((done) => { resolve = done; }));
    h.connectors = [github("disconnected"), connector("disconnected")];
    await act(async () => { root.render(<ConnectionsPanel selectedId="github" onSelectedIdChange={() => undefined} />); });
    act(() => { Array.from(host.querySelectorAll("button")).find((item) => item.textContent === "连 接")?.click(); });
    await act(async () => { root.render(<ConnectionsPanel selectedId="feishu" onSelectedIdChange={() => undefined} />); });
    await act(async () => { resolve({ user_code: "ABCD-EFGH", verification_uri: "https://github.test/device", expiresAt: "2026-07-12T10:00:00.000Z", pendingId: "github-pending" }); });
    expect(host.querySelector('[data-connector-id="feishu"]')).toBeTruthy();
    expect(host.textContent).not.toContain("ABCD-EFGH");
  });

  it("映射 GitHub 授权为 number 绝对过期时间", () => {
    const mapped = mapConnectorStart("github", "device-code", {
      user_code: "ABCD-EFGH",
      verification_uri: "https://github.test/device",
      expiresAt: "2026-07-12T10:00:00.000Z",
      pendingId: "github-pending",
    });

    expect(typeof mapped.expiresAt).toBe("number");
    expect(mapped.presentation).toBe("device-code");
    expect(mapped.expiresAt).toBe(Date.parse("2026-07-12T10:00:00.000Z"));
  });

  it("映射飞书授权与配置 union 两分支，并统一 ISO 过期时间", () => {
    const authorization = mapConnectorStart("feishu", "scan", {
      mode: "authorization", verification_url: "https://feishu.test/auth", user_code: "LARK-CODE",
      expiresAt: "2026-07-12T10:00:00.000Z", pendingId: "fs-auth",
    });
    expect(authorization).toMatchObject({ presentation: "scan", content: "https://feishu.test/auth", code: "LARK-CODE", pendingId: "fs-auth", confirmQuery: null });
    expect(typeof authorization.expiresAt).toBe("number");
    expect(authorization.expiresAt).toBe(Date.parse("2026-07-12T10:00:00.000Z"));

    const configuration = mapConnectorStart("feishu", "scan", {
      mode: "configuration", configuration_url: "https://feishu.test/config",
      expiresAt: "2026-07-12T11:00:00.000Z", pendingId: "fs-config",
    });
    expect(configuration).toMatchObject({ title: "配置飞书应用", content: "https://feishu.test/config", code: null, pendingId: "fs-config" });
    expect(typeof configuration.expiresAt).toBe("number");
    expect(configuration.note).toContain("应用配置步骤");
    expect(configuration.note).toContain("[点此打开创建向导]");
  });

  it("拒绝脏 start DTO，而不是生成无效授权卡", () => {
    expect(() => mapConnectorStart("github", "device-code", { pendingId: "only-id" })).toThrow("verification_uri");
    expect(() => mapConnectorStart("wechat-mp", "scan", { imageDataUri: "data:image/png;base64,AA", expiresInSec: 0, pendingId: "wx" })).toThrow("expiresInSec");
  });

  it("映射微信图片与相对过期秒数", () => {
    const mapped = mapConnectorStart(
      "wechat-mp",
      "scan",
      { imageDataUri: "data:image/png;base64,AA", expiresInSec: 180, pendingId: "wx-1" },
      1_000,
    );
    expect(mapped).toMatchObject({
      presentation: "scan",
      content: "",
      imageDataUri: "data:image/png;base64,AA",
      expiresAt: 181_000,
      pendingId: "wx-1",
    });
    expect(typeof mapped.expiresAt).toBe("number");
  });

  it("selectedId 未配回调时仍可从详情返回列表", () => {
    h.connectors = [connector("disconnected")];
    act(() => root.render(<ConnectionsPanel selectedId="feishu" />));
    const back = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("返回连接"));
    expect(back).toBeTruthy();
    act(() => back?.click());
    expect(host.querySelector('[data-wf="ConnectionsPanel"]')).toBeTruthy();
  });

  it("capability gate 关闭时整个 tab 显示此环境不可用", () => {
    h.capabilities = { connectors: { mutationEnabled: false, reasonCode: "PUBLIC_DEPLOYMENT" } };
    h.connectors = [connector("connected")];
    act(() => root.render(<ConnectionsPanel />));
    expect(host.querySelector('[data-wf="ConnectionsUnavailable"]')).toBeTruthy();
    expect(host.textContent).toContain("此环境不可用");
    expect(host.textContent).not.toContain("飞书");
  });

  it("点击断开先弹二次确认，不会直接执行 disconnect", async () => {
    let resolveConfirm!: (value: boolean) => void;
    h.confirm.mockReturnValue(new Promise<boolean>((resolve) => {
      resolveConfirm = resolve;
    }));
    h.connectors = [connector("connected")];
    await act(async () => {
      root.render(<ConnectionsPanel selectedId="feishu" />);
    });

    const disconnectButton = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "断开连接")!;
    act(() => {
      disconnectButton.click();
    });

    expect(h.confirm).toHaveBeenCalledWith({
      title: "断开「飞书」连接？",
      message: "断开后需重新授权连接，青简才能再次访问飞书。",
      confirmLabel: "断开连接",
    });
    expect(h.disconnect).not.toHaveBeenCalled();
    expect(disconnectButton.disabled).toBe(true);

    await act(async () => {
      resolveConfirm(false);
      await Promise.resolve();
    });
  });

  it("取消断开确认后连接保持不变", async () => {
    h.confirm.mockResolvedValue(false);
    h.connectors = [connector("connected")];
    await act(async () => {
      root.render(<ConnectionsPanel selectedId="feishu" />);
    });

    const disconnectButton = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "断开连接")!;
    await act(async () => {
      disconnectButton.click();
    });

    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.disconnect).not.toHaveBeenCalled();
    expect(h.toast).not.toHaveBeenCalledWith({ message: "已断开连接", tone: "success" });
    expect(disconnectButton.disabled).toBe(false);
  });

  it("确认断开后才执行 disconnect", async () => {
    h.confirm.mockResolvedValue(true);
    h.disconnect.mockResolvedValue(undefined);
    h.connectors = [connector("connected")];
    await act(async () => {
      root.render(<ConnectionsPanel selectedId="feishu" />);
    });

    const disconnectButton = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "断开连接")!;
    await act(async () => {
      disconnectButton.click();
    });

    expect(h.disconnect).toHaveBeenCalledTimes(1);
    expect(h.disconnect).toHaveBeenCalledWith("feishu");
    expect(h.confirm.mock.invocationCallOrder[0]).toBeLessThan(h.disconnect.mock.invocationCallOrder[0]!);
    expect(h.toast).toHaveBeenCalledWith({ message: "已断开连接", tone: "success" });
  });

  it("GitHub 已连接态账号句在底部断开区,不摆 scope 档位", () => {
    h.connectors = [github("connected")];
    act(() => root.render(<ConnectionsPanel selectedId="github" />));
    expect(host.textContent).toContain("已连接为 @octo");
    expect(host.textContent).not.toContain("升级私有仓授权");
    expect(host.textContent).not.toContain("已授权范围");
    expect(host.textContent).not.toContain("public_repo");
    expect(host.textContent).not.toContain("即将上线");

    h.connectors = [github("connected", "ACCOUNT_CHANGE_CONFIRMATION_REQUIRED")];
    act(() => root.render(<ConnectionsPanel selectedId="github" />));
    expect(host.textContent).toContain("授权账号发生变化");
    expect(host.textContent).toContain("请先断开");
  });
});
