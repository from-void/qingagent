import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_REVEAL_PRESENTATION_CONFIG,
  MAX_REVEAL_CHARS_PER_TICK,
  MAX_REVEAL_CONCURRENCY,
  MAX_REVEAL_STEP_DELAY_MS,
  MAX_REVEAL_TAIL_HOLD_MS,
  MIN_REVEAL_CHARS_PER_TICK,
  MIN_REVEAL_CONCURRENCY,
  MIN_REVEAL_STEP_DELAY_MS,
  MIN_REVEAL_TAIL_HOLD_MS,
  getRevealPresentationConfig,
  setRevealPresentationConfig,
  subscribeRevealPresentationConfig,
  type RevealPresentationRuntimeConfig,
} from "../data/revealPresentationConfig";

interface RevealTuningPanelProps {
  /** 当前是否处在可重播的审批态(有改动可重新逐处入场)。 */
  canReplay: boolean;
  onReplay: () => void;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
}

export function RevealTuningPanel({ canReplay, onReplay }: RevealTuningPanelProps) {
  const [config, setConfig] = useState(() => getRevealPresentationConfig());
  const [collapsed, setCollapsed] = useState(true);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<DragState | null>(null);

  useEffect(() => subscribeRevealPresentationConfig((next) => setConfig(next)), []);

  const updateConfig = useCallback(
    (patch: Partial<RevealPresentationRuntimeConfig>) => {
      setConfig(setRevealPresentationConfig(patch));
    },
    [],
  );

  const resetConfig = useCallback(() => {
    setConfig(setRevealPresentationConfig(DEFAULT_REVEAL_PRESENTATION_CONFIG));
  }, []);

  const handleDragStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement;
      if (target.closest("button,input")) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: offset.x,
        originY: offset.y,
      };
    },
    [offset.x, offset.y],
  );

  const handleDragMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setOffset({
      x: drag.originX + event.clientX - drag.startX,
      y: drag.originY + event.clientY - drag.startY,
    });
  }, []);

  const handleDragEnd = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  return (
    <div
      className={`presentation-tuning-panel reveal-tuning-panel${collapsed ? " is-collapsed" : ""}`}
      style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
      data-wf="RevealTuningPanel"
    >
      <div
        className="ptp-header"
        onPointerDown={handleDragStart}
        onPointerMove={handleDragMove}
        onPointerUp={handleDragEnd}
        onPointerCancel={handleDragEnd}
      >
        <button
          type="button"
          className="ptp-collapse"
          onClick={() => setCollapsed((value) => !value)}
          title={collapsed ? "展开入场调试" : "收起入场调试"}
        >
          {collapsed ? "入场" : "−"}
        </button>
        {!collapsed && (
          <>
            <div className="ptp-title">
              <span>入场打字</span>
              <small>
                {config.concurrency} 光标 · {config.charsPerTick} 字/{config.stepDelayMs}ms
              </small>
            </div>
            <button type="button" className="ptp-reset" onClick={resetConfig}>
              默认
            </button>
          </>
        )}
      </div>

      {!collapsed && (
        <div className="ptp-body">
          <TuningSlider
            label="并发数"
            value={config.concurrency}
            min={MIN_REVEAL_CONCURRENCY}
            max={MAX_REVEAL_CONCURRENCY}
            step={1}
            valueText={`${config.concurrency} 光标`}
            hint="同时打字的改动处数 = 光标数"
            onChange={(concurrency) => updateConfig({ concurrency })}
          />
          <TuningSlider
            label="节拍"
            value={config.stepDelayMs}
            min={MIN_REVEAL_STEP_DELAY_MS}
            max={MAX_REVEAL_STEP_DELAY_MS}
            step={5}
            valueText={`${config.stepDelayMs}ms`}
            hint="逐字打字节拍,越小越快"
            onChange={(stepDelayMs) => updateConfig({ stepDelayMs })}
          />
          <TuningSlider
            label="每拍字数"
            value={config.charsPerTick}
            min={MIN_REVEAL_CHARS_PER_TICK}
            max={MAX_REVEAL_CHARS_PER_TICK}
            step={1}
            valueText={`${config.charsPerTick} 字`}
            hint="每拍每个光标吐出的字数"
            onChange={(charsPerTick) => updateConfig({ charsPerTick })}
          />
          <TuningSlider
            label="末尾停留"
            value={config.tailHoldMs}
            min={MIN_REVEAL_TAIL_HOLD_MS}
            max={MAX_REVEAL_TAIL_HOLD_MS}
            step={30}
            valueText={`${config.tailHoldMs}ms`}
            hint="收尾光标停留后再升起审批条"
            onChange={(tailHoldMs) => updateConfig({ tailHoldMs })}
          />

          <label className="ptp-toggle">
            <input
              type="checkbox"
              checked={config.glow}
              onChange={(event) => updateConfig({ glow: event.currentTarget.checked })}
            />
            <span>发光特效</span>
            <small>正文环境辉光 + 入场柔化</small>
          </label>

          <div className="ptp-actions">
            <button
              type="button"
              className="ptp-replay"
              onClick={onReplay}
              disabled={!canReplay}
              title={canReplay ? "用当前参数重新逐字打字" : "进入审批态后可重播"}
            >
              重播打字
            </button>
            {!canReplay && <span>审批态可用</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function TuningSlider({
  label,
  value,
  min,
  max,
  step,
  valueText,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  valueText: string;
  hint?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="ptp-field">
      <span className="ptp-field-head">
        <span>{label}</span>
        <strong>{valueText}</strong>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
      {hint && <span className="ptp-hint">{hint}</span>}
    </label>
  );
}
