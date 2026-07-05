// 可注入时钟:生产恒用真实系统时间;测试通过 __setTimeProviderForTest 固定时钟,
// 让时间锚断言可确定(原环境变量开关已转正删除,时间注入恒开)。
let nowProvider: () => Date = () => new Date();

/** 仅供测试:替换时间源;传 null 恢复真实系统时钟。 */
export function __setTimeProviderForTest(provider: (() => Date) | null): void {
  nowProvider = provider ?? (() => new Date());
}

// 每轮无条件注入服务器系统时间,让模型知道"今天几月几日、现在几点",处理时效性内容
// (年份、"今年""最近""目前"等)时有据可依。用本地系统时间(getFullYear/.../getDay 均为
// 服务器本地时区),即用户所说的"系统时间"。
export function currentDateTimeContext(): string {
  const now = nowProvider();
  const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ` +
    `${weekdays[now.getDay()]} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `\n\n[系统：当前日期与时间(服务器系统时间)＝${stamp}。涉及"今天/现在/今年/最近"等时效性内容时以此为准。]`;
}
