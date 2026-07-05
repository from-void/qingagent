import { useMemo } from "react";
import type { AskUserSliderSpec } from "@qingagent/contract-ts";

// F4 问卷滑块(AskUserOverlay 与 BigPlanPanel 共用):
// 原生 range + datalist 刻度;右侧实时显示当前值文案,滑到最右显示 aboveLabel(「X 以上」)。

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
  const listId = `slider-marks-${qid}`;
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

  return (
    <div className="au-slider" data-wf="SliderQuestionInput">
      <input
        type="range"
        className="au-slider-input"
        min={safeMin}
        max={safeMax}
        step={safeStep}
        value={current}
        list={listId}
        onChange={(e) => onChange(normalizeSliderValue(slider, Number(e.target.value)))}
        aria-label="滑块选择"
      />
      <datalist id={listId}>
        {marks.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <output className="au-slider-value font-mono" aria-live="polite">
        {label}
      </output>
      <div className="au-slider-scale font-mono">
        <span>{safeMin}{slider.unit ?? ""}</span>
        <span>{slider.aboveLabel ?? `${safeMax}${slider.unit ?? ""}`}</span>
      </div>
    </div>
  );
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
