import { useMemo, useRef, useState } from "react";
import { useVisibilityPausedInterval } from "../../../system/perf/visibilityScheduler";
import { extractThinkingMarqueeSentences } from "./chatThinkingMarquee";

const ROTATE_MS = 1200; // 每条文案停留 ~1.2s 再切下一条

/**
 * 思考流「滚动文案」hook:把流式思考文本解析成每段首句的有序列表,
 * 每 ~0.7s 向后推进一条(队列里有下一条才推进),返回当前要展示的那句。
 */
export function useThinkingMarquee(thinkingText: string, active: boolean): string | null {
  const sentences = useMemo(() => extractThinkingMarqueeSentences(thinkingText), [thinkingText]);
  const [idx, setIdx] = useState(0);
  const lenRef = useRef(sentences.length);
  lenRef.current = sentences.length;

  useVisibilityPausedInterval(
    () => {
      // 队列里已有下一条才推进(否则停在最后一条,等新内容到了再走)
      setIdx((i) => (i < lenRef.current - 1 ? i + 1 : i));
    },
    active ? ROTATE_MS : null,
  );

  if (sentences.length === 0) return null;
  const clamped = Math.min(idx, sentences.length - 1);
  return sentences[clamped] ?? null;
}

/**
 * 思考流指示条(两行,无边框):
 *  第一行:三点 loading + 「思考中」(带从左到右流光扫光特效)—— 始终在,是兜底。
 *  第二行:当前滚动文案(解析出的思考首句,~1.2s 一条;最多两行截断)—— 有内容才出。
 * 仅在思考进行中渲染(由调用方控制)。
 */
export function ThinkingMarquee({ thinkingText, active }: { thinkingText: string; active: boolean }) {
  const line = useThinkingMarquee(thinkingText, active);
  return (
    <div className="ws-think-marquee" data-wf="ThinkingMarquee">
      <div className="ws-think-head">
        <span className="chat-loading-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className="ws-think-label">思考中</span>
      </div>
      {line ? <div className="ws-think-text">{line}</div> : null}
    </div>
  );
}
