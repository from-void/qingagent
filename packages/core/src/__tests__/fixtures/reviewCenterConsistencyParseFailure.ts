/**
 * R2:L1 评测证据：events-review.ndjson 只保留了解析失败后的 `{}`，原始坏参数未进入 SSE。
 * 下方 reconstructedInput 逐字段来自同一消息 reasoning 中列出的三组内容，并复现最可能的
 * note 裸半角双引号病；observed 是原始事件中可逐字核验的部分，二者刻意分开，避免伪称重建值是 raw。
 */
export const reviewCenterConsistencyParseFailure = {
  observed: {
    toolCallId: "call_00_vkEf8aR47L5g0b8KeokF2225",
    toolName: "create_annotation_groups",
    argsJson: "{}",
    error: "Tool \"create_annotation_groups\" received invalid arguments — the provided JSON could not be parsed. Please provide valid JSON arguments.",
  },
  reconstructedInput: [
    '{"groups":[',
    '{"summary":"融资时间冲突","note":"一处写"2022年11月"，另一处写"2023年"。","origin":"consistency","judgment":"时间线","documentQuote":"2023年完成B轮融资,融资额仍为8000万元","anchors":[{"find":"2022年11月,公司完成B轮融资"}]},',
    '{"summary":"收入合计不一致","note":"分项合计"1.13亿元"，与总额"1.2亿元"相差700万元。","origin":"consistency","judgment":"数字","documentQuote":"营业收入约1.2亿元","anchors":[{"find":"云服务收入6000万元、SaaS订阅收入3500万元、实施服务收入1800万元"}]},',
    '{"summary":"员工数前后不一","note":"一处为"186人"，另一处为"168人"。","origin":"consistency","judgment":"数字","documentQuote":"团队规模168人","anchors":[{"find":"公司员工186人"}]}',
    ']}',
  ].join(""),
} as const;
