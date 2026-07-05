import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_HANZI_MATRIX_CONFIG,
  HANZI_MATRIX_POOLS,
  HANZI_MATRIX_PRESETS,
  MAX_HANZI_BASE_ALPHA,
  MAX_HANZI_CELL,
  MAX_HANZI_HI_RATIO,
  MAX_HANZI_HI_ALPHA,
  MAX_HANZI_MASK_BLUR,
  MAX_HANZI_MASK_HEIGHT,
  MAX_HANZI_MASK_STRENGTH,
  MAX_HANZI_MASK_WIDTH,
  MAX_HANZI_SPEED,
  MIN_HANZI_BASE_ALPHA,
  MIN_HANZI_CELL,
  MIN_HANZI_HI_RATIO,
  MIN_HANZI_HI_ALPHA,
  MIN_HANZI_MASK_BLUR,
  MIN_HANZI_MASK_HEIGHT,
  MIN_HANZI_MASK_STRENGTH,
  MIN_HANZI_MASK_WIDTH,
  MIN_HANZI_SPEED,
  getHanziMatrixConfig,
  setHanziMatrixConfig,
  subscribeHanziMatrixConfig,
  type HanziMatrixConfig,
  type HanziMatrixPoolKey,
  type HanziMatrixPresetKey,
} from "../data/hanziMatrixConfig";

// 汉字矩阵右下角调参面板。默认不渲染,由 NewSessionPage 的 Ctrl+Shift+H 唤起。

export function HanziMatrixPanel() {
  const [config, setConfig] = useState(() => getHanziMatrixConfig());

  useEffect(() => subscribeHanziMatrixConfig(setConfig), []);

  const update = useCallback((patch: Partial<HanziMatrixConfig>) => {
    setConfig(setHanziMatrixConfig(patch));
  }, []);

  const applyPreset = useCallback(
    (preset: HanziMatrixPresetKey) => {
      // 切预设时带上该预设建议的底色透明度
      update({ preset, baseAlpha: HANZI_MATRIX_PRESETS[preset].baseAlpha });
    },
    [update],
  );

  return (
    <div className="ccx-hzpanel" data-wf="HanziMatrixPanel">
      <div className="ccx-hzpanel-head">
        <span>汉字矩阵</span>
        <button
          type="button"
          className="ccx-hzpanel-reset"
          onClick={() => update(DEFAULT_HANZI_MATRIX_CONFIG)}
        >
          默认
        </button>
      </div>

      <label className="ccx-hzpanel-toggle">
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(e) => update({ enabled: e.currentTarget.checked })}
        />
        <span>启用背景矩阵</span>
      </label>

      <div className="ccx-hzpanel-group">
        <div className="ccx-hzpanel-label">风格</div>
        <div className="ccx-hzpanel-presets">
          {(Object.keys(HANZI_MATRIX_PRESETS) as HanziMatrixPresetKey[]).map((key) => (
            <button
              key={key}
              type="button"
              className={`ccx-hzpanel-preset${config.preset === key ? " is-active" : ""}`}
              onClick={() => applyPreset(key)}
            >
              {HANZI_MATRIX_PRESETS[key].name}
            </button>
          ))}
        </div>
      </div>

      <PanelSlider
        label="高亮比例(同时在闪的字占比)"
        value={config.hiRatio}
        min={MIN_HANZI_HI_RATIO}
        max={MAX_HANZI_HI_RATIO}
        step={0.02}
        valueText={`${Math.round(config.hiRatio * 100)}%`}
        onChange={(hiRatio) => update({ hiRatio })}
      />
      <PanelSlider
        label="节奏(越大越慢)"
        value={config.speed}
        min={MIN_HANZI_SPEED}
        max={MAX_HANZI_SPEED}
        step={0.1}
        valueText={`${config.speed.toFixed(1)}x`}
        onChange={(speed) => update({ speed })}
      />
      <PanelSlider
        label="底色字透明度"
        value={config.baseAlpha}
        min={MIN_HANZI_BASE_ALPHA}
        max={MAX_HANZI_BASE_ALPHA}
        step={0.02}
        valueText={config.baseAlpha.toFixed(2)}
        onChange={(baseAlpha) => update({ baseAlpha })}
      />
      <PanelSlider
        label="高亮字透明度(闪烁字符)"
        value={config.hiAlpha}
        min={MIN_HANZI_HI_ALPHA}
        max={MAX_HANZI_HI_ALPHA}
        step={0.05}
        valueText={config.hiAlpha.toFixed(2)}
        onChange={(hiAlpha) => update({ hiAlpha })}
      />
      <PanelSlider
        label="中心蒙版强度(中央字符淡出)"
        value={config.maskStrength}
        min={MIN_HANZI_MASK_STRENGTH}
        max={MAX_HANZI_MASK_STRENGTH}
        step={0.05}
        valueText={config.maskStrength.toFixed(2)}
        onChange={(maskStrength) => update({ maskStrength })}
      />
      <PanelSlider
        label="蒙版宽度"
        value={config.maskWidth}
        min={MIN_HANZI_MASK_WIDTH}
        max={MAX_HANZI_MASK_WIDTH}
        step={2}
        valueText={`${config.maskWidth}%`}
        onChange={(maskWidth) => update({ maskWidth })}
      />
      <PanelSlider
        label="蒙版高度"
        value={config.maskHeight}
        min={MIN_HANZI_MASK_HEIGHT}
        max={MAX_HANZI_MASK_HEIGHT}
        step={2}
        valueText={`${config.maskHeight}%`}
        onChange={(maskHeight) => update({ maskHeight })}
      />
      <PanelSlider
        label="中心模糊"
        value={config.maskBlur}
        min={MIN_HANZI_MASK_BLUR}
        max={MAX_HANZI_MASK_BLUR}
        step={0.5}
        valueText={config.maskBlur > 0 ? `${config.maskBlur.toFixed(1)}px` : "关"}
        onChange={(maskBlur) => update({ maskBlur })}
      />
      <PanelSlider
        label="格子大小"
        value={config.cell}
        min={MIN_HANZI_CELL}
        max={MAX_HANZI_CELL}
        step={2}
        valueText={`${config.cell}px`}
        onChange={(cell) => update({ cell })}
      />

      <div className="ccx-hzpanel-group">
        <div className="ccx-hzpanel-label">字符池</div>
        <select
          className="ccx-hzpanel-select"
          value={config.pool}
          onChange={(e) => update({ pool: e.currentTarget.value as HanziMatrixPoolKey })}
        >
          {(Object.keys(HANZI_MATRIX_POOLS) as HanziMatrixPoolKey[]).map((key) => (
            <option key={key} value={key}>
              {HANZI_MATRIX_POOLS[key].name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function PanelSlider({
  label,
  value,
  min,
  max,
  step,
  valueText,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  valueText: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="ccx-hzpanel-field">
      <span className="ccx-hzpanel-field-head">
        <span>{label}</span>
        <strong>{valueText}</strong>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
      />
    </label>
  );
}
