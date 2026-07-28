import { useEffect, useRef, useState } from "react";
import type { ToolCallStatus, WriteDraftCardBody } from "@qingagent/contract-ts";

// writeDraft 聊天内迷你草稿卡:生成期间像"一张正在被写的小纸",
// 实时滚动摘录+字数进度;字数修订时显示校验状态;完成后定格最终字数与验收结果。

/** lengthStatus → 展示文案与色调(导出供单测)。 */
export function lengthStatusLabel(
  status: string | null,
): { text: string; tone: "ok" | "warn" | "bad" } | null {
  if (!status || status === "not_requested") return null;
  if (status === "accepted_first_pass") return { text: "字数达标", tone: "ok" };
  if (status === "accepted_after_revision") return { text: "字数达标(已自动修订)", tone: "ok" };
  if (status === "near_after_revision") return { text: "接近目标字数（已自动调整）", tone: "warn" };
  if (status === "failed_after_revision") return { text: "未达目标字数", tone: "bad" };
  return null;
}

/** 进行中状态行文案(导出供单测)。 */
export function progressLine(body: WriteDraftCardBody): string {
  const range =
    body.minLength != null && body.maxLength != null
      ? ` / 目标 ${body.minLength}–${body.maxLength} 字`
      : "";
  if (body.phase === "revising") {
    return `字数修订中(第 ${body.revisionCount} 轮) · 已写 ${body.charCount} 字${range}`;
  }
  if (body.phase === "finalizing") {
    return `定稿中 · 已写 ${body.charCount} 字${range}`;
  }
  if (body.phase === "failed") {
    return `生成失败 · 已写 ${body.charCount} 字${range}`;
  }
  return `正在写作 · 已写 ${body.charCount} 字${range}`;
}

const TONE_COLOR: Record<"ok" | "warn" | "bad", string> = {
  ok: "var(--ok, #1a7f37)",
  warn: "var(--mark, #b27a1a)",
  bad: "var(--ink-3)",
};

export function DraftMiniCard({
  body,
  status,
}: {
  body: WriteDraftCardBody;
  status?: ToolCallStatus["kind"];
}) {
  const aborted = status === "aborted";
  const failed = status === "failed" || body.phase === "failed";
  const active =
    !aborted && !failed &&
    (body.phase === "writing" || body.phase === "revising" || body.phase === "finalizing");
  const done = status === "done" || (!aborted && !failed && body.phase === "done");
  const statusLabel = lengthStatusLabel(body.lengthStatus);

  // 把流式 tail 摘录重建成「全文」(平滑增长,不像滚动窗口那样跳),实现流式加载观感。
  // done / 历史重开没有直播重建 → 退回 body.excerpt(服务端存的开头预览)。
  const [fullText, setFullText] = useState("");
  useEffect(() => {
    if (active && body.excerpt != null) {
      setFullText((prev) => mergeDraftExcerpt(prev, body.excerpt!, body.resetExcerpt === true));
    }
  }, [active, body.excerpt, body.resetExcerpt]);

  // 高频打字机:不再随 chunk「一节一节」整段跳出,而是逐字平滑揭示到 fullText 末尾。
  // rAF 每帧推进,落后越多追越快(gap/10)、最少每帧 1 字 → 稳态下显示略落后并「连续流出」,
  // 让"正在写"的流动感明显。非 active(done/历史)直接全显,不打字机。
  const fullTextRef = useRef("");
  fullTextRef.current = fullText;
  const [revealedLen, setRevealedLen] = useState(0);
  useEffect(() => {
    if (!active) {
      setRevealedLen(fullTextRef.current.length);
      return;
    }
    let raf = 0;
    const tick = () => {
      setRevealedLen((cur) => {
        const target = fullTextRef.current.length;
        if (cur >= target) return cur; // 追平则不再 setState(同值 React 跳过重渲染)
        const step = Math.max(1, Math.ceil((target - cur) / 10));
        return Math.min(target, cur + step);
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  const targetText = fullText || body.excerpt || "";
  const shownText = active ? targetText.slice(0, revealedLen) : targetText;

  // 可手动滚动:仅当用户停在底部时才自动跟随到底(滚上去看时不抢回)。
  const bodyRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const onBodyScroll = () => {
    const el = bodyRef.current;
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 14;
  };
  useEffect(() => {
    const el = bodyRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [shownText]);

  // 卡片已出现但工具还在请求、还没吐出内容 → 显「酝酿中」loading
  const brewing = active && !shownText;

  return (
    <div className="ws-draft-card" data-wf="DraftMiniCard" data-phase={body.phase}>
      {/* 顶:最左「草稿」标签 + 标题 */}
      <div className="ws-draft-head">
        <span className="ws-draft-tag">草稿</span>
        <span className="ws-draft-title">{body.title || "未命名"}</span>
      </div>
      {/* 中:正文(流式重建全文,可手动滚动;还没内容时显「酝酿中」) */}
      <div className="ws-draft-body" ref={bodyRef} onScroll={onBodyScroll}>
        {brewing ? (
          <div className="ws-draft-brewing">
            <span className="chat-loading-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            酝酿中
          </div>
        ) : (
          <div className="ws-draft-body-inner">
            {shownText}
            {active && <span className="ws-draft-caret">▍</span>}
          </div>
        )}
      </div>
      {/* 右下角:写作中显「目标自述」(不显已写字数);完成才显总字数 */}
      <div className="ws-draft-foot">
        {aborted ? (
          <span className="ws-draft-fail">已中止</span>
        ) : failed ? (
          <span className="ws-draft-fail">未完成</span>
        ) : done ? (
          <span className="ws-draft-count">
            {body.charCount} 字
            {statusLabel ? (
              <span className="ws-draft-status" style={{ color: TONE_COLOR[statusLabel.tone] }}>
                {" · "}
                {statusLabel.text}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="ws-draft-target">{targetDescLine(body)}</span>
        )}
      </div>
    </div>
  );
}

/** 目标字数自述(写作中右下角展示;不含已写字数)。 */
export function targetDescLine(body: WriteDraftCardBody): string {
  if (body.minLength != null && body.maxLength != null) return `目标 ${body.minLength}–${body.maxLength} 字`;
  if (body.maxLength != null) return `目标 ${body.maxLength} 字`;
  if (body.minLength != null) return `目标 ${body.minLength}+ 字`;
  return "自由长度";
}

/**
 * 把流式「滚动尾巴摘录」(每次是最后 N 字的快照,会随写作右移)合并重建成增长的全文。
 * - 新尾巴与已重建缓冲的末尾有重叠 → 只追加新增部分(平滑增长)。
 * - 尾巴完全包含在缓冲末尾(没新增)→ 维持。
 * - 完全无重叠(可能换了赛道/重来)→ 以新尾巴重建,避免拼接出乱码。
 * 导出供单测(对付不可信流式输入)。
 */
export function mergeTail(buffer: string, tail: string): string {
  if (!buffer) return tail;
  if (!tail) return buffer;
  if (buffer.endsWith(tail)) return buffer;
  const maxK = Math.min(buffer.length, tail.length);
  for (let k = maxK; k > 0; k--) {
    if (buffer.endsWith(tail.slice(0, k))) return buffer + tail.slice(k);
  }
  return tail;
}

/** lane 切换或 winner 全文帧必须替换缓冲；普通同 lane 尾帧才允许重叠续接。 */
export function mergeDraftExcerpt(buffer: string, excerpt: string, reset: boolean): string {
  return reset ? excerpt : mergeTail(buffer, excerpt);
}
