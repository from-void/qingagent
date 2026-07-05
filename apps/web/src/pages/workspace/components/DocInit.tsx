interface DocInitProps {
  mode?: "init" | "drafting" | "error";
  title?: string;
  subtitle?: string;
}

/**
 * Empty document placeholder. The init variant shows a static empty state
 * with a guiding message; the drafting variant shows a shimmer animation
 * while a document is being generated.
 */
export function DocInit({ mode = "init", title, subtitle }: DocInitProps) {
  const isDrafting = mode === "drafting";
  const isError = mode === "error";

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
            <div className="doc-empty-sub">{subtitle ?? (isDrafting ? "写作中 · 请稍候" : "请点击上方重试")}</div>
          </>
        )}
      </div>
    </div>
  );
}
