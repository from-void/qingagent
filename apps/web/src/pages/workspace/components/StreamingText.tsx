import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  getStreamFxConfig,
  subscribeStreamFxConfig,
  type StreamFxConfig,
  type StreamFxSegMode,
} from "../data/streamFxConfig";

/** 订阅流式动画配置(临时调参面板会改它,真实聊天与预览实时跟随)。 */
export function useStreamFxConfig(): StreamFxConfig {
  const [cfg, setCfg] = useState(getStreamFxConfig);
  useEffect(() => subscribeStreamFxConfig(setCfg), []);
  return cfg;
}

const CJK_RE = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/;

/** 把文本切成"进场单元":auto=CJK 按字、拉丁按词(含尾随空白);char=全按字;word=全按空白分词。
 *  返回每段的文本 + 其在本文本中的字符偏移(用于稳定 key,使流式增长时只新段触发动画)。 */
export function segmentText(text: string, mode: StreamFxSegMode): { seg: string; offset: number }[] {
  const chars = Array.from(text);
  const out: { seg: string; offset: number }[] = [];
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i]!;
    if (mode === "char" || (mode === "auto" && CJK_RE.test(ch))) {
      out.push({ seg: ch, offset: i });
      i += 1;
      continue;
    }
    // 累积一个"词":到空白(含)或(auto 下)到 CJK 边界为止。
    let j = i;
    let s = "";
    while (j < chars.length) {
      const c = chars[j]!;
      if (mode === "auto" && CJK_RE.test(c)) break;
      s += c;
      j += 1;
      if (/\s/.test(c)) break;
    }
    out.push({ seg: s, offset: i });
    i = j;
  }
  return out;
}

/**
 * 流式文本的"逐段进场"渲染:把 text 切段,每段一个 span,挂载即按当前效果播动画。
 * key 用 baseKey + 段偏移(绝对位置)→ 流式增长时只有新段挂载触发动画,老段不重播。
 * 纯文本(不解析 markdown)——调用方负责把"已完成的行"用 markdown 渲染、只把"正在写的行"交给它。
 */
export function StreamingChars({
  text,
  baseKey,
  config,
}: {
  text: string;
  baseKey: number;
  config: StreamFxConfig;
}) {
  const segs = useMemo(() => segmentText(text, config.segMode), [text, config.segMode]);
  const style = {
    "--sfx-dur": `${config.durationMs}ms`,
    "--sfx-blur": `${config.blurPx}px`,
    "--sfx-slide": `${config.slideY}px`,
  } as CSSProperties;
  const cls = config.effect === "none" ? "sfx-seg" : `sfx-seg sfx-${config.effect}`;
  return (
    <>
      {segs.map(({ seg, offset }) => (
        <span key={baseKey + offset} className={cls} style={style}>
          {seg}
        </span>
      ))}
    </>
  );
}
