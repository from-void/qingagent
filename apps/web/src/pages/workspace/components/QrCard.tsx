import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import type { QrCardBody } from "@qingagent/contract-ts";
import { chatInputBus } from "../../../system";
import { useVisibilityPausedInterval } from "../../../system/perf/visibilityScheduler";
import { sanitizeToolbarLinkHref } from "../data/toolbarUnlock";
import { CheckIcon } from "./icons";
import "./QrCard.css";

/**
 * 对话流内置二维码卡(统一抽象组件,授权/配对/分享通用)。
 * - 到 expiresAt(绝对时间戳)作废:码置灰打码。过期态悬停浮现「点此刷新」,
 *   点击 chatInputBus.send(refreshQuery) 一点即发,让 agent 重新生成。
 * - note 是模型自产的轻量 markdown 说明(可含可点授权链接),取代写死的兜底链接。
 * - code(配对码)不是每个平台都有,没有则隐藏。
 */
export interface AuthCardProps {
  data: QrCardBody;
  /** 设置页等非对话场景可自行重新发起；缺省保持旧帧发送 refreshQuery 的行为。 */
  onRefresh?: () => void | Promise<void>;
  /** 轮询出现任意终态后通知宿主刷新连接状态。 */
  onStatusChange?: () => void;
}

export function AuthCard({ data, onRefresh, onStatusChange }: AuthCardProps) {
  const [connectorState, setConnectorState] = useState<"polling" | "connected" | "interrupted">(
    () => data.success ? "connected" : "polling",
  );
  const [connectedAccount, setConnectedAccount] = useState<string | null>(data.success?.account ?? null);
  // 微信扫码反馈:server 感知到手机扫到码后,pending 轮询带 reasonCode=WECHAT_SCANNED。
  const [scanned, setScanned] = useState(false);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const remainOf = useCallback(
    (): number | null =>
      typeof data.expiresAt === "number" && Number.isFinite(data.expiresAt)
        ? Math.max(0, Math.ceil((data.expiresAt - Date.now()) / 1000))
        : null,
    [data.expiresAt],
  );
  const [remain, setRemain] = useState(remainOf);
  const expired = remain !== null && remain <= 0;
  const pollingRef = useRef(false);
  const settledRef = useRef(false);
  const completed = data.success !== undefined || connectorState === "connected";

  useEffect(() => {
    setConnectorState(data.success ? "connected" : "polling");
    setConnectedAccount(data.success?.account ?? null);
    setScanned(false);
    pollingRef.current = false;
    settledRef.current = false;
  }, [data.pendingId, data.success?.account, data.success?.message]);

  useVisibilityPausedInterval(
    async () => {
      if (!data.connectorId || !data.pendingId || connectorState !== "polling") return;
      if (pollingRef.current) return;
      pollingRef.current = true;
      try {
        const response = await fetch(`/api/v1/connectors/${encodeURIComponent(data.connectorId)}?pendingId=${encodeURIComponent(data.pendingId)}`, { credentials: "same-origin" });
        if (response.status === 410) { setConnectorState("interrupted"); return; }
        if (!response.ok) return;
        const payload = await response.json() as { status?: { state?: string; account?: { displayName?: string } | null; reasonCode?: string | null } };
        if (payload.status?.state === "connected") {
          setConnectedAccount(payload.status.account?.displayName ?? null);
          setConnectorState("connected");
          if (!settledRef.current) { settledRef.current = true; onStatusChange?.(); }
        } else if (payload.status?.reasonCode === "PENDING_LOST" || payload.status?.reasonCode === "PENDING_EXPIRED") {
          setConnectorState("interrupted");
        } else if (payload.status?.state === "pending" && payload.status.reasonCode === "WECHAT_SCANNED") {
          setScanned(true);
        } else if (payload.status?.state && payload.status.state !== "pending") {
          if (!settledRef.current) { settledRef.current = true; onStatusChange?.(); }
        }
      } catch { /* 短暂网络失败保持原卡，下个节流周期再试。 */ }
      finally { pollingRef.current = false; }
    },
    data.connectorId && data.pendingId && connectorState === "polling" ? 2000 : null,
    { runOnResume: true },
  );

  // 图片模式(imageDataUri 非空):码本身就是一张图(如微信公众平台后台登录码),直接显示;
  // 否则编码模式:把 content 字符串(自产 URL,安全)编码成二维码图。
  useEffect(() => {
    let alive = true;
    if (data.imageDataUri) {
      setQrUrl(data.imageDataUri);
      return () => { alive = false; };
    }
    QRCode.toDataURL(data.content, { margin: 1, width: 240, errorCorrectionLevel: "M" })
      .then((u) => { if (alive) setQrUrl(u); })
      .catch(() => { if (alive) setQrUrl(null); });
    return () => { alive = false; };
  }, [data.content, data.imageDataUri]);

  // 按绝对过期时间戳倒计时(每秒刷新;到点即作废)。
  useEffect(() => {
    setRemain(remainOf());
  }, [remainOf]);
  useVisibilityPausedInterval(
    () => setRemain(remainOf()),
    remain === null || expired ? null : 1000,
    { runOnResume: true },
  );

  // 「我已完成授权」按钮:渲染 10 秒后才出现(防用户没扫就误点),仅未过期时显示。
  const [confirmReady, setConfirmReady] = useState(false);
  const [refreshSent, setRefreshSent] = useState(false);
  const [confirmSent, setConfirmSent] = useState(false);
  const refreshSentRef = useRef(false);
  const confirmSentRef = useRef(false);

  useEffect(() => {
    if (completed) return;
    const id = window.setTimeout(() => setConfirmReady(true), 10000);
    return () => window.clearTimeout(id);
  }, [completed]);

  const noteNodes = useMemo(() => renderQrNote(data.note), [data.note]);
  const confirmQuery = data.confirmQuery;
  const defaultCompletionText = data.connectorId === "wechat-mp"
    ? `已登录 ${connectedAccount ?? "微信公众号"}${connectedAccount ? " 公众号" : ""}`
    : data.connectorId === "feishu"
      ? `已授权${connectedAccount ? `为 ${connectedAccount}` : "飞书"}`
      : data.connectorId === "github"
        ? `已连接为 ${connectedAccount ?? "GitHub 账号"}`
        : "授权已完成";
  const completionText = normalizeQrCompletionText(data.success?.message, defaultCompletionText);
  // GitHub device flow 是「浏览器打开 + 输配对码」,扫码没有意义(扫开的页面仍要手输码):
  // 不渲二维码,配对码大字化(对齐拍板稿)。其余连接器(扫码类)保持二维码。
  const codeFirst = data.connectorId === "github" && !data.imageDataUri;
  const expiryLabel = remain === null
    ? null
    : remain >= 60
      ? `${Math.floor(remain / 60)}分${remain % 60 === 0 ? "" : `${remain % 60}秒`}`
      : `${remain}秒`;

  useEffect(() => {
    refreshSentRef.current = false;
    setRefreshSent(false);
  }, [data.content, data.expiresAt, data.refreshQuery]);

  useEffect(() => {
    confirmSentRef.current = false;
    setConfirmSent(false);
  }, [data.content, data.expiresAt, confirmQuery]);

  const sendRefreshOnce = () => {
    if (refreshSentRef.current) return;
    refreshSentRef.current = true;
    setRefreshSent(true);
    if (onRefresh) {
      Promise.resolve(onRefresh()).catch(() => {
        refreshSentRef.current = false;
        setRefreshSent(false);
      });
    } else chatInputBus.send(data.refreshQuery);
  };

  const sendConfirmOnce = () => {
    if (!confirmQuery || confirmSentRef.current) return;
    confirmSentRef.current = true;
    setConfirmSent(true);
    chatInputBus.send(confirmQuery);
  };

  return (
    <div className="qr-card" data-wf="QrCard" data-component="AuthCard">
      {!completed && connectorState === "interrupted" ? (
        <button type="button" className="qr-card__confirm" onClick={sendRefreshOnce} disabled={refreshSent}>授权已中断，重新发起</button>
      ) : <>
      {data.title && <div className="qr-card__title">{data.title}</div>}
      {!codeFirst && <div className={`qr-card__frame${completed ? " is-completed" : expired ? " is-expired" : ""}`}>
        {qrUrl ? (
          <img className="qr-card__img" src={qrUrl} alt={data.title ?? "二维码"} draggable={false} />
        ) : (
          <div className="qr-card__placeholder">二维码生成中…</div>
        )}
        {completed ? (
          <QrCompletionOverlay />
        ) : expired && (
          <button
            type="button"
            className="qr-card__refresh"
            onClick={sendRefreshOnce}
            disabled={refreshSent}
            title="发送刷新请求,重新生成二维码"
            aria-label={refreshSent ? "已请求刷新二维码" : "重新获取已失效二维码"}
          >
            <span className="qr-card__refresh-icon">↻</span>
            <span>{refreshSent ? "已请求刷新" : "二维码已失效，可点此重新获取"}</span>
          </button>
        )}
      </div>}
      {codeFirst && completed && (
        <div className="qr-card__code-stage is-completed">
          {data.code && (
            <div className="qr-card__usercode is-hero" aria-hidden="true">
              配对码 <b>{data.code}</b>
            </div>
          )}
          <QrCompletionOverlay />
        </div>
      )}
      {completed && (
        <div className="qr-card__completion" role="status">
          {completionText}
        </div>
      )}
      {codeFirst && !completed && expired && (
        <button type="button" className="qr-card__confirm" onClick={sendRefreshOnce} disabled={refreshSent}>
          {refreshSent ? "已请求重新发起" : "配对码已失效，重新发起"}
        </button>
      )}
      {!completed && data.code && !(codeFirst && expired) && (
        <div className={`qr-card__usercode${codeFirst ? " is-hero" : ""}`}>
          配对码 <b>{data.code}</b>
          {data.connectorId === "github" && (
            <button type="button" className="qr-card__confirm" onClick={() => {
              void navigator.clipboard?.writeText(data.code ?? "");
              const href = sanitizeToolbarLinkHref(data.content);
              if (href) window.open(href, "_blank", "noopener,noreferrer");
            }}>复制代码并打开</button>
          )}
        </div>
      )}
      {!completed && scanned && !expired && (
        <div className="qr-card__scanned">
          <CheckIcon size={13} />
          <span>已扫到二维码，请在手机上确认登录</span>
        </div>
      )}
      {!completed && expiryLabel !== null && <div className={`qr-card__expiry${expired ? " is-expired" : ""}`}>
        {expired ? "二维码已失效" : `${expiryLabel}后过期`}
      </div>}
      {!completed && noteNodes && <div className="qr-card__note">{noteNodes}</div>}
      {/* 确认按钮:放在卡片最下方,渲染 10 秒后才出现(防用户没扫就误点)。
          文案用 confirmLabel(短、贴场景),没传则默认「我已完成授权」。 */}
      {!completed && !expired && confirmReady && confirmQuery && (
        <button
          type="button"
          className="qr-card__confirm"
          onClick={sendConfirmOnce}
          disabled={confirmSent}
          aria-label={confirmSent ? "已发送确认" : `确认${data.confirmLabel ?? "已完成授权"}`}
        >
          {confirmSent ? "已发送确认" : data.confirmLabel ?? "我已完成授权"}
        </button>
      )}
      </>}
    </div>
  );
}

