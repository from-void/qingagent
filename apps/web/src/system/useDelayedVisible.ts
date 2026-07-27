// 加载态延迟显形:设置页各 tab 的数据大多在几十毫秒内就回来了,
// 一挂载就渲染「加载中…」会造成一闪而过的闪烁(看着像页面抖了一下)。
// 这里统一口径:只有当加载持续超过 delayMs(默认 250ms)才把占位显出来;
// 更快回来的请求全程无占位,视觉上直接出内容。
import { useEffect, useState } from "react";

export function useDelayedVisible(active: boolean, delayMs = 250): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [active, delayMs]);

  return visible;
}
