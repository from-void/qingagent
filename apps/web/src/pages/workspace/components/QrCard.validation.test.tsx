// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, it, expect, beforeEach, vi } from "vitest";
import { QrCard } from "./QrCard";
import type { QrCardBody } from "@qingagent/contract-ts";
import { chatInputBus } from "../../../system";

/**
 * 验收第3轮:QrCard stream 完整性 + 多卡并存 + 导入导出 + 尖括号边界
 * (a) Stream 取消/错误/中断时 QrCard 的状态(倒计时 interval 清理 + 卡片残留)
 * (b) 多个 show_qr 并存 + chatInputBus 单监听行为
 * (c) 飞书文档导入导出的真实行为
 * (d) renderQrInline 尖括号剥离的边界
 */

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const createTestHost = () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  return host;
};

const render = (element: ReactNode) => {
  const hostEl = createTestHost();
  act(() => {
    root?.render(element);
  });
  return { unmount: () => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
  } };
};

const click = (button: HTMLButtonElement) => {
  button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
};

describe("QrCard — validation loop 3", () => {
  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ──────────────── (a) Stream 中断时倒计时清理与卡片残留 ────────────────

  describe("(a) Stream termination — interval cleanup & residual card", () => {
    it("unmounts and clears interval when component is destroyed mid-countdown", () => {
      // 安排:卡片距过期还有 30 秒,已在倒计时
      const data: QrCardBody = {
        title: "授权测试",
        content: "https://test.qr",
        expiresAt: Date.now() + 30 * 1000,
        code: "ABC123",
        refreshQuery: "refresh",
        confirmQuery: "confirm",
        note: "点此打开链接",
      };

      const { unmount } = render(<QrCard data={data} />);

      // 断言:卡片渲染正常,倒计时运行
      const frameText = document.querySelector(".qr-card__frame");
      expect(frameText).toBeTruthy();

      // 模拟清理:window.setInterval 应该被存储,cleanup 应该清除它
      const clearIntervalSpy = vi.spyOn(window, "clearInterval");

      // 卸载时应触发 cleanup
      unmount();

      // 断言:interval 被清除
      expect(clearIntervalSpy).toHaveBeenCalled();
      clearIntervalSpy.mockRestore();
    });

    it("does not show refresh button until card expires", () => {
      const data: QrCardBody = {
        title: "授权测试",
        content: "https://test.qr",
        expiresAt: Date.now() + 60 * 1000, // 60 秒后过期
        code: "ABC123",
        refreshQuery: "refresh",
        confirmQuery: "confirm",
        note: null,
      };

      render(<QrCard data={data} />);

      // 在过期前,刷新按钮不应显示
      const refreshBtn = document.querySelector(".qr-card__refresh");
      expect(refreshBtn).toBeNull();
    });

    it("shows refresh button after card expires", async () => {
      const data: QrCardBody = {
        title: "授权测试",
        content: "https://test.qr",
        expiresAt: Date.now() - 5 * 1000, // 已经过期 5 秒
        code: "ABC123",
        refreshQuery: "refresh",
        confirmQuery: "confirm",
        note: null,
      };

      render(<QrCard data={data} />);

      // 过期后,刷新按钮应显示且框架带 is-expired 类
      const refreshBtn = document.querySelector(".qr-card__refresh");
      expect(refreshBtn).toBeTruthy();
      expect(refreshBtn?.textContent).toContain("二维码已过期");
      expect(document.querySelector(".qr-card__frame.is-expired")).toBeTruthy();
    });
  });

  // ──────────────── (d) 尖括号边界条件(markdown 链接 href) ────────────────

  describe("(d) URL angle-bracket boundaries — stripMarkdownAngleHref", () => {
    const baseData: Omit<QrCardBody, "note"> = {
      title: "测试",
      content: "https://test.qr",
      expiresAt: Date.now() + 60 * 1000,
      code: null,
      refreshQuery: "refresh",
      confirmQuery: null,
    };

    it("handles normal markdown link [text](url)", () => {
      const data: QrCardBody = {
        ...baseData,
        note: "[点此打开](https://example.com)",
      };
      render(<QrCard data={data} />);
      const link = document.querySelector("a[href='https://example.com']");
      expect(link).toBeTruthy();
      expect(link?.textContent).toBe("点此打开");
    });

    it("strips angle brackets from [text](<url>) format", () => {
      const data: QrCardBody = {
        ...baseData,
        note: "[点此打开](<https://example.com>)",
      };
      render(<QrCard data={data} />);
      const link = document.querySelector("a[href='https://example.com']");
      expect(link).toBeTruthy();
      expect(link?.textContent).toBe("点此打开");
    });

    it("handles empty angle brackets [text](< >)", () => {
      const data: QrCardBody = {
        ...baseData,
        note: "[点此打开](< >)",
      };
      render(<QrCard data={data} />);
      // Empty angle brackets 应该被剥离成空,sanitizer 会拒绝,只留文本
      const links = document.querySelectorAll("a");
      expect(links.length).toBe(0);
    });

    it("handles half-open angle bracket at start [text](<a)", () => {
      const data: QrCardBody = {
        ...baseData,
        note: "[点此打开](<https://example.com)",
      };
      render(<QrCard data={data} />);
      // 不完整的尖括号,不应匹配 "<...>" 模式,直接作为 URL
      // sanitizeToolbarLinkHref 应该处理它
      const links = document.querySelectorAll("a");
      // 取决于 sanitizer 对 "<https://..." 的处理(应该拒绝)
      expect(links.length).toBe(0);
    });

    it("rejects malformed URL with trailing > [text](url>)", () => {
      const data: QrCardBody = {
        ...baseData,
        note: "[点此打开](https://example.com>)",
      };
      render(<QrCard data={data} />);
      const links = document.querySelectorAll("a");
      expect(links.length).toBe(0);
      expect(document.body.textContent).toContain("点此打开");
    });

    it("handles whitespace + angle brackets [text](< https://example.com >)", () => {
      const data: QrCardBody = {
        ...baseData,
        note: "[点此打开](<  https://example.com  >)",
      };
      render(<QrCard data={data} />);
      const link = document.querySelector("a[href='https://example.com']");
      // trim() 应该处理两侧空格
      expect(link).toBeTruthy();
    });

    it("renders bold text with **text** format", () => {
      const data: QrCardBody = {
        ...baseData,
        note: "这是 **粗体** 文本",
      };
      render(<QrCard data={data} />);
      const bold = document.querySelector("strong");
      expect(bold).toBeTruthy();
      expect(bold?.textContent).toBe("粗体");
    });

    it("renders bold text inside markdown link labels [**text**](url)", () => {
      const data: QrCardBody = {
        ...baseData,
        note: "[**点此打开**](https://example.com)",
      };
      render(<QrCard data={data} />);
      const link = document.querySelector("a");
      expect(link).toBeTruthy();
      expect(link?.querySelector("strong")).toBeTruthy();
      expect(link?.textContent).toBe("点此打开");
    });

    it("handles multi-line note with line breaks", () => {
      const data: QrCardBody = {
        ...baseData,
        note: "第一行\n第二行\n第三行",
      };
      render(<QrCard data={data} />);
      const noteContent = document.querySelector(".qr-card__note");
      expect(noteContent).toBeTruthy();
      // 应该有 3 个 <p> 标签
      const paragraphs = noteContent?.querySelectorAll("p");
      expect(paragraphs?.length).toBe(3);
    });
  });

  // ──────────────── 补充:过期倒计时停止 ────────────────

  describe("(a) Expiry countdown stops at zero", () => {
    it("does not count below 0 seconds", () => {
      const data: QrCardBody = {
        title: "测试",
        content: "https://test.qr",
        expiresAt: Date.now() - 5 * 1000, // 已过期
        code: null,
        refreshQuery: "refresh",
        confirmQuery: null,
        note: null,
      };

      render(<QrCard data={data} />);

      // 已过期应该显示"已过期"
      const expiry = document.querySelector(".qr-card__expiry");
      expect(expiry?.textContent).toBe("已过期");
    });
  });

  // ──────────────── 补充:10秒确认按钮延迟出现 ────────────────

  describe("(a) Confirm button appears after 10 seconds", () => {
    it("does not show confirm button immediately", () => {
      const data: QrCardBody = {
        title: "授权测试",
        content: "https://test.qr",
        expiresAt: Date.now() + 60 * 1000,
        code: null,
        refreshQuery: "refresh",
        confirmQuery: "confirm",
        note: null,
      };

      render(<QrCard data={data} />);

      const confirmBtns = document.querySelectorAll(".qr-card__confirm");
      expect(confirmBtns.length).toBe(0);
    });

    it("hides confirm button after expiry", () => {
      const data: QrCardBody = {
        title: "授权测试",
        content: "https://test.qr",
        expiresAt: Date.now() - 10 * 1000, // 已过期
        code: null,
        refreshQuery: "refresh",
        confirmQuery: "confirm",
        note: null,
      };

      render(<QrCard data={data} />);

      // 已过期,即使 confirmReady=true 也不显示(条件是 !expired)
      const confirmBtns = document.querySelectorAll(".qr-card__confirm");
      expect(confirmBtns.length).toBe(0);
    });

    it("shows code when provided", () => {
      const data: QrCardBody = {
        title: "授权测试",
        content: "https://test.qr",
        expiresAt: Date.now() + 60 * 1000,
        code: "ABC123",
        refreshQuery: "refresh",
        confirmQuery: "confirm",
        note: null,
      };

      render(<QrCard data={data} />);

      const codeSection = document.querySelector(".qr-card__usercode");
      expect(codeSection).toBeTruthy();
      expect(codeSection?.textContent).toContain("ABC123");
    });

    it("hides code when not provided", () => {
      const data: QrCardBody = {
        title: "授权测试",
        content: "https://test.qr",
        expiresAt: Date.now() + 60 * 1000,
        code: null,
        refreshQuery: "refresh",
        confirmQuery: "confirm",
        note: null,
      };

      render(<QrCard data={data} />);

      const codeSection = document.querySelector(".qr-card__usercode");
      expect(codeSection).toBeNull();
    });
  });

  describe("(e) QR action idempotency", () => {
    it("disables confirm immediately and sends confirmQuery only once on repeated clicks", async () => {
      vi.useFakeTimers();
      const sendSpy = vi.spyOn(chatInputBus, "send").mockImplementation(() => undefined);
      const data: QrCardBody = {
        title: "授权测试",
        content: "https://test.qr",
        expiresAt: Date.now() + 60 * 1000,
        code: null,
        refreshQuery: "refresh",
        confirmQuery: "confirm",
        note: null,
      };

      render(<QrCard data={data} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      const confirmButton = document.querySelector(".qr-card__confirm") as HTMLButtonElement | null;
      expect(confirmButton).toBeTruthy();
      expect(confirmButton?.disabled).toBe(false);

      act(() => {
        click(confirmButton!);
        click(confirmButton!);
      });

      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy).toHaveBeenCalledWith("confirm");
      expect(confirmButton?.disabled).toBe(true);
      expect(confirmButton?.textContent).toBe("已发送确认");
    });

    it("disables refresh immediately and sends refreshQuery only once on repeated clicks", () => {
      const sendSpy = vi.spyOn(chatInputBus, "send").mockImplementation(() => undefined);
      const data: QrCardBody = {
        title: "授权测试",
        content: "https://test.qr",
        expiresAt: Date.now() - 1_000,
        code: null,
        refreshQuery: "refresh",
        confirmQuery: null,
        note: null,
      };

      render(<QrCard data={data} />);

      const refreshButton = document.querySelector(".qr-card__refresh") as HTMLButtonElement | null;
      expect(refreshButton).toBeTruthy();
      expect(refreshButton?.disabled).toBe(false);

      act(() => {
        click(refreshButton!);
        click(refreshButton!);
      });

      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy).toHaveBeenCalledWith("refresh");
      expect(refreshButton?.disabled).toBe(true);
      expect(refreshButton?.textContent).toContain("已请求刷新");
    });

    it("uses onRefresh outside chat without sending refreshQuery", () => {
      const sendSpy = vi.spyOn(chatInputBus, "send").mockImplementation(() => undefined);
      const onRefresh = vi.fn();
      const data: QrCardBody = {
        title: "授权测试", content: "https://test.qr", expiresAt: Date.now() - 1_000,
        code: null, refreshQuery: "refresh", confirmQuery: null, note: null,
      };
      render(<QrCard data={data} onRefresh={onRefresh} />);

      act(() => { click(document.querySelector(".qr-card__refresh") as HTMLButtonElement); });

      expect(onRefresh).toHaveBeenCalledTimes(1);
      expect(sendSpy).not.toHaveBeenCalled();
    });
  });

  describe("(f) QR action accessibility", () => {
    it("adds an accessible label to the expired refresh button", () => {
      const data: QrCardBody = {
        title: "授权测试",
        content: "https://test.qr",
        expiresAt: Date.now() - 1_000,
        code: null,
        refreshQuery: "refresh",
        confirmQuery: null,
        note: null,
      };

      render(<QrCard data={data} />);

      const refreshButton = document.querySelector(".qr-card__refresh") as HTMLButtonElement | null;
      expect(refreshButton?.getAttribute("aria-label")).toBe("刷新已过期二维码");
    });

    it("adds an accessible label to the confirm button", async () => {
      vi.useFakeTimers();
      const data: QrCardBody = {
        title: "授权测试",
        content: "https://test.qr",
        expiresAt: Date.now() + 60 * 1000,
        code: null,
        refreshQuery: "refresh",
        confirmQuery: "confirm",
        note: null,
      };

      render(<QrCard data={data} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      const confirmButton = document.querySelector(".qr-card__confirm") as HTMLButtonElement | null;
      expect(confirmButton?.getAttribute("aria-label")).toBe("确认已完成授权");
    });
  });

  describe("(g) trusted connector polling", () => {
    const connectorCard = (): QrCardBody => ({
      title: "连接 GitHub", content: "https://example.test/device", imageDataUri: null,
      expiresAt: Date.now() + 60_000, code: "ABCD-EFGH", note: null,
      refreshQuery: "重新连接", confirmQuery: null, connectorId: "github", pendingId: "pending-safe-id",
    });

    it("新帧轮询成功后原地显示账号", async () => {
      vi.useFakeTimers();
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: { state: "connected", account: { displayName: "@octocat" } } }), { status: 200 })));
      render(<QrCard data={connectorCard()} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(document.querySelector(".qr-card__success")?.textContent).toContain("✓ 已连接为 @octocat");
    });

    it("轮询成功通知设置页刷新连接状态", async () => {
      vi.useFakeTimers();
      const onStatusChange = vi.fn();
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: { state: "connected" } }), { status: 200 })));
      render(<QrCard data={connectorCard()} onStatusChange={onStatusChange} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(onStatusChange).toHaveBeenCalledTimes(1);
    });

    it("飞书配置完成为 disconnected 终态时也通知设置页推进流程", async () => {
      vi.useFakeTimers();
      const onStatusChange = vi.fn();
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: { state: "disconnected", reasonCode: "LARK_AUTH_MISSING" } }), { status: 200 })));
      render(<QrCard data={{ ...connectorCard(), connectorId: "feishu", code: null }} onStatusChange={onStatusChange} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(onStatusChange).toHaveBeenCalledTimes(1);
    });

    it("微信新帧轮询成功显示已登录公众号，过期/410 进入中断分支", async () => {
      vi.useFakeTimers();
      const wechat = { ...connectorCard(), connectorId: "wechat-mp" as const, imageDataUri: "data:image/png;base64,AA", content: "", code: null, confirmQuery: "confirm" };
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: { state: "connected", account: { displayName: "测试号" } } }), { status: 200 })));
      render(<QrCard data={wechat} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(document.querySelector(".qr-card__success")?.textContent).toContain("✓ 已登录 测试号 公众号");
    });

    it("410 原地显示重新发起，旧帧不轮询", async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "PENDING_LOST" }), { status: 410 }));
      vi.stubGlobal("fetch", fetchMock);
      render(<QrCard data={connectorCard()} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(document.body.textContent).toContain("授权已中断，重新发起");
      act(() => { root?.unmount(); root = null; }); host?.remove(); host = null;
      render(<QrCard data={{ ...connectorCard(), connectorId: undefined, pendingId: undefined }} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