/** 旧组件名兼容层：已有 import、快照和持久化 qrCard wire 均保持不变。 */
export const QrCard = AuthCard;

function QrCompletionOverlay() {
  return (
    <div className="qr-card__success" aria-hidden="true">
      <CheckIcon size={26} />
    </div>
  );
}

/** 完成态是终态陈述：剥掉模型偶尔附带的尾部省略号，空结果回落到连接器默认文案。 */
function normalizeQrCompletionText(
  message: string | null | undefined,
  fallback = "授权已完成",
): string {
  if (typeof message !== "string") return fallback;
  const normalized = message
    .replace(/\s+$/u, "")
    .replace(/(?:(?:\.{3,}|…)\s*)+$/u, "")
    .trim();
  return normalized || fallback;
}

// 轻量渲染 note 的富文本:按行分段,inline 支持 markdown 链接 [文字](url) 与 **粗体**。
// 模型自产的说明 + 可点授权链接合为一段,替代写死的"扫不了码点此打开"。
export function normalizeQrNoteLineBreaks(note: string): string {
  // note 始终按文本渲染；这里只把模型常写的 HTML 换行标签折叠为换行，
  // 其它标签继续作为普通文本保留，绝不引入 HTML 解释或放宽链接净化。
  const noteWithNormalizedBreakTags = note.replace(/<br\s*\/?>/gi, "\n");
  let normalized = "";
  for (let i = 0; i < noteWithNormalizedBreakTags.length;) {
    if (noteWithNormalizedBreakTags[i] !== "\\") {
      normalized += noteWithNormalizedBreakTags[i];
      i += 1;
      continue;
    }
    let slashEnd = i;
    while (noteWithNormalizedBreakTags[slashEnd] === "\\") slashEnd += 1;
    const slashCount = slashEnd - i;
    const hasUnescapedSlash = slashCount % 2 === 1;
    const crlfEscape =
      hasUnescapedSlash &&
      noteWithNormalizedBreakTags.slice(slashEnd, slashEnd + 3) === "r\\n";
    const nextAfterNewlineEscape = noteWithNormalizedBreakTags[slashEnd + 1] ?? "";
    const newlineEscape =
      hasUnescapedSlash &&
      noteWithNormalizedBreakTags[slashEnd] === "n" &&
      // 避免把 C:\new、正则 \namespace 之类合法反斜杠正文误判成换行。
      !/[a-z0-9_]/.test(nextAfterNewlineEscape);
    if (crlfEscape || newlineEscape) {
      normalized += "\\".repeat(slashCount - 1);
      normalized += "\n";
      i = slashEnd + (crlfEscape ? 3 : 1);
      continue;
    }
    normalized += "\\".repeat(slashCount);
    i = slashEnd;
  }
  return normalized;
}

