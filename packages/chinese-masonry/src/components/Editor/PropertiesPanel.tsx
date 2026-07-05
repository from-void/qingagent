import { RgbaStringColorPicker } from 'react-colorful';
import type { ImageElement, LineElement, TemplateTextCapacity, TextCapacityInfo, TextElement } from '../../templates/types';
import { calculateTemplateTextCapacity } from '../../templates/capacity';
import { useEditorStore } from './store';

function NumberInput({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="cm-editor-field">
      <span>{label}</span>
      <input
        aria-label={label}
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
      />
    </label>
  );
}

function SliderNumberInput({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  const updateValue = (rawValue: string) => {
    const next = Number(rawValue);
    if (!Number.isFinite(next)) return;
    onChange(Math.min(max, Math.max(min, next)));
  };

  return (
    <label className="cm-editor-field cm-editor-range-field">
      <span>{label}</span>
      <div className="cm-editor-range-row">
        <input
          aria-label={label}
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(event) => updateValue(event.target.value)}
        />
        <input
          aria-label={`${label}滑条`}
          type="range"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(event) => updateValue(event.target.value)}
        />
      </div>
    </label>
  );
}

function SegmentedControl<TValue extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: TValue;
  options: { label: string; value: TValue }[];
  onChange: (value: TValue) => void;
}) {
  return (
    <div className="cm-editor-field">
      <span>{label}</span>
      <div className="cm-editor-segmented" role="group" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function toColorInputValue(value: string) {
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed;
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`;
  }
  const match = trimmed.match(/^rgba?\(([^)]+)\)$/i);
  if (!match) return '#2c1810';
  const channels = match[1].split(',').map((part) => Number(part.trim()));
  if (channels.length < 3 || channels.some((channel, index) => index < 3 && !Number.isFinite(channel))) {
    return '#2c1810';
  }
  return `#${channels
    .slice(0, 3)
    .map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0'))
    .join('')}`;
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="cm-editor-field cm-editor-color-field">
      <span>{label}</span>
      <div className="cm-editor-color-row">
        <span className="cm-editor-color-swatch" aria-hidden="true" style={{ background: value }} />
        <input aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} />
        <input
          aria-label={`${label}色板`}
          type="color"
          value={toColorInputValue(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
      <RgbaStringColorPicker color={value} onChange={onChange} />
    </label>
  );
}

function GeometryInputs({ element }: { element: TextElement | ImageElement }) {
  const updateElement = useEditorStore((state) => state.updateElement);
  const isImage = element.type === 'image';
  const showWidth = isImage || element.direction === 'horizontal';
  const showHeight = isImage || element.direction === 'vertical';

  return (
    <div className="cm-editor-geometry">
      <NumberInput label="X" value={element.x} onChange={(value) => updateElement(element.id, { x: value })} />
      <NumberInput label="Y" value={element.y} onChange={(value) => updateElement(element.id, { y: value })} />
      {showWidth ? (
        <NumberInput
          label="宽度"
          value={element.width}
          min={1}
          onChange={(value) => updateElement(element.id, { width: value } as Partial<TextElement>)}
        />
      ) : null}
      {showHeight ? (
        <NumberInput
          label="高度"
          value={element.height}
          min={1}
          onChange={(value) => updateElement(element.id, { height: value } as Partial<TextElement>)}
        />
      ) : null}
    </div>
  );
}

function TextProperties({ element }: { element: TextElement }) {
  const updateElement = useEditorStore((state) => state.updateElement);
  return (
    <>
      <GeometryInputs element={element} />
      <SegmentedControl
        label="排版方向"
        value={element.direction}
        options={[
          { label: '横排', value: 'horizontal' },
          { label: '竖排', value: 'vertical' },
        ]}
        onChange={(value) => updateElement(element.id, { direction: value })}
      />
      <SegmentedControl
        label={element.direction === 'vertical' ? '\u6a2a\u5411\u5bf9\u9f50' : '\u7eb5\u5411\u5bf9\u9f50'}
        value={element.blockAlign ?? 'start'}
        options={
          element.direction === 'vertical'
            ? [
                { label: '\u53f3\u5bf9\u9f50', value: 'start' },
                { label: '\u5de6\u5bf9\u9f50', value: 'end' },
              ]
            : [
                { label: '\u4e0a\u5bf9\u9f50', value: 'start' },
                { label: '\u4e0b\u5bf9\u9f50', value: 'end' },
              ]
        }
        onChange={(value) => updateElement(element.id, { blockAlign: value })}
      />
      {element.direction === 'horizontal' ? (
        <SegmentedControl
          label="文字对齐"
          value={element.textAlign ?? 'left'}
          options={[
            { label: '左对齐', value: 'left' },
            { label: '居中', value: 'center' },
            { label: '右对齐', value: 'right' },
          ]}
          onChange={(value) => updateElement(element.id, { textAlign: value })}
        />
      ) : null}
      <SliderNumberInput
        label="字号"
        value={element.fontSize}
        min={8}
        max={72}
        onChange={(value) => updateElement(element.id, { fontSize: value })}
      />
      <ColorField label="颜色" value={element.color} onChange={(color) => updateElement(element.id, { color })} />
      <SliderNumberInput
        label="字间距"
        value={element.letterSpacing ?? 0}
        min={-2}
        max={20}
        onChange={(value) => updateElement(element.id, { letterSpacing: value })}
      />
      <SliderNumberInput
        label="行间距"
        value={element.lineHeight ?? 1.6}
        min={1}
        max={3}
        step={0.05}
        onChange={(value) => updateElement(element.id, { lineHeight: value })}
      />
      <SliderNumberInput
        label={element.direction === 'vertical' ? '最大列数' : '最大行数'}
        value={element.maxLines}
        min={1}
        max={8}
        onChange={(value) => updateElement(element.id, { maxLines: value })}
      />
      <SegmentedControl
        label="字重"
        value={element.fontWeight ?? 'normal'}
        options={[
          { label: 'normal', value: 'normal' },
          { label: 'bold', value: 'bold' },
        ]}
        onChange={(value) => updateElement(element.id, { fontWeight: value })}
      />
    </>
  );
}

function ImageProperties({ element }: { element: ImageElement }) {
  const updateElement = useEditorStore((state) => state.updateElement);
  const setStaticImage = (value: string) => {
    updateElement(element.id, { source: 'static', staticUrl: value } as Partial<ImageElement>);
  };

  return (
    <>
      <GeometryInputs element={element} />
      <SegmentedControl
        label="图片来源"
        value={element.source}
        options={[
          { label: '文章首图', value: 'dynamic' },
          { label: '固定图片', value: 'static' },
        ]}
        onChange={(value) => updateElement(element.id, { source: value } as Partial<ImageElement>)}
      />
      <label className="cm-editor-field">
        <span>图片 URL</span>
        <input
          aria-label="图片 URL"
          value={element.staticUrl ?? ''}
          placeholder={element.source === 'dynamic' ? '切到固定图片后可填写' : '粘贴图片地址或 data URL'}
          onChange={(event) => setStaticImage(event.target.value)}
        />
      </label>
      <label className="cm-editor-field">
        <span>生成提示词</span>
        <textarea
          aria-label="生成提示词"
          value={element.prompt ?? ''}
          placeholder="记录这张图片的生成提示词"
          rows={5}
          onChange={(event) => updateElement(element.id, { prompt: event.target.value } as Partial<ImageElement>)}
        />
      </label>
      <label className="cm-editor-field">
        <span>图片位置</span>
        <input
          aria-label="图片位置"
          value={element.objectPosition ?? '50% 50%'}
          onChange={(event) => updateElement(element.id, { objectPosition: event.target.value } as Partial<ImageElement>)}
        />
      </label>
      <SliderNumberInput
        label="透明度"
        value={element.opacity ?? 1}
        min={0}
        max={1}
        step={0.05}
        onChange={(value) => updateElement(element.id, { opacity: value } as Partial<ImageElement>)}
      />
      <label className="cm-editor-field">
        <span>上传图片</span>
        <input
          aria-label="上传图片"
          type="file"
          accept="image/*"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => setStaticImage(String(reader.result ?? ''));
            reader.readAsDataURL(file);
          }}
        />
      </label>
      <SegmentedControl
        label="形状"
        value={element.shape}
        options={[
          { label: '矩形', value: 'rectangle' },
          { label: '梯形', value: 'trapezoid' },
        ]}
        onChange={(value) => updateElement(element.id, { shape: value } as Partial<ImageElement>)}
      />
      <SegmentedControl
        label="裁剪方式"
        value={element.objectFit ?? 'cover'}
        options={[
          { label: 'cover', value: 'cover' },
          { label: 'contain', value: 'contain' },
        ]}
        onChange={(value) => updateElement(element.id, { objectFit: value } as Partial<ImageElement>)}
      />
      {element.shape === 'trapezoid' ? (
        <label className="cm-editor-field">
          <span>clip-path</span>
          <input
            aria-label="clip-path"
            value={element.clipPath ?? ''}
            onChange={(event) => updateElement(element.id, { clipPath: event.target.value } as Partial<ImageElement>)}
          />
        </label>
      ) : null}
    </>
  );
}

function LineProperties({ element }: { element: LineElement }) {
  const updateElement = useEditorStore((state) => state.updateElement);
  return (
    <>
      <NumberInput label="X" value={element.x} onChange={(value) => updateElement(element.id, { x: value })} />
      <NumberInput label="Y" value={element.y} onChange={(value) => updateElement(element.id, { y: value })} />
      <SegmentedControl
        label="方向"
        value={element.direction}
        options={[
          { label: '横线', value: 'horizontal' },
          { label: '竖线', value: 'vertical' },
        ]}
        onChange={(value) => updateElement(element.id, { direction: value } as Partial<LineElement>)}
      />
      <SliderNumberInput
        label="长度"
        value={element.length}
        min={24}
        max={360}
        onChange={(value) => updateElement(element.id, { length: value } as Partial<LineElement>)}
      />
      <SliderNumberInput
        label="粗细"
        value={element.thickness}
        min={0.5}
        max={8}
        step={0.5}
        onChange={(value) => updateElement(element.id, { thickness: value } as Partial<LineElement>)}
      />
      <ColorField
        label="线条颜色"
        value={element.color}
        onChange={(color) => updateElement(element.id, { color } as Partial<LineElement>)}
      />
    </>
  );
}

function formatCapacityDetail(capacity: TextCapacityInfo) {
  if (capacity.direction === 'vertical') {
    return `竖排 · 最多 ${capacity.maxCharacters} 字 · ${capacity.charactersPerColumn} 字/列 × ${capacity.columnCount} 列`;
  }
  return `横排 · 最多 ${capacity.maxCharacters} 字 · ${capacity.charactersPerLine} 字/行 × ${capacity.lineCount} 行`;
}

function CapacityRow({ label, capacity }: { label: string; capacity?: TextCapacityInfo }) {
  return (
    <div className="cm-editor-capacity-row">
      <span className="cm-editor-capacity-label">{label}</span>
      <span className="cm-editor-capacity-value">
        {capacity ? formatCapacityDetail(capacity) : '未启用'}
      </span>
    </div>
  );
}

function CapacitySummary({ capacity }: { capacity: TemplateTextCapacity }) {
  return (
    <section className="cm-editor-capacity" aria-label="容量参数">
      <div className="cm-editor-section-title">容量参数</div>
      <CapacityRow label="标题" capacity={capacity.title} />
      <CapacityRow label="摘要" capacity={capacity.description} />
    </section>
  );
}

export function PropertiesPanel() {
  const template = useEditorStore((state) => state.template);
  const selectedId = useEditorStore((state) => state.selectedId);
  const selected = template.elements.find((element) => element.id === selectedId);
  const textCapacity = calculateTemplateTextCapacity(template);

  return (
    <aside className="cm-editor-right" aria-label="属性面板">
      <h3>属性面板</h3>
      <CapacitySummary capacity={textCapacity} />
      {!selected ? <p className="cm-editor-muted">请选择画布元素。</p> : null}
      {selected ? <div className="cm-editor-selected-name">{selected.id}</div> : null}
      {selected?.type === 'text' ? <TextProperties element={selected} /> : null}
      {selected?.type === 'image' ? <ImageProperties element={selected} /> : null}
      {selected?.type === 'line' ? <LineProperties element={selected} /> : null}
    </aside>
  );
}
