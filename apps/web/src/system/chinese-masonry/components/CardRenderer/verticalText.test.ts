import { describe, expect, it } from 'vitest';
import type { TextElement } from '../../templates/types';
import { getHorizontalTextLayout, getVerticalTextLayout } from './verticalText';

const element: TextElement = {
  id: 'desc',
  type: 'text',
  role: 'description',
  x: 88,
  y: 48,
  width: 64,
  height: 196,
  fontSize: 14,
  color: '#222',
  direction: 'vertical',
  letterSpacing: 2,
  lineHeight: 1.92,
  maxLines: 7,
};

describe('getVerticalTextLayout', () => {
  it('derives horizontal text height from max lines instead of stored height', () => {
    const layout = getHorizontalTextLayout({
      ...element,
      direction: 'horizontal',
      width: 128,
      height: 64,
      fontSize: 14,
      lineHeight: 1.78,
      maxLines: 3,
    });

    expect(layout.height).toBe(75);
  });

  it('uses font size and letter spacing for vertical character advance', () => {
    const layout = getVerticalTextLayout('春江潮水连海平，海上明月共潮生。滟滟随波千万里，何处春江无月明。', element, 1.92);

    expect(layout.text).not.toMatch(/…$/);
    expect(layout.width).toBe(182);
    expect(layout.xOffset).toBe(-118);
    expect(layout.writingMode).toBe('vertical-rl');
  });

  it('uses vertical-lr when vertical text is horizontally left aligned', () => {
    const layout = getVerticalTextLayout('春江潮水连海平，海上明月共潮生。', {
      ...element,
      blockAlign: 'end',
      maxLines: 2,
    }, 1.92);

    expect(layout.xOffset).toBe(0);
    expect(layout.writingMode).toBe('vertical-lr');
  });

  it('truncates by max columns and keeps the box width tied to configured columns', () => {
    const layout = getVerticalTextLayout('一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十', {
      ...element,
      height: 40,
      fontSize: 16,
      letterSpacing: 0,
      lineHeight: 1.5,
      maxLines: 2,
    }, 1.5);

    expect(layout.text).toMatch(/…$/);
    expect(layout.width).toBe(44);
  });

  it('按字素截断 emoji、扩展汉字与组合附加符，并让省略号占一个槽位', () => {
    const unicodeElement = {
      ...element,
      height: 48,
      fontSize: 16,
      letterSpacing: 0,
      maxLines: 2,
    };

    expect(getVerticalTextLayout('甲𠮷👨‍👩‍👧‍👦e\u0301乙丙丁', unicodeElement, 1.5).text)
      .toBe('甲𠮷👨‍👩‍👧‍👦e\u0301乙…');
  });
});
