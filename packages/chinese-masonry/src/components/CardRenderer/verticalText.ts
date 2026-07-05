import type { TextElement } from '../../templates/types';

export interface VerticalTextLayout {
  text: string;
  width: number;
  xOffset: number;
  writingMode: 'vertical-rl' | 'vertical-lr';
}

export interface HorizontalTextLayout {
  height: number;
}

export function getHorizontalTextLayout(element: TextElement): HorizontalTextLayout {
  const lineHeight = element.lineHeight ?? 1.6;
  return {
    height: Math.ceil(element.fontSize * lineHeight * Math.max(1, element.maxLines)),
  };
}

export function getVerticalTextLayout(text: string, element: TextElement, lineHeight: number): VerticalTextLayout {
  const letterSpacing = element.letterSpacing ?? 0;
  const charAdvance = Math.max(1, element.fontSize + letterSpacing);
  const charsPerColumn = Math.max(1, Math.floor(element.height / charAdvance));
  const maxColumns = Math.max(1, element.maxLines);
  const maxChars = charsPerColumn * maxColumns;
  const truncated = text.length > maxChars ? `${text.slice(0, Math.max(1, maxChars - 1))}…` : text;
  const columnAdvance = Math.max(element.fontSize, element.fontSize * lineHeight);
  const sideBearing = Math.max(0, (columnAdvance - element.fontSize) / 2);
  const width = Math.ceil(element.fontSize + (maxColumns - 1) * columnAdvance + sideBearing);

  return {
    text: truncated,
    width,
    xOffset: element.blockAlign === 'end' ? 0 : element.width - width,
    writingMode: element.blockAlign === 'end' ? 'vertical-lr' : 'vertical-rl',
  };
}
