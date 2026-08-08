// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, it, expect, beforeEach, vi } from "vitest";
import QRCode from "qrcode";
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
    it("长倒计时格式化为分秒", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-12T09:00:00.000Z"));
      const data: QrCardBody = {
        presentation: "scan",
        imageDataUri: null,
        title: "飞书授权",
        content: "https://test.qr",
        expiresAt: Date.now() + 795 * 1000,
        code: "ABC123",
        refreshQuery: "refresh",
        confirmQuery: null,
        note: null,
      };

      render(<QrCard data={data} />);

      expect(document.querySelector(".qr-card__expiry")?.textContent).toBe("13分15秒后过期");
    });

    it("unmounts and clears interval when component is destroyed mid-countdown", () => {
      // 安排:卡片距过期还有 30 秒,已在倒计时
      const data: QrCardBody = {
        presentation: "scan",
        imageDataUri: null,
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
        presentation: "scan",
        imageDataUri: null,
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
        presentation: "scan",
        imageDataUri: null,
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
      expect(refreshBtn?.textContent).toContain("二维码已失效");
      expect(document.querySelector(".qr-card__frame.is-expired")).toBeTruthy();
    });
  });

  // ──────────────── (d) 尖括号边界条件(markdown 链接 href) ────────────────

  describe("(d) URL angle-bracket boundaries — stripMarkdownAngleHref", () => {
    const baseData: Omit<QrCardBody, "note"> = {
      presentation: "scan",
      imageDataUri: null,
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

    it.each([
      ["请扫描下方二维码", "请扫描上方二维码"],
      ["请扫描下方的二维码", "请扫描上方的二维码"],
      ["请扫描下面二维码", "请扫描上面二维码"],
      ["请扫描下面的二维码", "请扫描上面的二维码"],
      ["二维码在下方，请扫码", "二维码在上方，请扫码"],
      ["二维码在下面，请扫码", "二维码在上面，请扫码"],
    ])("只归一明显写反的二维码方位：%s", (note, expected) => {
      render(<QrCard data={{ ...baseData, note }} />);

      expect(document.querySelector(".qr-card__note")?.textContent).toBe(expected);
    });

    it("保留下方其它正常内容，只修正链接文字且不改链接地址", () => {
      render(<QrCard data={{
        ...baseData,
        note: "扫描二维码后，请查看下方说明，下面还有备用入口：[下方二维码](https://example.com/下方二维码)",
      }} />);

      const note = document.querySelector(".qr-card__note");
      const link = note?.querySelector("a");
      expect(note?.textContent).toContain("请查看下方说明，下面还有备用入口");
      expect(link?.textContent).toBe("上方二维码");
      expect(link?.getAttribute("href")).toBe("https://example.com/下方二维码");
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

    it("restores literal newline escape sequences without breaking markdown", () => {
      const data: QrCardBody = {
        ...baseData,
        note: "请扫码登录。\\r\\n也可 [点此打开](https://example.com)\\n**完成后返回**",
      };
      render(<QrCard data={data} />);
      const paragraphs = document.querySelectorAll(".qr-card__note-line");
      expect(paragraphs).toHaveLength(3);
      expect(paragraphs[1]?.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
      expect(paragraphs[2]?.querySelector("strong")?.textContent).toBe("完成后返回");
      expect(document.querySelector(".qr-card__note")?.textContent).not.toContain("\\n");
    });

    it.each(["<br>", "<br/>", "<br />", "<BR>", "<Br />"])(
      "normalizes HTML break tag %s as a real line break",
      (breakTag) => {
        const data: QrCardBody = {
          ...baseData,
          note: `第一行${breakTag}第二行`,
        };
        render(<QrCard data={data} />);
        const paragraphs = document.querySelectorAll(".qr-card__note-line");
        expect(paragraphs).toHaveLength(2);
        expect(paragraphs[0]?.textContent).toBe("第一行");
        expect(paragraphs[1]?.textContent).toBe("第二行");
        expect(document.querySelector(".qr-card__note")?.textContent).not.toContain(breakTag);
      },
    );

    it("normalizes HTML break tags together with literal newline escapes", () => {
      const data: QrCardBody = {
        ...baseData,
        note: "第一行<br>第二行\\n第三行<BR />第四行",
      };
      render(<QrCard data={data} />);
      const paragraphs = document.querySelectorAll(".qr-card__note-line");
      expect(Array.from(paragraphs, (paragraph) => paragraph.textContent)).toEqual([
        "第一行",
        "第二行",
        "第三行",
        "第四行",
      ]);
    });

    it("keeps non-break HTML as inert text", () => {
      const data: QrCardBody = {
        ...baseData,
        note: "<img src=x onerror=alert(1)>第一行<br>第二行",
      };
      render(<QrCard data={data} />);
      expect(document.querySelector(".qr-card__note img")).toBeNull();
      expect(document.querySelector(".qr-card__note")?.textContent)
        .toContain("<img src=x onerror=alert(1)>第一行");
    });

    it("preserves deliberate backslashes that are not clear newline escapes", () => {
      const data: QrCardBody = {
        ...baseData,
        note: String.raw`路径 C:\new 与字面量 \\n 保持不变`,
      };
      render(<QrCard data={data} />);
      const text = document.querySelector(".qr-card__note")?.textContent ?? "";
      expect(document.querySelectorAll(".qr-card__note-line")).toHaveLength(1);
      expect(text).toContain(String.raw`C:\new`);
      expect(text).toContain(String.raw`\\n`);
    });
  });

  // ──────────────── 补充:过期倒计时停止 ────────────────

  describe("(a) Expiry countdown stops at zero", () => {
    it("does not count below 0 seconds", () => {
      const data: QrCardBody = {
        presentation: "scan",
        imageDataUri: null,
        title: "测试",
        content: "https://test.qr",
        expiresAt: Date.now() - 5 * 1000, // 已过期
        code: null,
        refreshQuery: "refresh",
        confirmQuery: null,
        note: null,
      };

      render(<QrCard data={data} />);

      // 已失效应该使用中性文案
      const expiry = document.querySelector(".qr-card__expiry");
      expect(expiry?.textContent).toBe("二维码已失效");
    });

    it.each([
      ["empty string", ""],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["undefined", undefined],
    ])("does not render an expired state for invalid expiresAt: %s", (_label, expiresAt) => {
      const data = {
        title: "测试",
        content: "https://test.qr",
        expiresAt,
        code: null,
        refreshQuery: "refresh",
        confirmQuery: null,
        note: null,
      } as unknown as QrCardBody;

      render(<QrCard data={data} />);

      expect(document.querySelector(".qr-card__frame.is-expired")).toBeNull();
      expect(document.querySelector(".qr-card__refresh")).toBeNull();
      expect(document.querySelector(".qr-card__expiry")).toBeNull();
      expect(document.body.textContent).not.toContain("二维码已失效");
    });
  });

  // ──────────────── 补充:10秒确认按钮延迟出现 ────────────────

  describe("(a) Confirm button appears after 10 seconds", () => {
    it("does not show confirm button immediately", () => {
      const data: QrCardBody = {
        presentation: "scan",
        imageDataUri: null,
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
        presentation: "scan",
        imageDataUri: null,
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
        presentation: "scan",
        imageDataUri: null,
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
        presentation: "scan",
        imageDataUri: null,
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
        presentation: "scan",
        imageDataUri: null,
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
        presentation: "scan",
        imageDataUri: null,
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
        presentation: "scan",
        imageDataUri: null,
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
        presentation: "scan",
        imageDataUri: null,
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
      expect(refreshButton?.getAttribute("aria-label")).toBe("重新获取已失效二维码");
    });

    it("adds an accessible label to the confirm button", async () => {
      vi.useFakeTimers();
      const data: QrCardBody = {
        presentation: "scan",
        imageDataUri: null,
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
      presentation: "device-code",
      title: "连接 GitHub", content: "https://example.test/device", imageDataUri: null,
      expiresAt: Date.now() + 60_000, code: "ABCD-EFGH", note: null,
      refreshQuery: "重新连接", confirmQuery: null, connectorId: "github", pendingId: "pending-safe-id",
    });

    it("GitHub 输码卡不渲染二维码,配对码大字化", () => {
      render(<QrCard data={connectorCard()} />);
      expect(document.querySelector(".qr-card__frame")).toBeNull();
      expect(document.querySelector(".qr-card__usercode.is-hero")?.textContent).toContain("ABCD-EFGH");
      expect(document.querySelector(".qr-card__confirm")?.textContent).toContain("复制代码并打开");
    });

    it("show_qr 的 link 形态同时渲染可扫二维码和打开链接", async () => {
      const toDataURL = vi.spyOn(QRCode, "toDataURL");
      toDataURL.mockImplementation((() =>
        Promise.resolve("data:image/png;base64,cjY5LXFy")) as never);
      render(<QrCard data={{
        ...connectorCard(),
        presentation: "link",
        content: "https://example.com/r69B",
        connectorId: undefined,
        pendingId: undefined,
        code: null,
      }} />);

      await act(async () => { await Promise.resolve(); });

      expect(toDataURL).toHaveBeenCalledWith(
        "https://example.com/r69B",
        { margin: 1, width: 240, errorCorrectionLevel: "M" },
      );
      expect(document.querySelector("img.qr-card__img")).toBeTruthy();
      expect(document.querySelector('a.qr-card__confirm')?.textContent).toBe("打开链接");
      expect(document.querySelector(".qr-card__expiry")?.textContent).toContain("后过期");
    });

    it("GitHub 输码卡过期后显示重新发起按钮而非二维码刷新", () => {
      render(<QrCard data={{ ...connectorCard(), expiresAt: Date.now() - 1_000 }} />);
      expect(document.querySelector(".qr-card__frame")).toBeNull();
      expect(document.querySelector(".qr-card__usercode")).toBeNull();
      expect(document.querySelector(".qr-card__confirm")?.textContent).toContain("重新发起");
    });

    it("新帧轮询成功后原地显示账号", async () => {
      vi.useFakeTimers();
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: { state: "connected", account: { displayName: "@octocat" } } }), { status: 200 })));
      render(<QrCard data={connectorCard()} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(document.querySelector(".qr-card__completion")?.textContent).toContain("已连接为 @octocat");
      expect(document.querySelector(".qr-card__success svg[aria-hidden='true']")).toBeTruthy();
    });

    it("轮询成功通知设置页刷新连接状态", async () => {
      vi.useFakeTimers();
      const onStatusChange = vi.fn();
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: { state: "connected" } }), { status: 200 })));
      render(<QrCard data={connectorCard()} onStatusChange={onStatusChange} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(onStatusChange).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["unavailable", "当前无法完成授权，重新发起"],
      ["unconfigured", "授权尚未配置，重新发起"],
      ["disconnected", "授权未完成，重新发起"],
      ["needs_reauth", "授权需要重新进行"],
    ] as const)("飞书轮询返回 %s 终态时停止轮询并显示中性结果", async (state, expectedCopy) => {
      vi.useFakeTimers();
      const onStatusChange = vi.fn();
      const fetchMock = vi.fn(async () => new Response(
        JSON.stringify({ status: { state, reasonCode: "AUTH_NOT_COMPLETED" } }),
        { status: 200 },
      ));
      vi.stubGlobal("fetch", fetchMock);
      render(<QrCard data={{ ...connectorCard(), presentation: "scan", connectorId: "feishu", code: null }} onStatusChange={onStatusChange} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(document.querySelector(".qr-card__confirm")?.textContent).toContain(expectedCopy);
      expect(onStatusChange).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("pendingId 切换会取消旧请求，旧响应不能覆盖新授权流程", async () => {
      vi.useFakeTimers();
      let resolveOld: ((response: Response) => void) | undefined;
      let resolveNew: ((response: Response) => void) | undefined;
      const fetchMock = vi.fn((url: string, _init?: RequestInit) => new Promise<Response>((resolve) => {
        if (url.includes("pending-old")) resolveOld = resolve;
        else resolveNew = resolve;
      }));
      const onStatusChange = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      render(<QrCard data={{ ...connectorCard(), pendingId: "pending-old" }} onStatusChange={onStatusChange} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      const oldSignal = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.signal;

      await act(async () => {
        root?.render(<QrCard data={{ ...connectorCard(), pendingId: "pending-new" }} onStatusChange={onStatusChange} />);
      });
      expect(oldSignal?.aborted).toBe(true);

      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      await act(async () => {
        resolveNew?.(new Response(JSON.stringify({
          status: { state: "connected", account: { displayName: "@new-account" } },
        }), { status: 200 }));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(document.querySelector(".qr-card__completion")?.textContent).toContain("@new-account");

      await act(async () => {
        resolveOld?.(new Response(JSON.stringify({ error: "PENDING_LOST" }), { status: 410 }));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(document.querySelector(".qr-card__completion")?.textContent).toContain("@new-account");
      expect(document.body.textContent).not.toContain("授权已中断");
      expect(onStatusChange).toHaveBeenCalledTimes(1);
    });

    it("微信新帧轮询成功显示已登录公众号，过期/410 进入中断分支", async () => {
      vi.useFakeTimers();
      const wechat = { ...connectorCard(), presentation: "scan" as const, connectorId: "wechat-mp" as const, imageDataUri: "data:image/png;base64,AA", content: "", code: null, confirmQuery: "confirm" };
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: { state: "connected", account: { displayName: "测试号" } } }), { status: 200 })));
      render(<QrCard data={wechat} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(document.querySelector(".qr-card__completion")?.textContent).toContain("已登录 测试号 公众号");
    });

    it("微信 pending 带 WECHAT_SCANNED 时卡上显示已扫到提示", async () => {
      vi.useFakeTimers();
      const wechat = { ...connectorCard(), presentation: "scan" as const, connectorId: "wechat-mp" as const, imageDataUri: "data:image/png;base64,AA", content: "", code: null };
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: { state: "pending", reasonCode: "WECHAT_SCANNED" } }), { status: 200 })));
      render(<QrCard data={wechat} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(document.querySelector(".qr-card__scanned")?.textContent).toContain("已扫到二维码");
      // 仍处 pending:不显示成功、不中断
      expect(document.querySelector(".qr-card__success")).toBeNull();
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

  describe("(h) explicit completion state", () => {
    const completedCard = (message: string): QrCardBody => ({
      presentation: "scan",
      title: "扫码授权",
      content: "https://test.qr",
      imageDataUri: "data:image/png;base64,AA",
      expiresAt: Date.now() - 60_000,
      code: null,
      refreshQuery: "refresh",
      confirmQuery: "confirm",
      note: "请用企业微信 App 扫描上方二维码，完成初始化配置",
      success: { account: null, message },
    });

    it("完成态只在模糊码上保留 SVG，对外隐藏出码指引与操作元素", async () => {
      vi.useFakeTimers();
      render(<QrCard data={completedCard("企业微信登录成功")} />);

      expect(document.querySelector(".qr-card__title")?.textContent).toBe("扫码授权");
      expect(document.querySelector(".qr-card__frame.is-completed .qr-card__img")).toBeTruthy();
      expect(document.querySelector(".qr-card__frame.is-expired")).toBeNull();
      expect(document.querySelector(".qr-card__success svg[aria-hidden='true']")).toBeTruthy();
      expect(document.querySelector(".qr-card__completion")?.textContent).toBe("企业微信登录成功");
      expect(document.querySelector(".qr-card__frame .qr-card__completion")).toBeNull();
      expect(document.querySelector(".qr-card__note")).toBeNull();
      expect(document.body.textContent).not.toContain("请用企业微信 App 扫描");
      expect(document.body.textContent).not.toContain("✓");
      expect(document.querySelector(".qr-card__refresh")).toBeNull();
      expect(document.querySelector(".qr-card__scanned")).toBeNull();
      expect(document.querySelector(".qr-card__expiry")).toBeNull();
      expect(document.querySelector(".qr-card__confirm")).toBeNull();
      expect(document.querySelector("button")).toBeNull();
      expect(document.body.textContent).not.toContain("失效");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(document.querySelector(".qr-card__confirm")).toBeNull();
      expect(document.querySelector("button")).toBeNull();
    });

    it.each([
      ["企业微信登录成功...", "企业微信登录成功"],
      ["企业微信登录成功…", "企业微信登录成功"],
      ["企业微信登录成功... \n\t", "企业微信登录成功"],
      ["企业微信登录成功... \t…  \n", "企业微信登录成功"],
    ])("移除完成文案末尾的省略号：%j", (message, expected) => {
      render(<QrCard data={completedCard(message)} />);

      expect(document.querySelector(".qr-card__completion")?.textContent).toBe(expected);
    });

    it.each(["", "...", "…", "  ... \t…  \n"])(
      "空或纯省略号完成文案回落到默认值：%j",
      (message) => {
        render(<QrCard data={completedCard(message)} />);

        expect(document.querySelector(".qr-card__completion")?.textContent).toBe("授权已完成");
      },
    );

    it("超长完成文案移出码区并具备断词兜底，不撑破卡片", () => {
      const message = `企业微信登录成功，${"正在同步组织架构与通讯录".repeat(12)}`;
      render(<QrCard data={completedCard(message)} />);

      expect(document.querySelector(".qr-card__frame .qr-card__completion")).toBeNull();
      expect(document.querySelector(".qr-card__completion")?.textContent).toBe(message);

      const css = readFileSync(
        resolve(process.cwd(), "src/pages/workspace/components/QrCard.css"),
        "utf8",
      );
      const completionRule = css.match(/\.qr-card__completion\s*\{(?<body>[^}]*)\}/u)?.groups?.body ?? "";
      expect(completionRule).toMatch(/width:\s*200px/u);
      expect(completionRule).toMatch(/max-width:\s*100%/u);
      expect(completionRule).toMatch(/overflow-wrap:\s*anywhere/u);
      expect(completionRule).toMatch(/word-break:\s*break-word/u);
    });

    it("GitHub 输码流完成后保留并弱化配对码骨架，不恢复二维码或操作按钮", () => {
      render(<QrCard data={{
        presentation: "device-code",
        title: "连接 GitHub",
        content: "https://example.test/device",
        imageDataUri: null,
        expiresAt: Date.now() + 60_000,
        code: "ABCD-EFGH",
        note: "浏览器配对授权",
        refreshQuery: "重新连接",
        confirmQuery: null,
        connectorId: "github",
        pendingId: "pending-safe-id",
        success: { account: "@octocat", message: "GitHub 授权完成…" },
      }} />);

      expect(document.querySelector(".qr-card__frame")).toBeNull();
      expect(document.querySelector(".qr-card__code-stage.is-completed")).toBeTruthy();
      expect(document.querySelector(".qr-card__usercode[aria-hidden='true']")?.textContent)
        .toContain("ABCD-EFGH");
      expect(document.querySelector(".qr-card__completion")?.textContent).toBe("GitHub 授权完成");
      expect(document.querySelector(".qr-card__note")).toBeNull();
      expect(document.querySelector("button")).toBeNull();
      expect(document.querySelector(".qr-card__expiry")).toBeNull();
    });
  });
});
