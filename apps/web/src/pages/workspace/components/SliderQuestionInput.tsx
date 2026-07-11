import { useMemo } from "react";
import type { AskUserSliderSpec } from "@qingagent/contract-ts";

// F4 问卷滑块(AskUserOverlay 与 BigPlanPanel 共用):
// 原生 range 只承载可访问交互，视觉由自绘轨道、填充、菱形拇指和值气泡统一呈现。

export function SliderQuestionInput({
  qid,
  slider,
  value,
  onChange,
}: {
  qid: string;
  slider: AskUserSliderSpec;
  value: number | null;
  onChange: (value: number) => void;
}) {
  const current = normalizeSliderValue(slider, value);
  const safeMin = finiteNumber(slider.min) ?? 0;
  const safeMax = Math.max(safeMin, finiteNumber(slider.max) ?? safeMin);
  const safeStep = finitePositive(slider.step) ?? 1;
  const marks = useMemo(() => {
    if (slider.marks && slider.marks.length > 0) {
      return [...new Set(slider.marks.filter(Number.isFinite))];
    }
    // 无显式刻度时按 5 等分自动生成(含两端)。
    const out: number[] = [];
    for (let i = 0; i <= 4; i++) out.push(Math.round(safeMin + ((safeMax - safeMin) * i) / 4));
    return [...new Set(out.filter(Number.isFinite))];
  }, [safeMax, safeMin, slider.marks]);

  const label = sliderValueLabel(slider, current);
  const progress = safeMax > safeMin ? (current - safeMin) / (safeMax - safeMin) : 0;
  const progressPercent = `${progress * 100}%`;
  const bubbleOffset = `${(0.5 - progress) * 14}px`;

  return (
    <div className="aus2" data-wf="SliderQuestionInput">
      <div className="aus2-track-wrap">
        <div className="aus2-track" aria-hidden="true" />
        <div className="aus2-fill" aria-hidden="true" style={{ width: progressPercent }} />
        <output
          className="aus2-bubble font-mono"
          aria-live="polite"
          style={{ left: `calc(${progressPercent} + ${bubbleOffset})` }}
        >
          {label}
        </output>
        <input
          type="range"
          className="aus2-input"
          min={safeMin}
          max={safeMax}
          step={safeStep}
          value={current}
          onChange={(e) => onChange(normalizeSliderValue(slider, Number(e.target.value)))}
          aria-label="滑块选择"
          aria-valuetext={label}
        />
      </div>
      <div className="aus2-scale font-mono" aria-hidden="true">
        {marks.map((mark) => (
          <span key={mark} data-hit={mark <= current ? "true" : "false"}>
            {sliderMarkLabel(slider, mark)}
          </span>
        ))}
      </div>
    </div>
  );
}

function sliderMarkLabel(slider: AskUserSliderSpec, value: number): string {
  if (value >= slider.max && slider.aboveLabel) return slider.aboveLabel;
  return `${value}${slider.unit ?? ""}`;
}

/** 默认值取中点对齐 step。 */
export function defaultSliderValue(slider: AskUserSliderSpec): number {
  const safeStep = finitePositive(slider.step) ?? 1;
  const min = finiteNumber(slider.min) ?? 0;
  const max = finiteNumber(slider.max) ?? min;
  if (max <= min) return min;
  const mid = min + (max - min) / 2;
  const stepped = min + Math.round((mid - min) / safeStep) * safeStep;
  return Math.min(max, Math.max(min, stepped));
}

export function sliderValueLabel(slider: AskUserSliderSpec, value: number): string {
  const current = normalizeSliderValue(slider, value);
  const atMax = current >= slider.max;
  return atMax && slider.aboveLabel ? slider.aboveLabel : `${current}${slider.unit ?? ""}`;
}

function normalizeSliderValue(slider: AskUserSliderSpec, value: number | null): number {
  const min = finiteNumber(slider.min) ?? 0;
  const max = finiteNumber(slider.max) ?? min;
  if (max <= min) return min;
  const raw = finiteNumber(value) ?? defaultSliderValue(slider);
  return Math.min(max, Math.max(min, raw));
}

function finiteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finitePositive(value: number | null | undefined): number | null {
  const n = finiteNumber(value);
  return n !== null && n > 0 ? n : null;
}
