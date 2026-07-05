import { app } from "electron";
import { awaitWithinMs } from "./deadline.js";
import { loadTelemetryConfig } from "./config.js";
import { getTelemetryDeviceId } from "./deviceId.js";
import { redactPotentialPii } from "./redact.js";
import { ageDaysBucket, loadProfile, markMilestone, wasFirstRun } from "./profile.js";

type TelemetryValue = string | number | boolean | null | undefined;

export type TelemetryProperties = Record<string, TelemetryValue>;

export type TelemetryCommonProperties = {
  appVersion: string;
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  locale: string;
  electronVersion: string;
  nodeVersion: string;
};

export type RendererTelemetryBootstrap = {
  endpoint: string;
  websiteId: string;
  distinctId: string;
  commonProperties: TelemetryCommonProperties;
};

// 上报到自托管 Umami 的 collect 接口:POST sendUrl
//   { type:"event", payload:{ website, hostname, url, name?, data?, language } }
// 主进程无浏览器,hostname/url 用固定值;必须带 User-Agent(Umami 会用 UA 做会话/丢 bot)。
class DesktopTelemetry {
  private config: { endpoint: string; sendUrl: string; batchUrl: string | null; websiteId: string } | null = null;
  private distinctId: string | null = null;
  private commonProps: TelemetryCommonProperties | null = null;
  private userAgent = "";
  private initialized = false;
  // 上报队列:攒批(15s 或 20 条先到为准)+ 串行在途 + 失败放回重试 + 上限 500 丢最旧。
  // 队列是传输层优化(降请求数/平峰/离线容忍),不做任何粒度策略——策略只在服务端网关。
  private queue: unknown[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private batchSupported = true; // 网关缺席(裸 Umami)时 404 → 降级逐条 /api/send

  get enabled(): boolean {
    return this.config !== null && this.distinctId !== null;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const cfg = await loadTelemetryConfig();
    if (!cfg.enabled) return;

    try {
      this.distinctId = await getTelemetryDeviceId();
      this.commonProps = getCommonProperties();
      this.config = {
        endpoint: cfg.endpoint,
        sendUrl: cfg.sendUrl,
        batchUrl: cfg.batchUrl,
        websiteId: cfg.websiteId,
      };
      // 完整 Chrome/Electron 风格 UA:必须带 AppleWebKit/Chrome/Safari 等 token,否则 Umami 的
      // isbot 会把"裸自定义 UA"判为机器人、返回 200 但静默丢弃事件(实测:缺这些 token 会被丢)。
      const osToken =
        this.commonProps.platform === "win32"
          ? "Windows NT 10.0; Win64; x64"
          : this.commonProps.platform === "darwin"
            ? "Macintosh; Intel Mac OS X 10_15_7"
            : "X11; Linux x86_64";
      this.userAgent = `Mozilla/5.0 (${osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Electron/${this.commonProps.electronVersion} Safari/537.36`;
    } catch (err) {
      this.config = null;
      this.distinctId = null;
      console.warn("[telemetry] disabled after init failure:", err);
    }
  }

  getRendererBootstrap(): RendererTelemetryBootstrap | null {
    if (!this.config || !this.distinctId || !this.commonProps) return null;
    return {
      endpoint: this.config.endpoint,
      websiteId: this.config.websiteId,
      distinctId: this.distinctId,
      commonProperties: this.commonProps,
    };
  }

  private send(name: string, data: TelemetryProperties): void {
    if (!this.config || !this.distinctId || !this.commonProps) return;
    this.enqueue({
      type: "event",
      payload: {
        website: this.config.websiteId,
        hostname: "desktop",
        language: this.commonProps.locale,
        url: "/app",
        name,
        data: { ...data, device_id: this.distinctId, ...this.commonProps },
      },
    });
  }

  private enqueue(body: unknown): void {
    if (!this.config) return;
    this.queue.push(body);
    if (this.queue.length > 500) this.queue.splice(0, this.queue.length - 500);
    if (this.queue.length >= 20) {
      void this.flush();
    } else {
      this.armFlushTimer(15000);
    }
  }

  private armFlushTimer(ms: number): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, ms);
    this.flushTimer.unref?.();
  }

  private async flush(): Promise<void> {
    if (this.flushing || !this.config || this.queue.length === 0) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, 50);
        const ok = await this.sendBatch(batch);
        if (!ok) {
          // 网络失败:整批放回队首,30s 后再试(队列上限自然封顶内存)。
          this.queue.unshift(...batch);
          this.armFlushTimer(30000);
          break;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private async sendBatch(batch: unknown[]): Promise<boolean> {
    if (!this.config) return true;
    const headers = { "Content-Type": "application/json", "User-Agent": this.userAgent };
    if (this.batchSupported && this.config.batchUrl) {
      try {
        const res = await fetch(this.config.batchUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({ events: batch }),
          signal: AbortSignal.timeout(8000),
        });
        if (res.status === 404 || res.status === 405) {
          this.batchSupported = false; // 裸 Umami(无网关):降级逐条
        } else {
          return res.ok;
        }
      } catch {
        return false;
      }
    }
    try {
      for (const b of batch) {
        await fetch(this.config.sendUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(b),
          signal: AbortSignal.timeout(4000),
        }).catch(() => {});
      }
      return true;
    } catch {
      return true; // 逐条降级尽力而为,不再放回
    }
  }

  capture(event: string, properties: TelemetryProperties = {}): void {
    this.send(event, properties);
  }

  // 渲染端事件同源中继:渲染端把 Umami 载荷 POST 给内嵌 server(localhost 同源,无 CORS/系统代理问题),
  // 解析后进同一个队列随批冲刷。主/渲染共用同一 UA+IP,Umami 归一访客。
  forwardRendererEvent(rawBody: string): void {
    if (!this.config) return;
    try {
      const body = JSON.parse(rawBody) as { type?: string; payload?: unknown };
      if (body?.type === "event" && body.payload) this.enqueue(body);
    } catch {
      // 载荷非法直接丢,埋点永远不能影响主流程。
    }
  }

  // agent 工具调用(由 server.ts 的 SSE 流观察器按 toolCallId 去重后调用):如实每次上报,
  // "每天首次"等粒度由服务端网关规则决定,客户端不做策略。
  trackToolUsed(name: string): void {
    this.send("tool_used", { tool: name.slice(0, 50) });
  }

  // app_opened 带用户画像快照(全布尔/分桶,低基数):是谁在打开——首启?配过 key?
  // 真用过 AI(发过消息)?写过文档(应用过编辑)?出过成果(导出过)?装机多久了?
  captureAppOpened(): void {
    const profile = loadProfile();
    this.send("app_opened", {
      first_run: wasFirstRun(),
      has_key: profile.hasKey,
      has_sent_message: profile.hasSentMessage,
      has_applied: profile.hasApplied,
      has_exported: profile.hasExported,
      age_days: ageDaysBucket(),
    });
  }

  captureAppClosed(sessionMs: number): void {
    const bucket = sessionMs < 60000 ? "<1m" : sessionMs < 300000 ? "1-5m" : sessionMs < 1800000 ? "5-30m" : ">30m";
    this.send("app_closed", { session_ms: sessionMs, duration_bucket: bucket });
  }

  // —— 语义事件(由 server.ts 的 API 观察钩子调用),同时翻画像里程碑 ——
  trackMessageSent(): void {
    markMilestone("hasSentMessage");
    this.send("message_sent", {});
  }

  trackPatchApplied(kind: string): void {
    markMilestone("hasApplied");
    this.send("patch_applied", { kind });
  }

  trackExportDone(format: string): void {
    markMilestone("hasExported");
    this.send("export_done", { format: format.slice(0, 20) });
  }

  trackKeyConfigured(): void {
    // 只在首次配置时上报(重复保存不刷量);画像牌位由 markMilestone 判定首次。
    if (markMilestone("hasKey")) this.send("key_configured", {});
  }

  captureError(reason: unknown, properties: TelemetryProperties = {}): void {
    this.send("app_error", { ...properties, ...toSafeErrorProperties(reason) });
  }

  // 退出前把队列冲干净(含 app_closed),轮询直到清空或超时,绝不卡退出。
  async shutdown(timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while ((this.queue.length > 0 || this.flushing) && Date.now() < deadline) {
      // 单次 flush 内部的 fetch 超时(8s)可能远超退出预算,按剩余预算封顶等待:
      // 预算耗尽先行返回让 quit 继续,在途请求后台完成或随进程终止丢弃。
      await awaitWithinMs(this.flush(), deadline - Date.now());
      if (this.queue.length === 0 && !this.flushing) break;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50).unref?.();
      });
    }
  }
}

export const telemetry = new DesktopTelemetry();

export function getCommonProperties(): TelemetryCommonProperties {
  return {
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    locale: app.getLocale(),
    electronVersion: process.versions.electron ?? "unknown",
    nodeVersion: process.versions.node,
  };
}

function toSafeErrorProperties(reason: unknown): TelemetryProperties {
  if (reason instanceof Error) {
    return {
      errorName: reason.name || "Error",
      errorMessage: redactPotentialPii(reason.message || "").slice(0, 500),
    };
  }
  return {
    errorName: "NonError",
    errorMessage: redactPotentialPii(String(reason)).slice(0, 500),
  };
}
