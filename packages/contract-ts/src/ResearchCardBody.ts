// 工具卡:webSearch(搜索即抓取)的逐行抓取进度 + 折叠汇总。
// 数据流:webSearch 工具 execute 期间经 context.writer 逐条 emit research 进度 →
// 桥接 processAgentStream 转 toolCallUpdated(body.kind="researchCard")→ 前端 ResearchCard.tsx 渲染。
// 卡片只承载"展示态"(不含抓到的正文全文,正文只在 tool result 里给模型 + 缓存供 storeMaterial 绑定)。

/** 单条检索结果的抓取状态。 */
export type ResearchItemStatus =
  | "pending" // 待抓取(灰虚线点)
  | "fetching" // 静态抓取中(ochre 转圈)
  | "browser" // 浏览器降级抓取中(ochre 转圈 + 「经浏览器」标)
  | "done" // 抓到实质正文(对勾 + 字数)
  | "skipped"; // 空壳/失败,略过(中性短横)

export interface ResearchCardItem {
  url: string;
  title: string;
  status: ResearchItemStatus;
  /** 抓到的正文字数;done/browser 完成才有,其余为 null。 */
  wordCount: number | null;
}

export interface ResearchCardBody {
  /** 检索词。 */
  query: string;
  /**
   * searching = 已发起检索、列表还没回来;
   * fetching = 列表已出、正逐行抓取;
   * done = 全部抓完、折叠成汇总。
   */
  phase: "searching" | "fetching" | "done";
  /** 检索召回的结果行(随抓取推进逐条更新 status/wordCount)。 */
  items: ResearchCardItem[];
  /** 召回总条数;searching 阶段为 null。 */
  total: number | null;
  /** 已抓完条数(done + skipped)。 */
  fetchedCount: number;
  /** 成功抓到实质正文的条数(done,含浏览器降级)。 */
  okCount: number;
  /** 空壳/失败略过的条数。 */
  skippedCount: number;
}
