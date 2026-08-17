import { useState } from "react";
import type { ReviewOutcome, ReviewOutcomeHunk } from "@qingagent/contract-ts";
import { ArrowRightIcon } from "./icons";

// 对话流里一轮 diff 审核结果的折叠卡片（以用户名义回流时渲染）。
// 折叠态只显示卡头;展开态显示全部修改。每处始终横排并单侧截断。
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

function CompactHunkRow({ hunk }: { hunk: ReviewOutcomeHunk }) {
  const beforeText = hunk.beforeText || "（新增）";
  const afterText = hunk.afterText || "（删除）";

  return (
    <div
      className="wf-rvo-detail wf-rvo-row"
      aria-label={`${hunk.blockSummary || "修改"}：${beforeText}改为${afterText}`}
    >
      <span className="wf-rvo-verdict">
        {hunk.verdict === "accepted" ? "已采纳" : "已拒绝"}
      </span>
      <span className="wf-rvo-text wf-rvo-before" title={beforeText}>{beforeText}</span>
      <span className="wf-rvo-arrow" aria-hidden="true"><ArrowRightIcon size={12} /></span>
      <span className="wf-rvo-text wf-rvo-after" title={afterText}>{afterText}</span>
    </div>
  );
}

export function ReviewOutcomeCard({ data }: { data: ReviewOutcome }) {
  const [open, setOpen] = useState(false);
  const hunks = data.hunks ?? [];
  const rejected = hunks.filter((h) => h.verdict === "rejected");
  // 计数以 hunks 为准派生,不直接信 payload 的 count,避免脏数据让卡片与明细发散。
  const rejectedCount = rejected.length;
  const acceptedCount = hunks.length - rejectedCount;
  const allRejected = acceptedCount === 0 && rejectedCount > 0;

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

      {open ? (
        <div className="u-card-bd">
          {/* 展开态逐处展示完整清单,长文本通过各自的 title 查看全文。 */}
          <div className="wf-rvo-list">
            {hunks.map((h, i) => (
              <CompactHunkRow hunk={h} key={`rvo-detail-${i}`} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
