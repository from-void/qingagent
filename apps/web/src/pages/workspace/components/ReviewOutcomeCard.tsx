import { useState } from "react";
import type { ReviewOutcome, ReviewOutcomeHunk } from "@qingagent/contract-ts";

// 对话流里一轮 diff 审核结果的缩略卡片（以用户名义回流时渲染）。
// 默认态:卡头计数 + 被拒项逐条一行简述（截断）;展开后看每处完整 before/after。
// 处于 .ws-chat .u-scope 作用域内,复用 u-card token,无需额外包裹。

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`u-card-chev${open ? " is-open" : ""}`}
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function HunkDetail({ hunk }: { hunk: ReviewOutcomeHunk }) {
  return (
    <div className="wf-rvo-detail" style={{ padding: "6px 0", borderTop: "var(--u-border)" }}>
      <div style={{ display: "flex", gap: 6, alignItems: "baseline", marginBottom: 4 }}>
        <span
          style={{
            flex: "none",
            fontSize: 11,
            color: hunk.verdict === "accepted" ? "var(--u-ink-soft)" : "var(--u-ink-faint)",
          }}
        >
          {hunk.verdict === "accepted" ? "已采纳" : "已拒绝"}
        </span>
        <span
          style={{
            color: "var(--u-ink)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={hunk.blockSummary}
        >
          {hunk.blockSummary || "（未命名片段）"}
        </span>
      </div>
      {/* 始终渲染原/新两行,纯插入/纯删除时也让用户看清另一侧是「（空）」。 */}
      <div className="wf-rvo-before" style={{ color: "var(--u-ink-faint)", whiteSpace: "pre-wrap", marginBottom: 2 }}>
        <span style={{ userSelect: "none", marginRight: 6 }}>原</span>
        {hunk.beforeText || "（空）"}
      </div>
      <div className="wf-rvo-after" style={{ color: "var(--u-ink-soft)", whiteSpace: "pre-wrap" }}>
        <span style={{ userSelect: "none", marginRight: 6 }}>新</span>
        {hunk.afterText || "（空）"}
      </div>
    </div>
  );
}

/** 缩略态被拒项最多列几条,超出折叠成「另 N 处…」,避免气泡过长。 */
const COLLAPSED_REJECTED_CAP = 4;

export function ReviewOutcomeCard({ data }: { data: ReviewOutcome }) {
  const [open, setOpen] = useState(false);
  const hunks = data.hunks ?? [];
  const rejected = hunks.filter((h) => h.verdict === "rejected");
  // 计数以 hunks 为准派生,不直接信 payload 的 count,避免脏数据让卡片与明细发散。
  const rejectedCount = rejected.length;
  const acceptedCount = hunks.length - rejectedCount;
  const allRejected = acceptedCount === 0 && rejectedCount > 0;
  const briefRejected = rejected.slice(0, COLLAPSED_REJECTED_CAP);
  const moreRejected = rejectedCount - briefRejected.length;

  return (
    <div className="u-card wf-rvo-card" data-wf="ReviewOutcomeCard" style={{ marginBottom: 2 }}>
      <button
        type="button"
        className="u-card-hd"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="u-card-ico" aria-hidden="true">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
            <path d="M4 12l5 5 11-11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="u-card-title">审核反馈</span>
        <span className="u-card-sub">
          {allRejected
            ? `放弃本轮全部 ${rejectedCount} 处修改`
            : `采纳 ${acceptedCount} 处 · 拒绝 ${rejectedCount} 处`}
        </span>
        <span className="u-card-meta">
          <Chevron open={open} />
        </span>
      </button>

      <div className="u-card-bd">
        {!open ? (
          // 缩略态:只列被拒项一行简述,引导用户/模型聚焦未采纳的内容。
          rejectedCount > 0 ? (
            <div className="u-list">
              {briefRejected.map((h, i) => (
                <div className="u-list-row" key={`rvo-brief-${i}`}>
                  <span className="u-list-ico" aria-hidden="true">✕</span>
                  <div className="u-list-main">
                    <div className="u-list-title" title={h.blockSummary}>
                      {h.blockSummary || "（未命名片段）"}
                    </div>
                  </div>
                </div>
              ))}
              {moreRejected > 0 ? (
                <div className="u-list-row" key="rvo-brief-more">
                  <span className="u-list-ico" aria-hidden="true">…</span>
                  <div className="u-list-main">
                    <div className="u-list-title" style={{ color: "var(--u-ink-faint)" }}>
                      另 {moreRejected} 处（点击展开查看）
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div style={{ color: "var(--u-ink-faint)" }}>全部修改已采纳</div>
          )
        ) : (
          // 展开态:逐处完整 before/after。
          <div>
            {(data.hunks ?? []).map((h, i) => (
              <HunkDetail hunk={h} key={`rvo-detail-${i}`} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