function renderQrNote(note: string | null): JSX.Element[] | null {
  const text = note ? normalizeQrNoteLineBreaks(note).trim() : "";
  if (!text) return null;
  return text.split("\n").map((line, li) => (
    <p key={li} className="qr-card__note-line">
      {renderQrInline(line, `n${li}`)}
    </p>
  ));
}

function renderQrInline(str: string, key: string): (string | JSX.Element)[] {
  // 先切链接 [text](url),再在非链接片段里切 **bold**。
  const out: (string | JSX.Element)[] = [];
  const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let idx = 0;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(str)) !== null) {
    if (m.index > last) out.push(...renderQrBold(str.slice(last, m.index), `${key}-t${idx}`));
    // 链接 href 走白名单(只放 http(s)/相对/锚点,挡 javascript: 等);不安全则只留文字。
    const href = sanitizeToolbarLinkHref(stripMarkdownAngleHref(m[2] ?? ""));
    if (href) {
      out.push(
        <a key={`${key}-l${idx}`} href={href} target="_blank" rel="noreferrer noopener">
          {renderQrBold(m[1] ?? "", `${key}-l${idx}`)}
        </a>,
      );
    } else {
      out.push(...renderQrBold(m[1] ?? "", `${key}-l${idx}`));
    }
    last = m.index + m[0].length;
    idx += 1;
  }
  if (last < str.length) out.push(...renderQrBold(str.slice(last), `${key}-t${idx}`));
  return out;
}

function stripMarkdownAngleHref(href: string): string {
  const trimmed = href.trim();
  return trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1).trim() : trimmed;
}

function renderQrBold(str: string, key: string): (string | JSX.Element)[] {
  const normalized = normalizeQrNoteDirection(str);
  return normalized.split(/(\*\*[^*]+\*\*)/g).map((p, i) =>
    p.startsWith("**") && p.endsWith("**") ? <strong key={`${key}-b${i}`}>{p.slice(2, -2)}</strong> : p,
  );
}

/** 只修正 note 内明确指向二维码的常见反向方位，不泛化改写其它“下方/下面”内容。 */
function normalizeQrNoteDirection(text: string): string {
  return text
    .replaceAll("下方的二维码", "上方的二维码")
    .replaceAll("下方二维码", "上方二维码")
    .replaceAll("下面的二维码", "上面的二维码")
    .replaceAll("下面二维码", "上面二维码")
    .replaceAll("二维码在下方", "二维码在上方")
    .replaceAll("二维码在下面", "二维码在上面");
}
