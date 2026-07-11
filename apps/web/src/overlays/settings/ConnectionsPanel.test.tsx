// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorInfo, ConnectorState } from "@qingagent/contract-ts";

const h = vi.hoisted(() => ({
  capabilities: { connectors: { mutationEnabled: true, reasonCode: null } } as Record<string, unknown>,
  connectors: [] as ConnectorInfo[],
  probe: vi.fn(),
  disconnect: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../../system", () => ({ useClientCapabilities: () => h.capabilities }));
vi.mock("../../system/ToastProvider", () => ({ useToast: () => ({ show: h.toast }) }));
vi.mock("./useConnectors", () => ({
  useConnectors: () => ({
    connectors: h.connectors, loading: false, error: null, refresh: vi.fn(),
    probe: h.probe, disconnect: h.disconnect,
  }),
}));

import { ConnectionsPanel } from "./ConnectionsPanel";

let host: HTMLDivElement;
let root: Root;

function connector(state: ConnectorState): ConnectorInfo {
  return {
    id: "feishu", name: "飞书", icon: "feishu", official: true, riskNote: null,
    usedBySkills: ["feishu"],
    status: {
      state, reasonCode: null, account: null, scopes: [], lastCheckedAt: null,
      statusFreshness: "fresh", canProbe: state === "connected" || state === "needs_reauth",
    },
  };
}

function github(state: ConnectorState, reasonCode: string | null = null): ConnectorInfo {
  return { ...connector(state), id: "github", name: "GitHub", icon: "github", usedBySkills: ["github-materials"], status: { ...connector(state).status, reasonCode, scopes: state === "connected" ? ["public_repo"] : [] } } as ConnectorInfo;
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  h.capabilities = { connectors: { mutationEnabled: true, reasonCode: null } };
  h.connectors = [];
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
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

  it("未连接详情只给对话引导，不在设置页发起授权", () => {
    h.connectors = [connector("disconnected")];
    act(() => root.render(<ConnectionsPanel selectedId="feishu" />));
    expect(host.textContent).toContain("到对话里说「连飞书」发起授权");
    expect(host.textContent).not.toContain("扫码授权");
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

  it("GitHub 已上线并提示私有仓增量授权与账号切换确认", () => {
    h.connectors = [github("connected")];
    act(() => root.render(<ConnectionsPanel selectedId="github" />));
    expect(host.textContent).toContain("当前仅授权公开仓");
    expect(host.textContent).toContain("增量 repo 授权");
    expect(host.textContent).not.toContain("即将上线");

    h.connectors = [github("connected", "ACCOUNT_CHANGE_CONFIRMATION_REQUIRED")];
    act(() => root.render(<ConnectionsPanel selectedId="github" />));
    expect(host.textContent).toContain("授权账号发生变化");
    expect(host.textContent).toContain("请先断开");
  });
});
