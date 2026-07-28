interface DocInitProps {
  mode?: "init" | "drafting" | "error";
  title?: string;
  subtitle?: string;
  /** 错误态自带的行动入口:给出即在卡面上渲染一枚「重试」按钮(不再让文案指向不存在的上方入口)。 */
  onRetry?: () => void;
  retryLabel?: string;
}

/**
 * Empty document placeholder. The init variant shows a static empty state
 * with a guiding message; the drafting variant shows a shimmer animation
 * while a document is being generated.
 */
export function DocInit({
  mode = "init",
  title,
  subtitle,
  onRetry,
  retryLabel = "重试",
}: DocInitProps) {
  const isDrafting = mode === "drafting";
  const isError = mode === "error";
  const showRetry = isError && !!onRetry;

  return (
    <div className={`doc-empty ${isDrafting ? "drafting" : ""}${isError ? " error" : ""}`} data-wf="DocInit">
      <div className="doc-empty-inner">
        {isDrafting ? (
          <div className="doc-drafting-page" aria-hidden="true">
            <div className="doc-drafting-line title" />
            <div className="doc-drafting-line wide" />
            <div className="doc-drafting-line" />
            <div className="doc-drafting-line mid" />
            <div className="doc-drafting-gap" />
            <div className="doc-drafting-line wide" />
            <div className="doc-drafting-line" />
          </div>
        ) : isError ? (
          <div className="doc-empty-title">{title ?? "恢复失败"}</div>
        ) : (
          <div className="doc-empty-loader" aria-hidden="true">
            <i /><i /><i /><i />
          </div>
        )}
        {/* 初始化(空)态不再展示默认文案;仅生成中给出进度提示。 */}
        {(isDrafting || isError) && (
          <>
            {isDrafting && <div className="doc-empty-title">{title ?? "正在生成文档…"}</div>}
            {/* 错误态默认不再写「请点击上方重试」——上方根本没有入口;行动交给下面这枚按钮。 */}
            {(isDrafting || subtitle) && (
              <div className="doc-empty-sub">{subtitle ?? "写作中 · 请稍候"}</div>
            )}
          </>
        )}
        {showRetry && (
          <button
            type="button"
            className="wf-btn doc-empty-retry"
            data-wf="DocInitRetry"
            onClick={onRetry}
          >
            {retryLabel}
          </button>
        )}
      </div>
    </div>
  );
}
