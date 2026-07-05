import { describe, expect, it } from 'vitest';
import { calculateTemplateTextCapacity } from '../capacity';
import { defaultTemplates } from '.';
import type { ImageElement } from '../types';

const isImageElement = (element: unknown): element is ImageElement =>
  typeof element === 'object' && element !== null && 'type' in element && element.type === 'image';

describe('curated default templates', () => {
  it('uses the curated ink background template set', () => {
    expect(defaultTemplates).toHaveLength(64);
    expect(new Set(defaultTemplates.map((template) => template.id)).size).toBe(defaultTemplates.length);
    expect(defaultTemplates.every((template) => template.id.startsWith('curated-'))).toBe(true);
    expect(defaultTemplates.map((template) => template.name)).toEqual(
      expect.arrayContaining([
        '石桥烟水',
        '香炉清供',
        '檐铃听风',
        '丹鹤立雪',
        '橘猫弄球',
        '枯藤昏鸦',
        '柳岸扁舟',
        '月门竹影',
        '琴上疏梅',
        '青瓷水仙',
        '玉兰素笺',
        '瓦猫守檐',
        '雪梅横枝',
      ]),
    );
  });

  it('uses project-local curated backgrounds in every template', () => {
    const imageElements = defaultTemplates.flatMap((template) =>
      template.elements.filter((element): element is ImageElement => isImageElement(element) && element.role !== 'stamp'),
    );
    const staticUrls = new Set(imageElements.map((element) => element.staticUrl));

    expect(staticUrls.size).toBe(64);
    expect([...staticUrls].every((url) => url?.includes('curated-backgrounds'))).toBe(true);
    expect(imageElements.every((element) => element.prompt && element.prompt.length > 12)).toBe(true);
    expect(
      defaultTemplates.every((template) =>
        template.elements.some(
          (element) =>
            isImageElement(element) &&
            element.source === 'static' &&
            element.role !== 'stamp' &&
            element.staticUrl?.includes('curated-backgrounds'),
        ),
      ),
    ).toBe(true);
  });

  it('uses thin default lines and includes editable seal stamps', () => {
    const lineElements = defaultTemplates.flatMap((template) =>
      template.elements.filter((element) => element.type === 'line'),
    );
    const stampElements = defaultTemplates.flatMap((template) =>
      template.elements.filter((element): element is ImageElement => isImageElement(element) && element.role === 'stamp'),
    );

    expect(lineElements.every((element) => element.thickness === 0.5)).toBe(true);
    expect(stampElements).toHaveLength(33);
    expect(stampElements[0]).toMatchObject({
      width: 30,
      height: 30,
      prompt: expect.stringContaining('空生妙有'),
    });
  });

  it('stores calculated title and description text capacity for every template', () => {
    expect(
      defaultTemplates.every(
        (template) =>
          (!template.elements.some((element) => element.type === 'text' && element.role === 'title') ||
            template.meta.textCapacity?.title?.maxCharacters) &&
          (!template.elements.some((element) => element.type === 'text' && element.role === 'description') ||
            template.meta.textCapacity?.description?.maxCharacters),
      ),
    ).toBe(true);

    const horizontal = defaultTemplates.find((template) => template.id === 'curated-shanshui-blank');
    const vertical = defaultTemplates.find((template) => template.id === 'curated-cuiniao-vertical');
    if (!horizontal || !vertical) throw new Error('Missing capacity fixtures');

    expect(horizontal.meta.textCapacity?.title).toMatchObject({
      direction: 'horizontal',
      charactersPerLine: 5,
      lineCount: 2,
      maxCharacters: 10,
    });
    expect(horizontal.meta.textCapacity?.description).toMatchObject({
      direction: 'horizontal',
      charactersPerLine: 9,
      lineCount: 5,
      maxCharacters: 45,
    });
    expect(vertical.meta.textCapacity?.title).toMatchObject({
      direction: 'vertical',
      charactersPerColumn: 7,
      columnCount: 1,
      maxCharacters: 7,
    });
    expect(horizontal.meta.textCapacity).toEqual(calculateTemplateTextCapacity(horizontal));
    expect(horizontal.meta.maxTitleLength).toBe(horizontal.meta.textCapacity?.title?.maxCharacters);
  });

  it('keeps text editable and includes varied vertical and quote layouts', () => {
    const textElements = defaultTemplates.flatMap((template) =>
      template.elements.filter((element) => element.type === 'text'),
    );

    expect(defaultTemplates.some((template) => template.meta.preferVerticalText)).toBe(true);
    expect(textElements.some((element) => element.direction === 'vertical')).toBe(true);
    expect(textElements.some((element) => element.role === 'decoration' && element.content === '“')).toBe(true);
    expect(textElements.every((element) => element.maxLines >= 1)).toBe(true);
  });

  it('includes landscape, square and portrait background families', () => {
    const imageUrls = defaultTemplates
      .flatMap((template) => template.elements)
      .filter((element) => element.type === 'image')
      .map((element) => element.staticUrl ?? '');

    expect(imageUrls.some((url) => url.includes('wide-'))).toBe(true);
    expect(imageUrls.some((url) => url.includes('square-'))).toBe(true);
    expect(imageUrls.some((url) => url.includes('tall-'))).toBe(true);
  });
});
