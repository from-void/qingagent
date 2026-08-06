import {
  AnimatedNumber,
  PIE_COLORS,
  fmtMoney,
  fmtWords,
  formatTokens,
  pieGradient,
  type buildDailyTrend,
  type buildModelDistribution,
  type summarizeRecentDays,
} from "./modelUsage";

interface ModelUsageDashboardProps {
  recent: ReturnType<typeof summarizeRecentDays>;
  usageTimeZone: string;
  docStats: { docs: number; words: number } | null;
  docs7: number;
  words7: number;
  avgPerDoc: number | null;
  docsPer10: number | null;
  dashboardReady: boolean;
  showDashboardLoading: boolean;
  modelDist: ReturnType<typeof buildModelDistribution>;
  trend: ReturnType<typeof buildDailyTrend>;
  pendingSub: string;
}

export function ModelUsageDashboard({
  recent,
  usageTimeZone,
  docStats,
  docs7,
  words7,
  avgPerDoc,
  docsPer10,
  dashboardReady,
  showDashboardLoading,
  modelDist,
  trend,
  pendingSub,
}: ModelUsageDashboardProps) {
  // 低于 95% 已足以让金额产生可感知偏差，同时不给偶发单次缺帧过度报警。
  const coverageNeedsAttention =
    recent !== null && recent.calls > 0 && recent.coverageRate < 0.95;
  return (
              <div className="md-card md-usage">
                <h3 className="md-card-title">用量看板</h3>
                <div className="md-metrics md-metrics--3">
                  <div className="md-metric">
                    <div className="md-metric-label">近 7 天花费</div>
                    <div className="md-metric-scope">本机本实例 · {usageTimeZone}</div>
                    <div className="md-metric-value-row">
                      <div className="md-metric-value md-value-accent font-mono" title="provider 返回 usage 的精确金额">
                        {recent?.hasPriced
                          ? <AnimatedNumber value={recent.cost} format={fmtMoney} />
                          : "—"}
                      </div>
                      {recent && recent.calls > 0 ? (
                        <span className="md-usage-coverage">
                          精确覆盖 {Math.round(recent.coverageRate * 100)}%
                        </span>
                      ) : null}
                    </div>
                    <div className="md-metric-sub">
                      {!dashboardReady ? pendingSub : recent ? `${formatTokens(recent.tokens)} tokens` : "暂无记录"}
                    </div>
                    {dashboardReady && recent && recent.estimatedCalls > 0 ? (
                      <div className="md-metric-estimated" data-wf="UsageEstimatedCost">
                        另有 {recent.estimatedCalls} 次估算 · 估算 {fmtMoney(recent.estimatedCost)}
                      </div>
                    ) : null}
                    {dashboardReady && coverageNeedsAttention && recent.missingCalls > 0 ? (
                      <div className="md-metric-coverage-note" data-wf="UsageCoverageWarning">
                        另有 {recent.missingCalls} 次调用未计价，实际消费高于此数
                      </div>
                    ) : null}
                  </div>

                  <div className="md-metric">
                    <div className="md-metric-label">近 7 天产出</div>
                    <div className="md-metric-value font-mono">
                      {docStats ? <AnimatedNumber value={docs7} format={(n) => `${Math.round(n)} 篇`} /> : "—"}
                    </div>
                    <div className="md-metric-sub">
                      {!dashboardReady ? pendingSub : docStats ? fmtWords(words7) : "暂无记录"}
                    </div>
                  </div>

                  <div className="md-metric">
                    <div className="md-metric-label">平均每篇</div>
                    <div className="md-metric-value font-mono">
                      {avgPerDoc != null ? <AnimatedNumber value={avgPerDoc} format={fmtMoney} /> : "—"}
                    </div>
                    <div className="md-metric-sub">
                      {!dashboardReady
                        ? pendingSub
                        : docsPer10 != null
                          ? `每 10 元约可写 ${Math.floor(docsPer10)} 篇`
                          : "需有消耗与文档"}
                    </div>
                  </div>
                </div>

                <div className="md-row">
                  <div className="md-block md-col">
                    <div className="md-block-head">
                      <span className="md-block-title">按模型分布</span>
                      <span className="md-block-sub">累计费用占比</span>
                    </div>
                    {!dashboardReady ? (
                      showDashboardLoading ? <p className="md-empty">加载中…</p> : null
                    ) : modelDist === null ? (
                      <p className="md-empty">加载失败或暂不可用</p>
                    ) : modelDist.length === 0 ? (
                      <p className="md-empty">还没有用量记录,对话后出现</p>
                    ) : (
                      <div className="md-pie-wrap">
                        <div className="md-pie" style={{ background: pieGradient(modelDist) }} aria-hidden="true" />
                        <ul className="md-pie-legend">
                          {modelDist.map((m, i) => (
                            <li
                              className="md-legend-item"
                              key={m.name}
                              title={`${formatTokens(m.tokens)} tokens`}
                            >
                              <span className="md-legend-dot" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                              <span className="md-legend-name">{m.name}</span>
                              <span className="md-legend-num">
                                {m.pct.toFixed(0)}% · <span className="md-model-cost">{fmtMoney(m.cost)}</span>
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>

                  <div className="md-block md-col">
                    <div className="md-block-head">
                      <span className="md-block-title">按天趋势</span>
                      <span className="md-block-sub">近 {trend?.days.length ?? 15} 天</span>
                    </div>
                    {!dashboardReady ? (
                      showDashboardLoading ? <p className="md-empty">加载中…</p> : null
                    ) : trend === null ? (
                      <p className="md-empty">加载失败或暂不可用</p>
                    ) : trend.days.length === 0 ? (
                      <p className="md-empty">还没有用量记录,对话后出现</p>
                    ) : (
                      <>
                        <div className="md-trend">
                          {trend.days.map((d, i) => {
                            const h = trend.max > 0 ? Math.round((d.cost / trend.max) * 100) : 0;
                            const title = `${d.date} · ¥${d.cost.toFixed(3)} · ${formatTokens(d.tokens)} tokens`;
                            return (
                              <div className="md-trend-col" key={d.date} title={title} aria-label={title}>
                                <div
                                  className={`md-trend-bar${d.cost > 0 ? "" : " md-trend-bar--empty"}`}
                                  style={{ height: d.cost > 0 ? `${Math.max(4, h)}%` : "2px", animationDelay: `${i * 25}ms` }}
                                />
                              </div>
                            );
                          })}
                        </div>
                        <div className="md-trend-axis">
                          <span>{trend.days[0]?.label}</span>
                          <span>{trend.days[trend.days.length - 1]?.label}</span>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>
  );
}
