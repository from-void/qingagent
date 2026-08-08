import type { Dispatch, SetStateAction } from "react";
import { CalendarDatePicker } from "../../system/CalendarDatePicker";
import { SkinMultiSelect } from "../../system/SkinMultiSelect";
import {
  HelpMark,
  UsageTableRow,
  modelLabel,
  type UsageGroup,
  type UsageMode,
  type UsageRow,
  type UsageView,
} from "./modelUsage";

interface ModelUsageDetailsProps {
  usageMode: UsageMode;
  toggleUsageMode: () => void;
  usageView: UsageView;
  usageDate: string;
  todayYmd: string;
  usageDates: Set<string>;
  setUsageDate: Dispatch<SetStateAction<string>>;
  usageModelIds: string[];
  selectedModelIds: string[];
  toggleUsageModel: (modelId: string) => void;
  selectAllUsageModels: () => void;
  allModelsSelected: boolean;
  switchUsageView: (view: UsageView) => void;
  usageDateUnsupported: boolean;
  usageSettled: boolean;
  showUsageLoading: boolean;
  usageStatus: "loading" | "ready" | "error";
  filteredUsage: UsageRow[] | null;
  usageGroups: UsageGroup[] | null;
  expandedUsageGroups: Set<string>;
  toggleUsageGroup: (key: string) => void;
  scheduleRevision: string;
}
export function ModelUsageDetails({
  usageMode,
  toggleUsageMode,
  usageView,
  usageDate,
  todayYmd,
  usageDates,
  setUsageDate,
  usageModelIds,
  selectedModelIds,
  toggleUsageModel,
  selectAllUsageModels,
  allModelsSelected,
  switchUsageView,
  usageDateUnsupported,
  usageSettled,
  showUsageLoading,
  usageStatus,
  filteredUsage,
  usageGroups,
  expandedUsageGroups,
  toggleUsageGroup,
  scheduleRevision,
}: ModelUsageDetailsProps) {
  return (
              <div className="md-card md-detail-card">
                <div className="md-block-head">
                  <button
                    type="button"
                    className="md-usage-mode-toggle"
                    aria-label={`用量明细，当前${usageMode === "expert" ? "专家" : "小白"}模式，点击切换`}
                    aria-pressed={usageMode === "expert"}
                    onClick={toggleUsageMode}
                    data-wf="UsageModeToggle"
                  >
                    <span className="md-card-title">用量明细</span>
                  </button>
                  <span className="md-detail-filters">
                    {/* 日期只对「按天」有意义:按文档 / 总计是服务端聚合结果,整控件隐藏。
                        清除语义并入日历浮层内部的「清除日期」,头部不再另放清除钮。 */}
                    {usageView === "day" && (
                      <span className="md-date-filter" data-wf="UsageDateFilter">
                        <CalendarDatePicker
                          value={usageDate}
                          max={todayYmd}
                          markedDates={usageDates}
                          onlyMarkedDatesSelectable
                          title="仅筛选已加载的按天用量"
                          ariaLabel="筛选用量日期"
                          skin="ink"
                          onChange={setUsageDate}
                        />
                      </span>
                    )}
                    {/* 模型多选:选项动态取自统计里出现过的模型,默认全选,三种视图都保留 */}
                    <SkinMultiSelect
                      className="md-model-filter"
                      ariaLabel="筛选用量模型"
                      skin="ink"
                      allLabel="全部"
                      disabled={usageModelIds.length === 0}
                      options={usageModelIds.map((modelId) => ({
                        value: modelId,
                        label: modelLabel(modelId),
                      }))}
                      selected={selectedModelIds}
                      onToggle={toggleUsageModel}
                      onSelectAll={selectAllUsageModels}
                      summaryLabel={
                        allModelsSelected || usageModelIds.length === 0
                          ? "全部"
                          : `${selectedModelIds.length} 个模型`
                      }
                      dataWf="UsageModelFilter"
                    />
                    <span className="md-views md-views--right">
                      {(["day", "session", "total"] as const).map((v) => (
                        <button
                          key={v}
                          type="button"
                          aria-pressed={usageView === v}
                          className={`md-view-btn${usageView === v ? " md-active" : ""}`}
                          onClick={() => switchUsageView(v)}
                        >
                          {v === "day" ? "按天" : v === "session" ? "按文档" : "总计"}
                        </button>
                      ))}
                    </span>
                  </span>
                  </div>
                  {usageDateUnsupported && (
                    <p className="md-filter-note">日期筛选仅支持按天视图;按文档和总计是服务端聚合结果,不会按日期裁剪。</p>
                  )}
                  {!usageSettled ? (
                    showUsageLoading ? <p className="md-empty">加载中…</p> : null
                  ) : usageStatus === "loading" ? (
                    <p className="md-empty">正在加载用量数据</p>
                  ) : usageStatus === "error" || filteredUsage === null ? (
                    <p className="md-empty">用量数据暂时无法加载，请稍后重试</p>
                  ) : usageGroups?.length === 0 ? (
                    <p className="md-empty">
                      {usageDate && usageView === "day"
                        ? "该日期暂无用量记录"
                        : allModelsSelected || usageModelIds.length === 0
                          ? "还没有用量记录,开始一次对话后这里会出现消耗明细"
                          : "所选模型暂无用量记录"}
                    </p>
                  ) : (
                    <div className="md-table-scroll">
                      <table className={`md-table md-table--${usageMode}`} data-wf="UsageDetailTable">
                      <thead>
                        <tr>
                          <th>
                            <span className="md-th-label">
                              {usageView === "day" ? "日期" : usageView === "session" ? "文档" : "范围"}
                              <HelpMark label="范围" text="当前行统计覆盖的日期、文档或总计范围。" />
                            </span>
                          </th>
                          {usageMode === "expert" && (
                            <th>
                              <span className="md-th-label">
                                模型
                                <HelpMark label="模型" text="按模型名聚合后的用量分组。" />
                              </span>
                            </th>
                          )}
                          {usageMode === "expert" && (
                            <>
                              <th>
                                <span className="md-th-label">
                                  调用点
                                  <HelpMark label="调用点" text="产生这笔模型请求的功能入口；missing 请求也计入该组调用数和覆盖率。" />
                                </span>
                              </th>
                              <th>
                                <span className="md-th-label">
                                  请求覆盖
                                  <HelpMark label="请求覆盖" text="有 usage 的请求数 / 全部真实请求数；缺失请求仍计入分母。" />
                                </span>
                              </th>
                            </>
                          )}
                          <th>
                            <span className="md-th-label">
                              输入
                              <HelpMark label="输入 token" text="该范围内发送给模型的输入 token 总量。" />
                            </span>
                          </th>
                          <th>
                            <span className="md-th-label">
                              输出
                              <HelpMark label="输出 token" text="该范围内模型生成的输出 token 总量。" />
                            </span>
                          </th>
                          <th>
                            <span className="md-th-label">
                              {usageMode === "simple" ? "缓存命中率" : "总命中率"}
                              {usageMode === "simple" ? (
                                <HelpMark
                                  label="缓存命中率"
                                  text="排除每个会话在各调用点首次请求的建缓存部分（该部分必然未命中）；衡量的是“在可能命中的输入里，实际命中了多少”。"
                                />
                              ) : (
                                <HelpMark
                                  label="总命中率"
                                  text="总命中率=命中÷（命中+未命中）；未知记账态不参与分子和分母。"
                                />
                              )}
                            </span>
                          </th>
                          {usageMode === "expert" && (
                            <th>
                              <span className="md-th-label">
                                建缓存
                                <HelpMark
                                  label="建缓存"
                                  text="每个会话在各调用点首次请求的未命中 token；输入=命中+未命中；有效命中率=命中÷（输入−建缓存）。"
                                />
                              </span>
                            </th>
                          )}
                          <th>
                            <span className="md-th-label">
                              估算费用
                              <HelpMark label="估算费用" text="按各厂商已核实的公开单价估算；未收录价目的自定义模型只记 token。" />
                            </span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {usageGroups?.flatMap((group) => {
                          const isExpanded = expandedUsageGroups.has(group.key);
                          const groupRow = (
                            <UsageTableRow
                              key={group.key}
                              row={group.summary}
                              label={group.label}
                              mode={usageMode}
                              kind="group"
                              expanded={isExpanded}
                              childCount={new Set(group.rows.map((row) => row.callSite)).size}
                              onToggle={() => toggleUsageGroup(group.key)}
                            />
                          );
                          if (usageMode === "simple" || !isExpanded) return [groupRow];
                          if (usageView === "day" && group.children) {
                            return [
                              groupRow,
                              ...group.children.flatMap((documentGroup) => {
                                const isDocumentExpanded = expandedUsageGroups.has(documentGroup.key);
                                const documentRow = (
                                  <UsageTableRow
                                    key={documentGroup.key}
                                    row={documentGroup.summary}
                                    label={documentGroup.label}
                                    mode={usageMode}
                                    kind="document"
                                    expanded={isDocumentExpanded}
                                    childCount={new Set(documentGroup.rows.map((row) => row.callSite)).size}
                                    onToggle={() => toggleUsageGroup(documentGroup.key)}
                                  />
                                );
                                if (!isDocumentExpanded) return [documentRow];
                                return [
                                  documentRow,
                                  ...documentGroup.rows.map((row, index) => (
                                    <UsageTableRow
                                      key={`${documentGroup.key}:${row.callSite}:${row.modelId}:${index}`}
                                      row={row}
                                      label=""
                                      mode={usageMode}
                                      kind="detail"
                                    />
                                  )),
                                ];
                              }),
                            ];
                          }
                          return [
                            groupRow,
                            ...group.rows.map((row, index) => (
                              <UsageTableRow
                                key={`${group.key}:${row.callSite}:${row.modelId}:${index}`}
                                row={row}
                                label=""
                                mode={usageMode}
                                kind="detail"
                              />
                            )),
                          ];
                        })}
                      </tbody>
                      </table>
                    </div>
                  )}
                <p className="md-foot-note">
                  范围仅含本机本实例账本；结果未知的失败调用单列且不计 token/金额。费用按各厂商已核实的公开单价估算；未收录价目的自定义模型只记录 token，不估算金额。
                  {scheduleRevision ? ` 价目版本 ${scheduleRevision.slice(0, 16)}` : ""}
                </p>
              </div>
  );
}
