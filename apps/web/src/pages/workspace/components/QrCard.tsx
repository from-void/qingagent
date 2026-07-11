import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import type { QrCardBody } from "@qingagent/contract-ts";
import { chatInputBus } from "../../../system";
import { useVisibilityPausedInterval } from "../../../system/perf/visibilityScheduler";
import { sanitizeToolbarLinkHref } from "../data/toolbarUnlock";
import "./QrCard.css";

/**
 * 对话流内置二维码卡(统一抽象组件,授权/配对/分享通用)。
 * - 到 expiresAt(绝对时间戳)作废:码置灰打码。过期态悬停浮现「点此刷新」,
 *   点击 chatInputBus.send(refreshQuery) 一点即发,让 agent 重新生成。
 * - note 是模型自产的轻量 markdown 说明(可含可点授权链接),取代写死的兜底链接。
 * - code(配对码)不是每个平台都有,没有则隐藏。
 */
export function AuthCard({ data }: { data: QrCardBody }) {
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const remainOf = useCallback(
    () => Math.max(0, Math.ceil((data.expiresAt - Date.now()) / 1000)),
    [data.expiresAt],
  );
  const [remain, setRemain] = useState(remainOf);
  const expired = remain <= 0;

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
    expired ? null : 1000,
    { runOnResume: true },
  );

  // 「我已完成授权」按钮:渲染 10 秒后才出现(防用户没扫就误点),仅未过期时显示。
  const [confirmReady, setConfirmReady] = useState(false);
  const [refreshSent, setRefreshSent] = useState(false);
  const [confirmSent, setConfirmSent] = useState(false);
  const refreshSentRef = useRef(false);
  const confirmSentRef = useRef(false);

  useEffect(() => {
    const id = window.setTimeout(() => setConfirmReady(true), 10000);
    return () => window.clearTimeout(id);
  }, []);

  const noteNodes = useMemo(() => renderQrNote(data.note), [data.note]);
  const confirmQuery = data.confirmQuery;

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
    chatInputBus.send(data.refreshQuery);
  };

  const sendConfirmOnce = () => {
    if (!confirmQuery || confirmSentRef.current) return;
    confirmSentRef.current = true;
    setConfirmSent(true);
    chatInputBus.send(confirmQuery);
  };

  return (
    <div className="qr-card" data-wf="QrCard" data-component="AuthCard">
      {data.title && <div className="qr-card__title">{data.title}</div>}
      <div className={`qr-card__frame${expired ? " is-expired" : ""}`}>
        {qrUrl ? (
          <img className="qr-card__img" src={qrUrl} alt={data.title ?? "二维码"} draggable={false} />
        ) : (
          <div className="qr-card__placeholder">二维码生成中…</div>
        )}
        {expired && (
          <button
            type="button"
            className="qr-card__refresh"
            onClick={sendRefreshOnce}
            disabled={refreshSent}
            title="发送刷新请求,重新生成二维码"
            aria-label={refreshSent ? "已请求刷新二维码" : "刷新已过期二维码"}
          >
            <span className="qr-card__refresh-icon">↻</span>
            <span>{refreshSent ? "已请求刷新" : "二维码已过期,点此刷新"}</span>
          </button>
        )}
      </div>
      {data.code && (
        <div className="qr-card__usercode">
          配对码 <b>{data.code}</b>
        </div>
      )}
      <div className={`qr-card__expiry${expired ? " is-expired" : ""}`}>
        {expired ? "已过期" : `${remain}s 后过期`}
      </div>
      {noteNodes && <div className="qr-card__note">{noteNodes}</div>}
      {/* 确认按钮:放在卡片最下方,渲染 10 秒后才出现(防用户没扫就误点)。
          文案用 confirmLabel(短、贴场景),没传则默认「我已完成授权」。 */}
      {!expired && confirmReady && confirmQuery && (
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
    </div>
  );
}

/** 旧组件名兼容层：已有 import、快照和持久化 qrCard wire 均保持不变。 */
export const QrCard = AuthCard;

// 轻量渲染 note 的富文本:按行分段,inline 支持 markdown 链接 [文字](url) 与 **粗体**。
// 模型自产的说明 + 可点授权链接合为一段,替代写死的"扫不了码点此打开"。
function renderQrNote(note: string | null): JSX.Element[] | null {
  const text = note?.trim();
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
  return str.split(/(\*\*[^*]+\*\*)/g).map((p, i) =>
    p.startsWith("**") && p.endsWith("**") ? <strong key={`${key}-b${i}`}>{p.slice(2, -2)}</strong> : p,
  );
}
