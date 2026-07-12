import {
  CARD_WIDTH,
  DEFAULT_COLOR_CONFIG,
  DEFAULT_COLUMN_GUTTER,
} from '../constants';
import type { MasonryColorConfig, TemplateDefinition } from '../templates/types';

export interface MasonryMetrics {
  columns: number;
  gridWidth: number;
  sidePadding: number;
}

export function calculateMasonryMetrics(
  containerWidth: number,
  columnGutter = DEFAULT_COLUMN_GUTTER,
  minColumns = 3,
): MasonryMetrics {
  const naturalColumns = Math.floor((containerWidth + columnGutter) / (CARD_WIDTH + columnGutter));
  const columns = Math.max(minColumns, naturalColumns);
  const gridWidth = CARD_WIDTH * columns + columnGutter * Math.max(0, columns - 1);
  const sidePadding = Math.max(0, Math.floor((containerWidth - gridWidth) / 2));
  return { columns, gridWidth, sidePadding };
}

export function isPureChineseText(value: string): boolean {
  const normalized = value.replace(/[\s《》「」『』，。！？、；：“”‘’（）()【】\-—·.]/g, '');
  return normalized.length > 0 && /^[\u3400-\u9fff]+$/.test(normalized);
}

export function normalizeColorConfig(config?: Partial<MasonryColorConfig>): Required<MasonryColorConfig> {
  return {
    ...DEFAULT_COLOR_CONFIG,
    ...config,
    enabled: config?.enabled ?? DEFAULT_COLOR_CONFIG.enabled,
  };
}

export function cloneTemplate(template: TemplateDefinition): TemplateDefinition {
  return JSON.parse(JSON.stringify(template)) as TemplateDefinition;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function snapToGrid(value: number, grid = 4): number {
  return Math.round(value / grid) * grid;
}
