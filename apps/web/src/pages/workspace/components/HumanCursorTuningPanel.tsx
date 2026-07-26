import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_HUMAN_CURSOR_CONFIG,
  MAX_DRIFT_SPEED,
  MAX_FADE_DELAY_MS,
  MAX_JITTER,
  MIN_DRIFT_SPEED,
  MIN_FADE_DELAY_MS,
  MIN_JITTER,
  getHumanCursorConfig,
  setHumanCursorConfig,
  subscribeHumanCursorConfig,
  type HumanCursorRuntimeConfig,
} from "../data/humanCursorConfig";

interface HumanCursorTuningPanelProps {
  /** 当前是否处在可重播的审批态(有改动可重新逐字打字,鼠标随之重演) */
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

export function HumanCursorTuningPanel({ canReplay, onReplay }: HumanCursorTuningPanelProps) {
  const [config, setConfig] = useState(() => getHumanCursorConfig());
  const [collapsed, setCollapsed] = useState(true);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<DragState | null>(null);

  useEffect(() => subscribeHumanCursorConfig((next) => setConfig(next)), []);

  const updateConfig = useCallback((patch: Partial<HumanCursorRuntimeConfig>) => {
    setConfig(setHumanCursorConfig(patch));
  }, []);
  const resetConfig = useCallback(() => {
    setConfig(setHumanCursorConfig(DEFAULT_HUMAN_CURSOR_CONFIG));
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
    setOffset({ x: drag.originX + event.clientX - drag.startX, y: drag.originY + event.clientY - drag.startY });
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
      className={`presentation-tuning-panel human-cursor-tuning-panel${collapsed ? " is-collapsed" : ""}`}
      style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
      data-wf="HumanCursorTuningPanel"
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
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? "展开" : "收起"}
        >
          {collapsed ? "鼠标" : "−"}
        </button>
        {!collapsed && (
          <>
            <div className="ptp-title">
              <span>拟人鼠标</span>
              <small>{config.enabled ? "开" : "关"}</small>
            </div>
            <button type="button" className="ptp-reset" onClick={resetConfig}>
              默认
            </button>
          </>
        )}
      </div>

      {!collapsed && (
        <div className="ptp-body">
          <label className="ptp-toggle">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(e) => updateConfig({ enabled: e.currentTarget.checked })}
            />
            <span>启用鼠标</span>
            <small>叠加在打字光标上的拟人鼠标</small>
          </label>
          <TuningSlider
            label="飘移速度"
            value={config.driftSpeed}
            min={MIN_DRIFT_SPEED}
            max={MAX_DRIFT_SPEED}
            step={0.1}
            valueText={`${config.driftSpeed.toFixed(1)}x`}
            hint="右下缓慢漂移的快慢(0=不动)"
            onChange={(v) => updateConfig({ driftSpeed: v })}
          />
          <TuningSlider
            label="抖动幅度"
            value={config.jitter}
            min={MIN_JITTER}
            max={MAX_JITTER}
            step={0.1}
            valueText={`${config.jitter.toFixed(1)}x`}
            hint="模拟手抖的强度"
            onChange={(v) => updateConfig({ jitter: v })}
          />
          <TuningSlider
            label="淡出延迟"
            value={config.fadeDelayMs}
            min={MIN_FADE_DELAY_MS}
            max={MAX_FADE_DELAY_MS}
            step={50}
            valueText={`${config.fadeDelayMs}ms`}
            hint="光标消失后鼠标停留多久再淡出"
            onChange={(v) => updateConfig({ fadeDelayMs: v })}
          />
          <label className="ptp-toggle">
            <input
              type="checkbox"
              checked={config.edgeBubble}
              onChange={(e) => updateConfig({ edgeBubble: e.currentTarget.checked })}
            />
            <span>越界气泡</span>
            <small>鼠标滚出可视区时在边缘提示</small>
          </label>

          <div className="ptp-actions">
            <button
              type="button"
              className="ptp-replay"
              onClick={onReplay}
              disabled={!canReplay}
              title={canReplay ? "同步重播打字" : undefined}
            >
              重播鼠标
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
